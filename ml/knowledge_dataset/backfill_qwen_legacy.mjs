// One-off backfill for the 298 rows the Qwen2.5-7B pass missed during the
// server-restart incident. Deliberately uses the ORIGINAL 3-zone prompt
// format (bare zone name, no elevation/climate detail) to stay consistent
// with the other 1,126 rows already in knowledge_dataset.jsonl -- this file
// predates the 5-zone geographic-detail upgrade (see generate.mjs), and
// mixing prompt formats within one model's single dataset file would make
// it internally inconsistent. The 5-zone upgrade applies going forward,
// starting with the Llama pass.

import { readFileSync, existsSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTERPRISES_PATH = path.resolve(__dirname, "../../backend/src/data/enterprises.json");
const OUTPUT_PATH = path.resolve(__dirname, "knowledge_dataset.jsonl");
const OLLAMA_URL = "http://localhost:11434/api/generate";
const MODEL = "qwen2.5:7b-instruct";

const QUESTION_TEMPLATES = {
  companion_planting: (crop, zone, season) => `You are an agricultural expert on Nepal farming systems.
For ${crop} grown in the ${zone} zone of Nepal during the ${season} season, list 2-4 real, agronomically documented companion crops or plants commonly intercropped or planted alongside it.
For each one give: the companion's common name, then a one-sentence mechanism (nitrogen fixing, pest deterrence, shade/canopy complementarity, disease suppression, etc.).
If you are not confident a specific relationship is well-documented for South Asia/Nepal specifically (rather than a general assumption), say so explicitly instead of presenting it as certain.
Respond with ONLY lines in this exact format, nothing else:
- <companion name> | <mechanism, one sentence> | confidence: <high|medium|low>`,

  soil_amendment: (crop, zone, season) => `You are an agricultural expert on Nepal farming systems.
For ${crop} grown in the ${zone} zone of Nepal during the ${season} season, describe the manure/compost/organic soil-amendment practices commonly used.
Include: what is typically applied, approximate timing relative to planting, and approximate quantity if you know a real figure (say "no specific figure known" rather than inventing one).
Flag whether this is Nepal-specific documented practice or a general regional (South Asia) assumption.
Respond in 3-5 sentences, plain text, ending with: confidence: <high|medium|low>`,

  pest_disease: (crop, zone, season) => `You are an agricultural expert on Nepal farming systems.
For ${crop} grown in the ${zone} zone of Nepal during the ${season} season, list the 2-3 most common pests or diseases, and for each the typical organic/low-input management practice used (not just chemical pesticide names).
Respond with ONLY lines in this exact format, nothing else:
- <pest/disease name> | <management practice, one sentence> | confidence: <high|medium|low>`,

  rotation_sequence: (crop, zone, season) => `You are an agricultural expert on Nepal farming systems.
Beyond a single year, what multi-year (2-4 year) crop rotation sequence is commonly recommended agronomically after ${crop} grown in the ${zone} zone of Nepal (planted in ${season} season), to maintain soil health?
Name 2-3 real crops that would typically follow it in sequence, and briefly why (nitrogen needs, pest-cycle break, market rotation).
Respond in 3-5 sentences, plain text, ending with: confidence: <high|medium|low>`,
};

function loadEligibleScenarios() {
  const data = JSON.parse(readFileSync(ENTERPRISES_PATH, "utf8"));
  const scenarios = [];
  for (const e of data.enterprises) {
    if (e.category !== "crop") continue;
    for (const zone of e.zones) {
      for (const season of e.seasons) {
        scenarios.push({ cropId: e.id, cropName: e.name, zone, season });
      }
    }
  }
  return scenarios;
}

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

async function askOllama(prompt) {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const tokensPerSec = data.eval_count && data.eval_duration ? data.eval_count / (data.eval_duration / 1e9) : null;
  return { text: data.response, tokensPerSec };
}

async function main() {
  const scenarios = loadEligibleScenarios();
  const completed = loadCompletedKeys();
  const questionTypes = Object.keys(QUESTION_TEMPLATES);
  const allJobs = [];
  for (const s of scenarios) {
    for (const qType of questionTypes) {
      const key = `${s.cropId}|${s.zone}|${s.season}|${qType}`;
      if (completed.has(key)) continue;
      allJobs.push({ ...s, questionType: qType, key });
    }
  }

  console.log(`Backfilling ${allJobs.length} missing rows for ${MODEL} into ${OUTPUT_PATH}`);
  if (allJobs.length === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  let done = 0;
  const startTime = Date.now();
  for (const job of allJobs) {
    const prompt = QUESTION_TEMPLATES[job.questionType](job.cropName, job.zone, job.season);
    let result;
    try {
      result = await askOllama(prompt);
    } catch (err) {
      console.error(`FAILED ${job.key}: ${err.message}`);
      continue;
    }
    const row = {
      cropId: job.cropId,
      cropName: job.cropName,
      zone: job.zone,
      season: job.season,
      questionType: job.questionType,
      answer: result.text.trim(),
      model: MODEL,
      generatedAt: new Date().toISOString(),
    };
    appendFileSync(OUTPUT_PATH, JSON.stringify(row) + "\n", "utf8");
    done += 1;
    if (done % 10 === 0 || done === allJobs.length) {
      const elapsedMin = (Date.now() - startTime) / 60000;
      const remainingMin = (elapsedMin / done) * (allJobs.length - done);
      console.log(`[${done}/${allJobs.length}] ${job.key} -- elapsed ${elapsedMin.toFixed(1)}min, ETA ${remainingMin.toFixed(0)}min`);
    }
  }
  console.log(`Backfill done. ${done} rows added.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
