import { pipeline, env } from "@huggingface/transformers";
import type { SensitivePatternType } from "@logikos-dsp/shared";
import type { PatternMatch } from "./patterns.js";

// Model weights download once from Hugging Face Hub on first use and are
// cached under this directory afterward — that's a one-time setup download,
// not an ongoing network call. Inference itself (the part that touches file
// content) runs fully offline via ONNX Runtime/WASM; no scanned content ever
// leaves the machine. See ARCHITECTURE.md.
env.cacheDir = new URL("../.cache/", import.meta.url).pathname;

type TokenClassificationPipeline = Awaited<ReturnType<typeof pipeline<"token-classification">>>;

let pipelinePromise: Promise<TokenClassificationPipeline> | null = null;

function loadPipeline(): Promise<TokenClassificationPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = pipeline("token-classification", "Xenova/bert-base-NER", { dtype: "q8" });
  }
  return pipelinePromise;
}

/** Loads the model eagerly so worker startup fails fast and the first real job isn't slow. */
export async function preloadNerModel(): Promise<void> {
  const start = Date.now();
  await loadPipeline();
  console.log(`NER model loaded in ${Date.now() - start}ms`);
}

const ENTITY_TYPE_MAP: Record<string, SensitivePatternType> = {
  PER: "person",
  ORG: "organization",
  LOC: "location",
  // MISC is intentionally unmapped/dropped — too broad to be a useful sensitivity signal.
};

// BERT NER can misfire on short/lowercase tokens; drop low-confidence guesses.
const NER_CONFIDENCE_THRESHOLD = 0.85;

// Cheap upstream safeguard for BERT's ~512-token limit, on top of whatever
// truncation the pipeline does internally.
const MAX_NER_INPUT_CHARS = 2000;

function redactEntityName(word: string): string {
  if (word.length <= 1) return "*";
  return `${word[0]}${"*".repeat(word.length - 1)}`;
}

export async function findNamedEntities(content: string): Promise<PatternMatch[]> {
  const text = content.slice(0, MAX_NER_INPUT_CHARS).trim();
  if (!text) return [];

  const ner = await loadPipeline();
  const entities = await ner(text, { aggregation_strategy: "simple" });

  const matches: PatternMatch[] = [];
  for (const entity of entities) {
    const patternType = ENTITY_TYPE_MAP[entity.entity_group];
    if (!patternType) continue;
    if (entity.score < NER_CONFIDENCE_THRESHOLD) continue;
    matches.push({ patternType, redactedSample: redactEntityName(entity.word) });
  }
  return matches;
}
