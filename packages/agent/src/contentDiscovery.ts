// Content discovery: examine the files already on a share, not only the ones
// that change. The share scan only ever sampled created/modified files, so a
// share's existing contents — tens of thousands of files — were never looked
// at, and Data Risk read "0 matches" meaning "not examined".
//
// Deliberately slow and resumable: one file at a time across all shares, at
// config.discoveryFilesPerSecond, reading files whole over SMB only for the
// formats text can be extracted from (textExtract.ts). The backend remembers
// what's been examined (ContentScan), so a restart continues where it left off.
import { config } from "./config.js";
import { fetchContentScans, postContentScans, postDiscoveryProgress, type ContentScanInput } from "./client.js";
import { doneKey, planDiscovery, type KnownFile } from "./discoveryPlan.js";
import { sampleContent, type ContentSample } from "./sampleContent.js";
import type { Source } from "./sources/types.js";

interface State {
  source: Source;
  files: ReadonlyMap<string, KnownFile>;
  stopped: boolean;
  running: boolean;
  lastPassFinishedAt: number | null;
}

const states = new Map<string, State>();
/**
 * One file read at a time across every share, and no faster than
 * config.discoveryFilesPerSecond in total — the file servers are someone's
 * production. Each share's pass runs on its own and takes turns here, file by
 * file; passes used to run one after another, so a share added during a
 * first pass over a big one waited hours for it to finish.
 */
let readChain: Promise<unknown> = Promise.resolve();
let lastReadAt = 0;

function withReadTurn<T>(read: () => Promise<T>): Promise<T> {
  const turn = readChain.then(async () => {
    const gapMs = 1000 / Math.max(0.1, config.discoveryFilesPerSecond);
    const wait = lastReadAt + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastReadAt = Date.now();
    return read();
  });
  readChain = turn.catch(() => undefined);
  return turn;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Called after each successful scan of a managed share, with what it found. */
export function updateDiscovery(sourceId: string, source: Source, files: ReadonlyMap<string, KnownFile>): void {
  if (!config.discoveryEnabled) return;
  const state = states.get(sourceId) ?? { source, files, stopped: false, running: false, lastPassFinishedAt: null };
  state.source = source;
  state.files = files;
  states.set(sourceId, state);
  const due = state.lastPassFinishedAt === null || Date.now() - state.lastPassFinishedAt > config.discoveryRepassMs;
  if (!state.running && due) {
    state.running = true;
    runPass(sourceId, state).catch((err) => console.error(`discovery of ${source.describe()} failed`, err));
  }
}

export function stopDiscovery(sourceId: string): void {
  const state = states.get(sourceId);
  if (state) state.stopped = true;
  states.delete(sourceId);
}

async function runPass(sourceId: string, state: State): Promise<void> {
  try {
    const examined = await fetchContentScans(sourceId);
    if (!examined || state.stopped) return;
    const done = new Map(examined.map(([path, size, mtime]) => [path, doneKey({ sizeBytes: size, mtimeMs: mtime })]));
    const plan = planDiscovery(state.files, done);
    const counts = { candidates: plan.candidates, skippedType: plan.skippedType, skippedSize: plan.skippedSize };
    await postDiscoveryProgress(sourceId, { ...counts, passStartedAt: new Date().toISOString() });
    console.log(
      `${state.source.describe()}: discovery — ${plan.todo.length} of ${plan.candidates} readable file(s) to examine ` +
        `(${plan.skippedType} other types, ${plan.skippedSize} too large)`,
    );

    let batch: ContentScanInput[] = [];
    let examinedNow = 0;
    for (const path of plan.todo) {
      if (state.stopped) return;
      const file = state.files.get(path); // latest scan's view; gone means deleted since
      if (!file) continue;
      const sample: ContentSample | null = await withReadTurn(() => sampleContent(state.source, path, file.sizeBytes)).catch(
        (err: Error): ContentSample => ({ extractor: "text", note: `couldn't read the file: ${err.message.slice(0, 120)}` }),
      );
      if (sample) {
        batch.push({ path, sizeBytes: file.sizeBytes, mtimeMs: Math.round(file.mtimeMs), extractor: sample.extractor, contentSample: sample.contentSample, note: sample.note });
        examinedNow++;
      }
      if (batch.length >= 10) {
        await postContentScans(sourceId, batch);
        batch = [];
      }
      if (examinedNow > 0 && examinedNow % 500 === 0) {
        console.log(`${state.source.describe()}: discovery — ${examinedNow} of ${plan.todo.length} examined`);
      }
    }
    if (batch.length) await postContentScans(sourceId, batch);
    await postDiscoveryProgress(sourceId, { ...counts, passFinishedAt: new Date().toISOString() });
    state.lastPassFinishedAt = Date.now();
    console.log(`${state.source.describe()}: discovery pass finished — ${examinedNow} file(s) examined`);
  } finally {
    state.running = false;
  }
}
