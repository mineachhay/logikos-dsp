import { describe, expect, it } from "vitest";
import { buildRcloneSetup } from "./rcloneConfig.js";

describe("SMB destinations", () => {
  const destination = {
    type: "SMB" as const,
    config: { host: "nas.example.com", share: "backups", path: "logikos-dsp", username: "svc-backup", domain: "CORP" },
    credentials: { password: "secret" },
    remotePath: "",
  };

  it("addresses the share as part of the path, the way rclone expects", () => {
    const setup = buildRcloneSetup(destination, "OBSCURED");
    expect(setup.remoteDir).toBe("dest:backups/logikos-dsp");
    expect(setup.configText).toContain("type = smb");
    expect(setup.configText).toContain("host = nas.example.com");
    expect(setup.configText).toContain("domain = CORP");
  });

  // rclone refuses a plain password in its config, so it must be the obscured
  // form — and the real one must never appear in the file.
  it("writes the obscured password, never the real one", () => {
    const setup = buildRcloneSetup(destination, "OBSCURED");
    expect(setup.configText).toContain("pass = OBSCURED");
    expect(setup.configText).not.toContain("secret");
  });

  it("uses the share root when no folder is given", () => {
    const setup = buildRcloneSetup({ ...destination, config: { ...destination.config, path: "" } }, "OBSCURED");
    expect(setup.remoteDir).toBe("dest:backups");
  });

  it("tolerates a share or path written with leading slashes", () => {
    const setup = buildRcloneSetup(
      { ...destination, config: { ...destination.config, share: "/backups", path: "/nightly" } },
      "OBSCURED",
    );
    expect(setup.remoteDir).toBe("dest:backups/nightly");
  });
});
