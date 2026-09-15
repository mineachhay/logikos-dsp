import type {
  BackupDestinationType,
  GdriveCredentials,
  GdriveDestinationConfig,
  S3Credentials,
  S3DestinationConfig,
  SftpCredentials,
  SftpDestinationConfig,
} from "@logikos-dsp/shared";

/**
 * Pure: turns stored destination settings into an rclone config file. One
 * tool behind all three destination types is the point — a new type is a new
 * case here, not a new upload implementation.
 *
 * The file is written to a private temp dir for one run and deleted after
 * (steps.ts); secrets never go on rclone's command line, where `ps` would
 * show them.
 */

export const REMOTE_NAME = "dest";

export interface DestinationInput {
  type: BackupDestinationType;
  config: unknown;
  credentials: Record<string, string | undefined>;
  remotePath: string;
}

export interface RcloneSetup {
  configText: string;
  /** Extra files the config refers to (known_hosts), relative to the config's directory. */
  files: Record<string, string>;
  /** e.g. "dest:bucket/logikos-dsp" — where bundles go. */
  remoteDir: string;
}

// rclone's config is INI: a newline inside a value would start a new key.
function value(v: string | number): string {
  const s = String(v);
  if (/[\r\n]/.test(s)) throw new Error("destination setting contains a line break");
  return s;
}

function section(entries: Record<string, string | number | undefined>): string {
  const lines = [`[${REMOTE_NAME}]`];
  for (const [k, v] of Object.entries(entries)) {
    if (v !== undefined && v !== "") lines.push(`${k} = ${value(v)}`);
  }
  return lines.join("\n") + "\n";
}

function relative(path: string): string {
  return path.replace(/^\/+/, "");
}

// rclone's own provider names; B2 through its S3 API is plain "Other".
const S3_PROVIDER: Record<S3DestinationConfig["provider"], string> = {
  AWS: "AWS",
  Cloudflare: "Cloudflare",
  Backblaze: "Other",
  Wasabi: "Wasabi",
  Minio: "Minio",
  Other: "Other",
};

/**
 * SSH negotiates one host key type, and a known_hosts file that has a key for
 * the host but not of the negotiated type is reported as a *mismatch*. So
 * when keys are pinned, only offer the types that were pinned — found by
 * testing with an ed25519-only line against a server whose preferred key is a
 * different type.
 */
export function hostKeyAlgorithms(knownHosts: string): string[] {
  const types = new Set<string>();
  for (const line of knownHosts.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || line.trim().startsWith("#")) continue;
    // "[@marker] hosts keytype key [comment]"
    const keyType = fields[0].startsWith("@") ? fields[2] : fields[1];
    if (keyType === "ssh-rsa") ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"].forEach((t) => types.add(t));
    else if (keyType) types.add(keyType);
  }
  return [...types];
}

/** `obscuredPassword` is `rclone obscure`'s output for an SFTP password (rclone refuses plain ones). */
export function buildRcloneSetup(input: DestinationInput, obscuredPassword?: string): RcloneSetup {
  switch (input.type) {
    case "S3": {
      const c = input.config as S3DestinationConfig;
      const creds = input.credentials as unknown as S3Credentials;
      const prefix = relative(input.remotePath);
      return {
        configText: section({
          type: "s3",
          provider: S3_PROVIDER[c.provider],
          env_auth: "false",
          access_key_id: c.accessKeyId,
          secret_access_key: creds.secretAccessKey,
          endpoint: c.endpoint,
          region: c.region || (c.provider === "Cloudflare" ? "auto" : undefined),
          // Don't try to create the bucket: scoped keys (R2 object tokens, B2
          // application keys) usually can't, and it should already exist.
          no_check_bucket: "true",
        }),
        files: {},
        remoteDir: `${REMOTE_NAME}:${c.bucket}${prefix ? `/${prefix}` : ""}`,
      };
    }
    case "SFTP": {
      const c = input.config as SftpDestinationConfig;
      const creds = input.credentials as unknown as SftpCredentials;
      const files: Record<string, string> = {};
      if (c.hostKey) files.known_hosts = c.hostKey.trim() + "\n";
      return {
        configText: section({
          type: "sftp",
          host: c.host,
          port: c.port,
          user: c.username,
          // A key wins if both are stored (e.g. switched from password to key).
          key_pem: creds.privateKey ? creds.privateKey.trim().replace(/\r?\n/g, "\\n") : undefined,
          pass: creds.privateKey ? undefined : obscuredPassword,
          known_hosts_file: c.hostKey ? "known_hosts" : undefined,
          host_key_algorithms: c.hostKey ? hostKeyAlgorithms(c.hostKey).join(" ") || undefined : undefined,
        }),
        files,
        // An SFTP path may be absolute (/srv/backups) or relative to the login directory.
        remoteDir: `${REMOTE_NAME}:${input.remotePath}`,
      };
    }
    case "GDRIVE": {
      const c = input.config as GdriveDestinationConfig;
      const creds = input.credentials as unknown as GdriveCredentials;
      const compact = (json: string | undefined) => (json ? JSON.stringify(JSON.parse(json)) : undefined);
      return {
        configText: section({
          type: "drive",
          scope: "drive",
          service_account_credentials: c.authMode === "SERVICE_ACCOUNT" ? compact(creds.serviceAccountJson) : undefined,
          token: c.authMode === "OAUTH_TOKEN" ? compact(creds.oauthTokenJson) : undefined,
          root_folder_id: c.rootFolderId,
          team_drive: c.sharedDriveId,
        }),
        files: {},
        remoteDir: `${REMOTE_NAME}:${relative(input.remotePath)}`,
      };
    }
  }
}

/** Resolves config-relative file references to the temp dir actually used. */
export function withConfigDir(setup: RcloneSetup, dir: string): string {
  return setup.configText.replace(/^known_hosts_file = known_hosts$/m, `known_hosts_file = ${dir}/known_hosts`);
}
