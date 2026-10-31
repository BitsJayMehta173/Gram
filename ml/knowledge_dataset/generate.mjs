// Local-LLM knowledge-questionnaire generator.
//
// Asks an already-farming-knowledgeable local model (via Ollama, zero-shot,
// no fine-tuning) a fixed set of well-scoped questions over every REAL
// eligible (crop, real geographic sub-zone, season) scenario -- not
// open-ended synthetic example generation. Scope is deliberately limited to
// knowledge the rule engine (backend/src/services/scoring.js, rotation.js)
// does NOT already compute precisely from sourced data: companion planting
// beyond the current curated list, soil-amendment technique, pest/disease
// management, and multi-year rotation sequencing. Never asks the model for
// eligibility/cost/yield/price -- those come from real sourced numbers
// already in enterprises.json, and an LLM guess would only be worse.
//
// Geographic grounding: gram's own enterprises.json only tags each crop with
// one of 3 coarse zones (terai/hills/high-hills). nepal_agri_ai's database
// already has 5 REAL agro-ecological zones with actual elevation bands and
// climate descriptions (Terai, Inner Terai, Mid-Hills, High Hills, Mountain)
// -- see ZONE_DETAILS below. Each gram zone expands into its real
// sub-zone(s) so every prompt carries specific elevation/climate context
// instead of a bare "hills" label, on the theory that a model given more
// specific grounding produces less generic, less hallucinated answers. This
// does NOT change gram's own live 3-zone schema, only how the questionnaire
// itself frames each scenario.
//
// Multi-model design: this script is meant to be run once per model (set
// KD_MODEL), each writing its OWN output file, so answers across models can
// be compared per-scenario afterward (agreement = higher confidence,
// disagreement = queue for a tie-breaker pass with a larger/hosted model).
// Different runs against the SAME zone/scenario format are required for
// that comparison to be meaningful -- see the model's own run notes for
// which scenario format (3-zone vs 5-zone) it used.
//
// Output: one JSONL file per model, one row per (crop, zoneDetail, season,
// questionType). Resumable: re-running skips rows already present in that
// model's output file, so an interrupted overnight run just picks back up.
//
// Pause/resume: create a file named PAUSE (any content, or empty -- e.g.
// `type nul > PAUSE` on Windows, `touch PAUSE` in bash) in this directory to
// pause after the current in-flight prompt finishes; delete it to resume.
// Checked between jobs, not mid-generation, so it never cuts off a response
// partway through.

import { readFileSync, existsSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAUSE_PATH = path.resolve(__dirname, "PAUSE");
const ENTERPRISES_PATH = path.resolve(__dirname, "../../backend/src/data/enterprises.json");
const OLLAMA_URL = "http://localhost:11434/api/generate";
const MODEL = process.env.KD_MODEL ?? "qwen2.5:7b-instruct";
// One output file per model -- keeps each model's pass independently
// resumable and makes later cross-model comparison a simple per-file join
// on (cropId, zoneLabel, season, questionType) rather than needing to
// untangle a shared file.
const OUTPUT_PATH = path.resolve(__dirname, `knowledge_dataset_${MODEL.replace(/[:/]/g, "_")}.jsonl`);

// Real agro-ecological zones (nepal_agri_ai's `regions` table -- elevation_m_min/max
// and typical_climate are real researched values, not invented here). gram's
// coarser zones each expand into 1-2 of these, so "terai" produces both a
// Terai and an Inner Terai question, and "high-hills" produces both a High
// Hills and a Mountain question -- gram itself has no separate Inner Terai
// or Mountain zone, so this is strictly additive detail for the questionnaire.
const ZONE_DETAILS = {
  terai: [
    { label: "Terai", elevation: "60-300m", climate: "Subtropical/tropical; hot humid summers, mild winters; monsoon-dominated rainfall" },
    { label: "Inner Terai", elevation: "300-1000m", climate: "Subtropical; warmer/drier than the outer hills, cooler than the open Terai" },
  ],
  hills: [
    { label: "Mid-Hills", elevation: "1000-2000m", climate: "Warm temperate to subtropical; distinct seasons, moderate rainfall" },
  ],
  "high-hills": [
    { label: "High Hills", elevation: "2000-3000m", climate: "Cool temperate; cold winters, short frost-free growing window" },
    { label: "Mountain", elevation: "3000-5500m", climate: "Alpine/subalpine; very short growing season, severe winters" },
  ],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns how many ms were spent paused, so the caller can exclude that time
// from its elapsed/ETA math -- otherwise a long pause would make the ETA
// think generation has gotten much slower than it actually is.
async function waitWhilePaused() {
  if (!existsSync(PAUSE_PATH)) return 0;
  const pauseStart = Date.now();
  console.log(`\n⏸  Paused (PAUSE file present at ${PAUSE_PATH}). Delete it to resume.`);
  while (existsSync(PAUSE_PATH)) {
    await sleep(3000);
  }
  const pausedMs = Date.now() - pauseStart;
  console.log(`▶  Resumed after ${(pausedMs / 60000).toFixed(1)}min paused.\n`);
  return pausedMs;
}

function zoneContext(zoneDetail) {
  return `${zoneDetail.label} zone of Nepal (elevation ${zoneDetail.elevation}; ${zoneDetail.climate})`;
}

const QUESTION_TEMPLATES = {
  companion_planting: (crop, zoneDetail, season) => `You are an agricultural expert on Nepal farming systems.
For ${crop} grown in the ${zoneContext(zoneDetail)} during the ${season} season, list 2-4 real, agronomically documented companion crops or plants commonly intercropped or planted alongside it.
For each one give: the companion's common name, then a one-sentence mechanism (nitrogen fixing, pest deterrence, shade/canopy complementarity, disease suppression, etc.).
If you are not confident a specific relationship is well-documented for South Asia/Nepal specifically (rather than a general assumption), say so explicitly instead of presenting it as certain.
Respond with ONLY lines in this exact format, nothing else:
- <companion name> | <mechanism, one sentence> | confidence: <high|medium|low>`,

  soil_amendment: (crop, zoneDetail, season) => `You are an agricultural expert on Nepal farming systems.
For ${crop} grown in the ${zoneContext(zoneDetail)} during the ${season} season, describe the manure/compost/organic soil-amendment practices commonly used.
Include: what is typically applied, approximate timing relative to planting, and approximate quantity if you know a real figure (say "no specific figure known" rather than inventing one).
Flag whether this is Nepal-specific documented practice or a general regional (South Asia) assumption.
Respond in 3-5 sentences, plain text, ending with: confidence: <high|medium|low>`,

  pest_disease: (crop, zoneDetail, season) => `You are an agricultural expert on Nepal farming systems.
For ${crop} grown in the ${zoneContext(zoneDetail)} during the ${season} season, list the 2-3 most common pests or diseases, and for each the typical organic/low-input management practice used (not just chemical pesticide names).
Respond with ONLY lines in this exact format, nothing else:
- <pest/disease name> | <management practice, one sentence> | confidence: <high|medium|low>`,

  rotation_sequence: (crop, zoneDetail, season) => `You are an agricultural expert on Nepal farming systems.
Beyond a single year, what multi-year (2-4 year) crop rotation sequence is commonly recommended agronomically after ${crop} grown in the ${zoneContext(zoneDetail)} (planted in ${season} season), to maintain soil health?
Name 2-3 real crops that would typically follow it in sequence, and briefly why (nitrogen needs, pest-cycle break, market rotation).
Respond in 3-5 sentences, plain text, ending with: confidence: <high|medium|low>`,
};

function loadEligibleScenarios() {
  const data = JSON.parse(readFileSync(ENTERPRISES_PATH, "utf8"));
  const scenarios = [];
  for (const e of data.enterprises) {
    if (e.category !== "crop") continue; // livestock doesn't have zone/season combinations the same way
    for (const zone of e.zones) {
      for (const zoneDetail of ZONE_DETAILS[zone] ?? [{ label: zone, elevation: "unknown", climate: "unknown" }]) {
        for (const season of e.seasons) {
          scenarios.push({ cropId: e.id, cropName: e.name, gramZone: zone, zoneDetail, season });
        }
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
      keys.add(`${row.cropId}|${row.zoneLabel}|${row.season}|${row.questionType}`);
    } catch {
      // skip a corrupted line (e.g. from a killed process mid-write) rather than crash the whole resume
    }
  }
  return keys;
}

async function askOllama(prompt) {
  const t0 = Date.now();
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const elapsedMs = Date.now() - t0;
  // Ollama reports eval_count (tokens generated) and eval_duration (ns) directly -- more
  // accurate than timing the HTTP round-trip ourselves, since it excludes model-load time.
  const tokensPerSec = data.eval_count && data.eval_duration ? data.eval_count / (data.eval_duration / 1e9) : null;
  return { text: data.response, elapsedMs, tokensPerSec, evalCount: data.eval_count };
}

async function main() {
  const scenarios = loadEligibleScenarios();
  const completed = loadCompletedKeys();
  const questionTypes = Object.keys(QUESTION_TEMPLATES);
  const allJobs = [];
  for (const s of scenarios) {
    for (const qType of questionTypes) {
      const key = `${s.cropId}|${s.zoneDetail.label}|${s.season}|${qType}`;
      if (completed.has(key)) continue;
      allJobs.push({ ...s, questionType: qType, key });
    }
  }

  console.log(`Model: ${MODEL}`);
  console.log(`Output: ${OUTPUT_PATH}`);
  console.log(`Total scenarios: ${scenarios.length} (5-zone geographic detail), question types: ${questionTypes.length}`);
  console.log(`Already completed: ${completed.size}, remaining: ${allJobs.length}`);
  if (allJobs.length === 0) {
    console.log("Nothing left to do.");
    return;
  }

  let done = 0;
  let totalPausedMs = 0;
  const recentRates = [];
  const startTime = Date.now();

  for (const job of allJobs) {
    totalPausedMs += await waitWhilePaused();

    const prompt = QUESTION_TEMPLATES[job.questionType](job.cropName, job.zoneDetail, job.season);
    let result;
    try {
      result = await askOllama(prompt);
    } catch (err) {
      console.error(`FAILED ${job.key}: ${err.message}`);
      continue; // leave it out of the output file, will be retried on next run
    }

    const row = {
      cropId: job.cropId,
      cropName: job.cropName,
      gramZone: job.gramZone,
      zoneLabel: job.zoneDetail.label,
      zoneElevation: job.zoneDetail.elevation,
      season: job.season,
      questionType: job.questionType,
      answer: result.text.trim(),
      model: MODEL,
      generatedAt: new Date().toISOString(),
    };
    appendFileSync(OUTPUT_PATH, JSON.stringify(row) + "\n", "utf8");

    done += 1;
    if (result.tokensPerSec) recentRates.push(result.tokensPerSec);
    if (recentRates.length > 20) recentRates.shift();
    const avgRate = recentRates.length > 0 ? recentRates.reduce((a, b) => a + b, 0) / recentRates.length : null;

    if (done % 5 === 0 || done === allJobs.length) {
      const activeMs = Date.now() - startTime - totalPausedMs; // excludes paused time, so a long pause doesn't skew the ETA
      const elapsedMin = activeMs / 60000;
      const avgMsPerJob = activeMs / done;
      const remainingMin = (avgMsPerJob * (allJobs.length - done)) / 60000;
      console.log(
        `[${done}/${allJobs.length}] ${job.key} -- ${avgRate ? avgRate.toFixed(1) + " tok/s avg" : ""} -- ` +
          `active ${elapsedMin.toFixed(1)}min, ETA ${remainingMin.toFixed(0)}min remaining`
      );
    }
  }

  console.log(`Done. ${done} new rows written to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
