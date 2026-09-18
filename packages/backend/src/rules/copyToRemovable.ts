import { prisma } from "../db.js";

/**
 * Files landing on removable media.
 *
 * Where USB storage is blocked for most people and allowed for a few, a copy
 * onto it is the event worth waking someone up for — and it is invisible to
 * the file server, which only ever learns that its file was read. It takes an
 * agent on the machine doing the copying to see the other half, which is why
 * this rule lives here and not beside the share's own rules.
 *
 * Severity reflects what's actually known: a file we can trace back to a
 * watched share went from somewhere managed onto a device that can walk out of
 * the building, which is HIGH. A file appearing on a stick with no known
 * origin might be someone's own work, so it's MEDIUM — still recorded, not
 * treated as an incident.
 */

/** Copying a folder is one action by a person, so it should be one alert. */
export const REMOVABLE_WINDOW_SECONDS = 300;

/** How many paths to keep on the alert, for the same reason the ransomware rule caps them. */
const MAX_SAMPLE_PATHS = 200;

export async function checkCopyToRemovable(sourceId: string, now = new Date()): Promise<void> {
  const windowStart = new Date(now.getTime() - REMOVABLE_WINDOW_SECONDS * 1000);

  const arrivals = await prisma.fileEvent.findMany({
    where: {
      sourceId,
      removable: true,
      eventType: { in: ["CREATED", "COPIED", "MODIFIED"] },
      occurredAt: { gte: windowStart },
    },
    orderBy: { occurredAt: "asc" },
    take: MAX_SAMPLE_PATHS,
  });
  if (arrivals.length === 0) return;

  // One alert per device per burst. Grouping by volume rather than by source
  // matters: two sticks in two ports are two things to ask about.
  const byVolume = new Map<string, typeof arrivals>();
  for (const arrival of arrivals) {
    const key = `${arrival.volumeSerial ?? ""}|${arrival.volumeLabel ?? ""}`;
    const group = byVolume.get(key);
    if (group) group.push(arrival);
    else byVolume.set(key, [arrival]);
  }

  const source = await prisma.source.findUnique({ where: { id: sourceId }, select: { agentId: true, rootLabel: true } });

  for (const [key, group] of byVolume) {
    const existing = await prisma.alert.findFirst({
      where: {
        sourceId,
        type: "COPY_TO_REMOVABLE",
        status: "OPEN",
        createdAt: { gte: windowStart },
        metadata: { path: ["volumeKey"], equals: key },
      },
    });
    if (existing) continue;

    const fromWatched = group.filter((event) => event.previousSourceId !== null);
    const severity = fromWatched.length > 0 ? "HIGH" : "MEDIUM";
    const actor = group.find((event) => event.actorUser)?.actorUser ?? "Someone";
    const device = describeVolume(group[0].volumeLabel, group[0].volumeSerial);

    const alert = await prisma.alert.create({
      data: {
        type: "COPY_TO_REMOVABLE",
        severity,
        agentId: source?.agentId,
        sourceId,
        message:
          `${actor} put ${group.length} file(s) on ${device}` +
          (fromWatched.length > 0 ? `, ${fromWatched.length} of them copied from a monitored share.` : "."),
        metadata: {
          volumeKey: key,
          volumeLabel: group[0].volumeLabel,
          volumeSerial: group[0].volumeSerial,
          fileCount: group.length,
          fromWatchedShare: fromWatched.length,
          actorUser: group.find((event) => event.actorUser)?.actorUser ?? null,
          affectedPaths: group.slice(0, MAX_SAMPLE_PATHS).map((event) => event.path),
        },
      },
    });

    // Suggested, not automatic — the same approve-first path as every other
    // alert. Quarantine is deliberately not offered: the file that matters is
    // the copy on a device we don't control, and deleting the local original
    // would destroy evidence without recovering anything.
    await prisma.responseAction.create({ data: { alertId: alert.id, type: "WEBHOOK_NOTIFICATION" } });
  }
}

/** A drive letter is reused by the next device, so name the volume instead. */
function describeVolume(label: string | null, serial: string | null): string {
  if (label && serial) return `removable drive "${label}" (serial ${serial})`;
  if (serial) return `a removable drive (serial ${serial})`;
  if (label) return `removable drive "${label}"`;
  return "a removable drive";
}
