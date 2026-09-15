import { describe, expect, it } from "vitest";
import { describeRcloneError, evaluateRestore, pgEnvFromUrl } from "./pure.js";
import { buildRcloneSetup, hostKeyAlgorithms, withConfigDir } from "./rcloneConfig.js";

describe("buildRcloneSetup", () => {
  it("builds an S3 remote without trying to create the bucket, and defaults R2's region", () => {
    const setup = buildRcloneSetup({
      type: "S3",
      config: { provider: "Cloudflare", endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "dsp", accessKeyId: "AK" },
      credentials: { secretAccessKey: "SK" },
      remotePath: "/logikos-dsp/prod",
    });
    expect(setup.configText).toContain("type = s3");
    expect(setup.configText).toContain("provider = Cloudflare");
    expect(setup.configText).toContain("secret_access_key = SK");
    expect(setup.configText).toContain("region = auto");
    expect(setup.configText).toContain("no_check_bucket = true");
    expect(setup.remoteDir).toBe("dest:dsp/logikos-dsp/prod");
  });

  it("maps Backblaze's S3 API to rclone's generic provider", () => {
    const setup = buildRcloneSetup({
      type: "S3",
      config: { provider: "Backblaze", endpoint: "https://s3.us-west-004.backblazeb2.com", bucket: "b", accessKeyId: "k" },
      credentials: { secretAccessKey: "s" },
      remotePath: "",
    });
    expect(setup.configText).toContain("provider = Other");
    expect(setup.remoteDir).toBe("dest:b");
  });

  it("uses an SFTP key over a password, as one escaped line, with the host key pinned", () => {
    const setup = buildRcloneSetup(
      {
        type: "SFTP",
        config: { host: "backup.example.com", port: 2222, username: "dsp", hostKey: "backup.example.com ssh-ed25519 AAAA" },
        credentials: { password: "pw", privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n" },
        remotePath: "/srv/backups",
      },
      "OBSCURED",
    );
    expect(setup.configText).toContain("key_pem = -----BEGIN OPENSSH PRIVATE KEY-----\\nabc\\n-----END OPENSSH PRIVATE KEY-----");
    expect(setup.configText).not.toContain("pass = ");
    expect(setup.files.known_hosts).toBe("backup.example.com ssh-ed25519 AAAA\n");
    expect(setup.configText).toContain("host_key_algorithms = ssh-ed25519");
    expect(withConfigDir(setup, "/tmp/x")).toContain("known_hosts_file = /tmp/x/known_hosts");
    expect(setup.remoteDir).toBe("dest:/srv/backups");
  });

  it("uses the obscured password when there's no key", () => {
    const setup = buildRcloneSetup(
      { type: "SFTP", config: { host: "h", username: "u" }, credentials: { password: "pw" }, remotePath: "backups" },
      "OBSCURED",
    );
    expect(setup.configText).toContain("pass = OBSCURED");
    expect(setup.configText).not.toContain("pw\n");
  });

  it("builds a Drive remote for a service account on a Shared drive, JSON on one line", () => {
    const setup = buildRcloneSetup({
      type: "GDRIVE",
      config: { authMode: "SERVICE_ACCOUNT", sharedDriveId: "0ABC", rootFolderId: "1XYZ" },
      credentials: { serviceAccountJson: '{\n  "type": "service_account",\n  "private_key": "-----BEGIN-----\\nabc\\n"\n}' },
      remotePath: "/logikos-dsp",
    });
    expect(setup.configText).toContain('service_account_credentials = {"type":"service_account","private_key":"-----BEGIN-----\\nabc\\n"}');
    expect(setup.configText).toContain("team_drive = 0ABC");
    expect(setup.configText).not.toContain("token =");
    expect(setup.remoteDir).toBe("dest:logikos-dsp");
  });

  it("refuses a value that would inject another config line", () => {
    expect(() =>
      buildRcloneSetup({
        type: "S3",
        config: { provider: "Minio", endpoint: "http://m:9000", bucket: "b", accessKeyId: "AK\nendpoint = http://evil" },
        credentials: { secretAccessKey: "s" },
        remotePath: "",
      }),
    ).toThrow(/line break/);
  });
});

describe("pgEnvFromUrl", () => {
  it("splits a DATABASE_URL into libpq variables, decoding the password", () => {
    expect(pgEnvFromUrl("postgresql://logikos:p%40ss@postgres:5432/logikos_dsp")).toEqual({
      PGHOST: "postgres",
      PGPORT: "5432",
      PGUSER: "logikos",
      PGPASSWORD: "p@ss",
      PGDATABASE: "logikos_dsp",
    });
  });
});

describe("evaluateRestore", () => {
  it("passes when every table restored, even though live counts have moved on", () => {
    const r = evaluateRestore({ User: 2, FileEvent: 100 }, { User: 2, FileEvent: 140, _prisma_migrations: 9 });
    expect(r.ok).toBe(true);
  });

  it("fails on a missing table or an empty restore", () => {
    expect(evaluateRestore({ User: 2 }, { User: 2, FileEvent: 1 }).ok).toBe(false);
    expect(evaluateRestore({ User: 0, FileEvent: 0 }, { User: 2, FileEvent: 1 }).ok).toBe(false);
  });
});

describe("describeRcloneError", () => {
  it("collapses rclone's retry spam into one actionable line", () => {
    const raw = [1, 2, 3]
      .map((n) => `2026/09/15 01:51:27 ERROR : Attempt ${n}/3 failed with 1 errors and: operation error S3: HeadObject, https response error StatusCode: 403, RequestID: 18D55B8CD18A97D7, HostID: dd90, api error Forbidden: Forbidden`)
      .concat("2026/09/15 01:51:27 NOTICE: Failed to copyto: operation error S3: HeadObject, https response error StatusCode: 403, RequestID: X, HostID: Y, api error Forbidden: Forbidden")
      .join("\n");
    const msg = describeRcloneError(raw);
    expect(msg).toMatch(/^access denied — check the access key/);
    expect(msg).not.toContain("RequestID");
    expect(msg.match(/Forbidden/g)!.length).toBeLessThanOrEqual(2);
  });

  it("recognizes SFTP and Drive failures", () => {
    expect(describeRcloneError("ERROR : couldn't connect SSH: ssh: handshake failed: ssh: unable to authenticate, attempted methods [none password]")).toMatch(/^SFTP login failed/);
    expect(describeRcloneError("ssh: handshake failed: knownhosts: key mismatch")).toMatch(/host key doesn't match/);
    expect(describeRcloneError("googleapi: Error 403: Service Accounts do not have storage quota., storageQuotaExceeded")).toMatch(/use a Shared drive/);
    expect(describeRcloneError("dial tcp: lookup nas.local: no such host")).toMatch(/^can't reach the destination/);
    const drive = describeRcloneError(
      `NOTICE: Failed to rcat with 2 errors: last error was: couldn't list directory: Get "https://www.googleapis.com/drive/v3/files?alt=json&corpora=drive&${"x".repeat(900)}": private key should be a PEM or plain PKCS1 or PKCS8; parse error: asn1: syntax error`,
    );
    expect(drive).toMatch(/^Google Drive service account key is invalid/);
    expect(drive).toContain("private key should be a PEM");
    expect(drive).not.toContain("corpora=drive");
  });
});

describe("hostKeyAlgorithms", () => {
  it("offers only the pinned key types, expanding ssh-rsa to its SHA-2 signatures", () => {
    const scan = [
      "# backup.example.com:22 SSH-2.0-OpenSSH_9.9",
      "backup.example.com ssh-rsa AAAAB3",
      "backup.example.com ecdsa-sha2-nistp256 AAAAE2",
      "[backup.example.com]:2222 ssh-ed25519 AAAAC3",
    ].join("\n");
    expect(hostKeyAlgorithms(scan)).toEqual(["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa", "ecdsa-sha2-nistp256", "ssh-ed25519"]);
  });
});
