// Appends a batch of Claude-authored rows (from batch_input.mjs, a plain JS
// array so answer text never needs manual JSON-string escaping) to
// knowledge_dataset_claude-sonnet-5.jsonl -- same row shape as the other
// model passes (see generate.mjs), so build_growing_tips.mjs can treat this
// as just another MODEL_SOURCES entry once it's done. Skips any (cropId,
// zone, season, questionType) key already present, so this is resumable
// across many small batches the same way the Ollama passes are.
import { readFileSync, existsSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { rows } from "./batch_input.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL = "claude-sonnet-5";
const OUTPUT_PATH = path.resolve(__dirname, `knowledge_dataset_${MODEL.replace(/[:/]/g, "_")}.jsonl`);

function loadCompletedKeys() {
  if (!existsSync(OUTPUT_PATH)) return new Set();
  const lines = readFileSync(OUTPUT_PATH, "utf8").split("\n").filter(Boolean);
  const keys = new Set();
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      keys.add(`${row.cropId}|${row.zone}|${row.season}|${row.questionType}`);
    } catch {
      // skip corrupted line
    }
  }
  return keys;
}

const completed = loadCompletedKeys();
let written = 0;
let skipped = 0;
for (const r of rows) {
  const key = `${r.cropId}|${r.zone}|${r.season}|${r.questionType}`;
  if (completed.has(key)) {
    skipped += 1;
    continue;
  }
  const row = { ...r, model: MODEL, generatedAt: new Date().toISOString() };
  appendFileSync(OUTPUT_PATH, JSON.stringify(row) + "\n", "utf8");
  completed.add(key);
  written += 1;
}

const scenarios = JSON.parse(readFileSync(path.resolve(__dirname, "claude_scenarios.json"), "utf8"));
const totalJobs = scenarios.length * 4;
console.log(`Batch: wrote ${written} new rows, skipped ${skipped} already-present. Total so far: ${completed.size}/${totalJobs}`);
