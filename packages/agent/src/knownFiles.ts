/**
 * What each managed share actually contains, as of its last scan.
 *
 * Windows logs listing a folder exactly like reading a file, and on a share
 * people are browsing, folder listings are most of the read volume. Checking a
 * read against the files the scan found is what separates "someone opened
 * payroll.csv" from "Explorer showed the folder" — so the scan loop
 * (snapshotDiff) publishes here and the activity collector reads it.
 */
const knownFiles = new Map<string, ReadonlySet<string>>();

export function setKnownFiles(sourceId: string, paths: ReadonlySet<string>): void {
  knownFiles.set(sourceId, paths);
}

export function knownFilesFor(sourceId: string): ReadonlySet<string> | undefined {
  return knownFiles.get(sourceId);
}

export function forgetKnownFiles(sourceId: string): void {
  knownFiles.delete(sourceId);
}
