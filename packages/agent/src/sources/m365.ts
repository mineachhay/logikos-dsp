import type { FileNode, Source } from "./types.js";

export interface M365SourceConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The drive (OneDrive or SharePoint document library) to watch. */
  driveId: string;
  /** Subfolder within the drive to treat as the watch root, e.g. "Shared/Finance". */
  subPath?: string;
}

// NOTE: this connector has not been verified against a real Microsoft 365
// tenant — no Azure AD credentials were available while building it (see
// ARCHITECTURE.md). Every endpoint/shape below is taken directly from
// Microsoft's current Graph API documentation, not empirically confirmed.
// Treat the first real run against a live tenant as the actual verification
// step, and watch its logs closely.

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface GraphTokenResponse {
  access_token: string;
  expires_in: number;
}

interface GraphDriveItem {
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: unknown;
  folder?: unknown;
}

interface GraphChildrenResponse {
  value?: GraphDriveItem[];
  "@odata.nextLink"?: string;
}

export interface ParsedChildrenPage {
  files: FileNode[];
  /** Names only (not full paths) — the caller already knows the parent path. */
  folderNames: string[];
  nextLink: string | null;
}

/**
 * Pure — no network. Split out from the fetch/recursion loop specifically
 * so it's directly unit-testable against fixture JSON copied from
 * Microsoft's documented example responses, without a live tenant.
 */
export function parseChildrenPage(json: unknown, relDir: string): ParsedChildrenPage {
  const body = json as GraphChildrenResponse;
  const files: FileNode[] = [];
  const folderNames: string[] = [];

  for (const item of body.value ?? []) {
    if (item.folder) {
      folderNames.push(item.name);
      continue;
    }
    if (!item.file) continue; // package/other facets, not a plain file
    files.push({
      path: relDir ? `${relDir}/${item.name}` : item.name,
      sizeBytes: item.size ?? 0,
      mtimeMs: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime).getTime() : 0,
    });
  }

  return { files, folderNames, nextLink: body["@odata.nextLink"] ?? null };
}

function encodeGraphPath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

export class M365Source implements Source {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private config: M365SourceConfig) {}

  describe(): string {
    const sub = this.config.subPath ? `/${this.config.subPath.replace(/^\/+/, "")}` : "";
    return `m365://${this.config.driveId}${sub}`;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    const res = await fetch(`https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    });
    if (!res.ok) {
      throw new Error(`M365 token request failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as GraphTokenResponse;
    this.accessToken = body.access_token;
    this.tokenExpiresAt = Date.now() + body.expires_in * 1000;
    return this.accessToken;
  }

  private childrenUrl(fullPath: string): string {
    const tail = fullPath ? `root:/${encodeGraphPath(fullPath)}:/children` : "root/children";
    return `${GRAPH_BASE}/drives/${this.config.driveId}/${tail}`;
  }

  async listTree(): Promise<FileNode[]> {
    const nodes: FileNode[] = [];
    await this.walk(this.config.subPath ?? "", "", nodes);
    return nodes;
  }

  // fullPath: path from the drive root (subPath + relDir) — used for the Graph API call.
  // relDir: path relative to *our* configured root — used for FileNode.path and recursion.
  private async walk(fullPath: string, relDir: string, out: FileNode[]): Promise<void> {
    let url: string | null = this.childrenUrl(fullPath);
    const folderNames: string[] = [];

    while (url) {
      const token = await this.getAccessToken();
      const res: Response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) {
        throw new Error(`M365 list children failed: ${res.status} ${await res.text()}`);
      }
      const page = parseChildrenPage(await res.json(), relDir);
      out.push(...page.files);
      folderNames.push(...page.folderNames);
      url = page.nextLink;
    }

    for (const name of folderNames) {
      const childRelDir = relDir ? `${relDir}/${name}` : name;
      const childFullPath = fullPath ? `${fullPath}/${name}` : name;
      await this.walk(childFullPath, childRelDir, out);
    }
  }

  async readSample(relPath: string, maxBytes: number): Promise<Buffer | undefined> {
    try {
      const fullPath = this.config.subPath ? `${this.config.subPath}/${relPath}` : relPath;
      const token = await this.getAccessToken();
      const res = await fetch(`${GRAPH_BASE}/drives/${this.config.driveId}/root:/${encodeGraphPath(fullPath)}:/content`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return undefined;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.subarray(0, maxBytes);
    } catch {
      return undefined; // file may have been deleted/moved between the scan and this read
    }
  }
}
