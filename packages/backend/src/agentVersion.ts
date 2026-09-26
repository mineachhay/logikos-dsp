// Which build an agent.exe is, read from the file itself — the same stamp the
// agent reports about itself (native-agent/internal/buildinfo), so the Agents
// page can flag machines running an older build than the one it offers.

/**
 * Go embeds the build's settings in the binary as plain text lines
 * ("build\tvcs.revision=<40 hex>", "build\tvcs.modified=true"), readable
 * without executing it or having Go installed. Formatted like
 * buildinfo.Format: 12 characters, "-dirty" for an uncommitted tree.
 */
export function binaryVersion(binary: Buffer): string | null {
  const text = binary.toString("latin1");
  const revision = /vcs\.revision=([0-9a-f]{40})/.exec(text)?.[1];
  if (!revision) return null;
  const modified = /vcs\.modified=true/.test(text);
  return revision.slice(0, 12) + (modified ? "-dirty" : "");
}
