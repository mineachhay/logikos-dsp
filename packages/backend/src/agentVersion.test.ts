import { describe, expect, it } from "vitest";
import { binaryVersion } from "./agentVersion.js";

describe("binaryVersion", () => {
  const rev = "3bdf58922755645fbfcb1744fe2939419b887644";
  it("reads the build stamp Go embeds in the binary", () => {
    const binary = Buffer.concat([Buffer.alloc(64, 0), Buffer.from(`build\tvcs=git\nbuild\tvcs.revision=${rev}\nbuild\tvcs.modified=false\n`), Buffer.alloc(64, 0xff)]);
    expect(binaryVersion(binary)).toBe("3bdf58922755");
  });
  it("marks a build from an uncommitted tree", () => {
    expect(binaryVersion(Buffer.from(`vcs.revision=${rev}\nvcs.modified=true`))).toBe("3bdf58922755-dirty");
  });
  it("knows nothing about a binary without the stamp", () => {
    expect(binaryVersion(Buffer.from("MZ not a go binary"))).toBeNull();
  });
});
