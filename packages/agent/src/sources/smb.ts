import { createRequire } from "node:module";
import type { FileNode, Source } from "./types.js";

export interface SmbSourceConfig {
  host: string;
  share: string;
  /** Subfolder within the share to treat as the watch root, e.g. "finance/exports". */
  subPath?: string;
  username: string;
  password: string;
  domain?: string;
  port?: number;
}

// Using v9u-smb2 rather than the more well-known @marsaud/smb2 it forks:
// @marsaud/smb2 bundles the `ntlm` package, which only ever speaks NTLMv1
// (confirmed by reading its source — no HMAC-MD5/NTLMv2 code path at all)
// and reliably fails STATUS_LOGON_FAILURE against a modern Samba/Windows
// server even with NTLMv1 explicitly permitted server-side. v9u-smb2 is the
// same client with that swapped for `ntlm2`, which does implement NTLMv2.
// Both still hash the legacy LM response via DES-ECB, which OpenSSL 3's
// default provider rejects, so the agent process needs
// NODE_OPTIONS=--openssl-legacy-provider when SOURCE_TYPE=smb (documented
// in ARCHITECTURE.md/README.md).
//
// Separately, this library's shipped index.d.ts doesn't resolve cleanly as
// a default export under this project's `moduleResolution: NodeNext`, and
// omits `size` from readdir(..., {stats:true})/stat() results even though
// the underlying implementation always sets it. Rather than fight either
// issue, this loads the package via createRequire and declares only the
// surface actually used here, checked against the real implementation.
const require = createRequire(import.meta.url);

interface SmbFileStats {
  name: string;
  mtime: Date;
  size: number;
  isDirectory(): boolean;
}

interface Smb2Client {
  readdir(path: string, options: { stats: true }): Promise<SmbFileStats[]>;
  readFile(path: string): Promise<Buffer>;
  disconnect(): void;
}

interface Smb2Options {
  share: string;
  domain: string;
  username: string;
  password: string;
  port?: number;
}

const SMB2: new (options: Smb2Options) => Smb2Client = require("v9u-smb2");

function toSmbPath(relPath: string): string {
  return relPath.split("/").filter(Boolean).join("\\");
}

export class SmbSource implements Source {
  private client: Smb2Client;
  private rootSmbPath: string;

  constructor(private config: SmbSourceConfig) {
    this.client = new SMB2({
      share: `\\\\${config.host}\\${config.share}`,
      domain: config.domain ?? "",
      username: config.username,
      password: config.password,
      port: config.port,
    });
    this.rootSmbPath = config.subPath ? toSmbPath(config.subPath) : "";
  }

  describe(): string {
    const sub = this.config.subPath ? `/${this.config.subPath.replace(/^\/+/, "")}` : "";
    return `smb://${this.config.host}/${this.config.share}${sub}`;
  }

  async listTree(): Promise<FileNode[]> {
    const nodes: FileNode[] = [];
    await this.walk(this.rootSmbPath, "", nodes);
    return nodes;
  }

  private async walk(smbDir: string, relDir: string, out: FileNode[]): Promise<void> {
    const entries = await this.client.readdir(smbDir, { stats: true });
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const smbPath = smbDir ? `${smbDir}\\${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await this.walk(smbPath, relPath, out);
      } else {
        out.push({ path: relPath, sizeBytes: entry.size, mtimeMs: entry.mtime.getTime() });
      }
    }
  }

  async readSample(relPath: string, maxBytes: number): Promise<Buffer | undefined> {
    try {
      const buf = await this.client.readFile(toSmbPath(relPath));
      return buf.subarray(0, maxBytes);
    } catch {
      return undefined; // file may have been deleted/moved between the scan and this read
    }
  }

  disconnect(): void {
    this.client.disconnect();
  }
}
