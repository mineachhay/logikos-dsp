import { createSign } from "node:crypto";
import type { FileNode, Source } from "./types.js";

export interface GoogleDriveSourceConfig {
  /** Service account `client_email`, from the downloaded JSON key file. */
  clientEmail: string;
  /** Service account `private_key` (PEM), from the downloaded JSON key file. */
  privateKey: string;
  /**
   * The folder to watch — must be shared with `clientEmail` first, the same
   * way you'd share it with any other Google user (My Drive folder, or a
   * folder inside a Shared Drive). No Workspace domain-wide delegation
   * needed, unlike some service-account setups — this is the simplest auth
   * shape that works for both a personal Drive and a Workspace one.
   */
  folderId: string;
}

// NOTE: this connector has not been verified against a real Google account —
// no service-account credentials were available while building it, same
// situation as the M365 connector (see ARCHITECTURE.md). Every endpoint,
// field name, and auth-flow detail below is taken directly from Google's
// current Drive API v3 and OAuth 2.0 service-account documentation, not
// empirically confirmed. Treat the first real run as the actual
// verification step, and watch its logs closely.

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FOLDER_MIME = "application/vnd.google-apps.folder";
// Google's native Docs/Sheets/Slides/etc. have no binary representation —
// `alt=media` 403s on them ("Use Export with Docs Editors files"). Detecting
// each native type and calling files.export with the right target mimeType
// is real added complexity for a case that isn't the common one being
// protected against (structured PII tends to live in real files, not
// live-edited Docs) — skipped for v1, same category of tradeoff as the M365
// connector's decision not to use Graph's /delta API.
const GOOGLE_APPS_MIME_PREFIX = "application/vnd.google-apps.";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  // Drive API v3 returns `size` as a numeric *string*, not a number — files
  // can in principle exceed Number's safe integer range. Confirmed against
  // the File resource reference, not just assumed from convention.
  size?: string;
  modifiedTime?: string;
}

interface DriveFilesListResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

export interface ParsedFilesPage {
  files: (FileNode & { id: string })[];
  folders: { id: string; name: string }[];
  nextPageToken: string | null;
}

/**
 * Pure — no network. Mirrors m365.ts's `parseChildrenPage`: split out
 * specifically so it's unit-testable against fixture JSON shaped like
 * Google's documented Files resource, without a live account. Unlike
 * Graph's per-item `file`/`folder` facets, Drive marks folders with a
 * dedicated `mimeType`. Each file carries its Drive `id` alongside the
 * usual `FileNode` fields — `readSample()` needs it later (Drive addresses
 * content by id, not path) and this is the one place that already knows
 * which raw items were kept as files, so the caller doesn't have to
 * re-derive that filter itself.
 */
export function parseFilesPage(json: unknown, relDir: string): ParsedFilesPage {
  const body = json as DriveFilesListResponse;
  const files: (FileNode & { id: string })[] = [];
  const folders: { id: string; name: string }[] = [];

  for (const item of body.files ?? []) {
    if (item.mimeType === FOLDER_MIME) {
      folders.push({ id: item.id, name: item.name });
      continue;
    }
    if (item.mimeType.startsWith(GOOGLE_APPS_MIME_PREFIX)) continue; // native Docs/Sheets/etc — no binary content to sample
    files.push({
      id: item.id,
      path: relDir ? `${relDir}/${item.name}` : item.name,
      sizeBytes: item.size ? Number(item.size) : 0,
      mtimeMs: item.modifiedTime ? new Date(item.modifiedTime).getTime() : 0,
    });
  }

  return { files, folders, nextPageToken: body.nextPageToken ?? null };
}

export class GoogleDriveSource implements Source {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  // Drive addresses everything by opaque file ID, not by path — readSample()
  // is called later in the same scan cycle (see snapshotDiff.ts) with only a
  // relative path, so listTree() records the id it saw for every path here.
  private fileIdsByPath = new Map<string, string>();

  constructor(private config: GoogleDriveSourceConfig) {}

  describe(): string {
    return `gdrive://${this.config.folderId}`;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    // Service-account JWT Bearer flow (RFC 7523) — Google's documented
    // alternative to a full OAuth SDK for a single, non-interactive
    // identity. One signed assertion, one token POST, same "plain fetch,
    // not a new dependency" call the M365 connector made for its own
    // client-credentials grant.
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(
      JSON.stringify({
        iss: this.config.clientEmail,
        scope: "https://www.googleapis.com/auth/drive.readonly",
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }),
    );
    const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(this.config.privateKey, "base64url");
    const assertion = `${header}.${claims}.${signature}`;

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!res.ok) {
      throw new Error(`Google Drive token request failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = body.access_token;
    this.tokenExpiresAt = Date.now() + body.expires_in * 1000;
    return this.accessToken;
  }

  async listTree(): Promise<FileNode[]> {
    this.fileIdsByPath.clear();
    const nodes: FileNode[] = [];
    await this.walk(this.config.folderId, "", nodes);
    return nodes;
  }

  private async walk(folderId: string, relDir: string, out: FileNode[]): Promise<void> {
    let pageToken: string | null = null;
    const folders: { id: string; name: string }[] = [];

    do {
      const token = await this.getAccessToken();
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "files(id,name,mimeType,size,modifiedTime),nextPageToken",
        pageSize: "1000",
        // Harmless no-op when folderId lives in a plain shared folder rather
        // than an actual Shared Drive — always including both means one code
        // path covers a personal-Drive share and a Shared Drive alike.
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);

      const res = await fetch(`${DRIVE_BASE}/files?${params}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error(`Google Drive list files failed: ${res.status} ${await res.text()}`);
      }
      const page = parseFilesPage(await res.json(), relDir);
      for (const file of page.files) {
        this.fileIdsByPath.set(file.path, file.id);
        out.push(file);
      }
      folders.push(...page.folders);
      pageToken = page.nextPageToken;
    } while (pageToken);

    for (const folder of folders) {
      const childRelDir = relDir ? `${relDir}/${folder.name}` : folder.name;
      await this.walk(folder.id, childRelDir, out);
    }
  }

  async readSample(relPath: string, maxBytes: number): Promise<Buffer | undefined> {
    const fileId = this.fileIdsByPath.get(relPath);
    if (!fileId) return undefined; // file may have been deleted/moved between the scan and this read
    try {
      const token = await this.getAccessToken();
      const res = await fetch(`${DRIVE_BASE}/files/${fileId}?alt=media&supportsAllDrives=true`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return undefined;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.subarray(0, maxBytes);
    } catch {
      return undefined;
    }
  }
}
