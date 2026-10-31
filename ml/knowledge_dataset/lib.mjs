// Shared parsing/fact-check logic for both build_growing_tips.mjs (the
// live-app-facing merge) and build_labeled_dataset.mjs (the probabilistic
// labeled dataset) -- single source of truth so the two never drift apart
// on what counts as a fact-check pass/fail.

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One canonical sub-zone per gram zone, used only to collapse a 5-zone
// model's rows down to gram's 3-zone granularity. Llama's pass used real
// 5-zone geographic detail (Terai/Inner Terai/Mid-Hills/High Hills/Mountain
// -- see generate.mjs's ZONE_DETAILS); only the canonical sub-zone per gram
// zone is kept here so it lines up with Qwen/Claude's plain 3-zone rows.
export const CANONICAL_SUBZONE = { terai: "Terai", hills: "Mid-Hills", "high-hills": "High Hills" };

// Every model pass to fold in. Add a new entry here once a model's .jsonl
// finishes -- nothing else needs to change. `normalize` turns that model's
// raw row shape into the common { cropId, cropName, gramZone, season,
// questionType, answer } shape; returning null skips a row.
export const MODEL_SOURCES = [
  {
    model: "qwen2.5:7b-instruct",
    file: path.resolve(__dirname, "knowledge_dataset_qwen2.5_7b-instruct.jsonl"),
    normalize: (row) => ({ ...row, gramZone: row.zone }),
  },
  {
    model: "llama3.1:8b",
    file: path.resolve(__dirname, "knowledge_dataset_llama3.1_8b.jsonl"),
    normalize: (row) => (row.zoneLabel === CANONICAL_SUBZONE[row.gramZone] ? row : null),
  },
  {
    model: "claude-sonnet-5",
    file: path.resolve(__dirname, "knowledge_dataset_claude-sonnet-5.jsonl"),
    normalize: (row) => ({ ...row, gramZone: row.zone }),
  },
];

// Real, sourced nitrogen-fixing facts already in the app (rotation.js).
// Names below are the natural-language aliases an LLM answer is likely to
// use for each id, for substring matching against free-text claims.
export const ROTATION_TRAITS = {
  rice: { nitrogenEffect: "depletes", aliases: ["rice", "paddy"] },
  wheat: { nitrogenEffect: "depletes", aliases: ["wheat"] },
  maize: { nitrogenEffect: "depletes", aliases: ["maize", "corn"] },
  millet: { nitrogenEffect: "depletes", aliases: ["millet"] },
  lentil: { nitrogenEffect: "fixes", aliases: ["lentil"] },
  potato: { nitrogenEffect: "depletes", aliases: ["potato"] },
  ginger: { nitrogenEffect: "depletes", aliases: ["ginger"] },
  mungbean: { nitrogenEffect: "fixes", aliases: ["mung bean", "mungbean", "moong"] },
  sesame: { nitrogenEffect: "depletes", aliases: ["sesame"] },
  jute: { nitrogenEffect: "depletes", aliases: ["jute"] },
  garlic: { nitrogenEffect: "depletes", aliases: ["garlic"] },
  mustard: { nitrogenEffect: "depletes", aliases: ["mustard"] },
  cauliflower: { nitrogenEffect: "depletes", aliases: ["cauliflower"] },
  cabbage: { nitrogenEffect: "depletes", aliases: ["cabbage"] },
  tomato: { nitrogenEffect: "depletes", aliases: ["tomato"] },
  turmeric: { nitrogenEffect: "depletes", aliases: ["turmeric"] },
  chickpea: { nitrogenEffect: "fixes", aliases: ["chickpea", "chana"] },
};

// Word-boundary matching, not plain substring -- a naive .includes() match
// let "wheat" match inside "buckwheat" (a completely unrelated plant).
export function findKnownCropForName(name) {
  const lower = name.toLowerCase();
  for (const [id, trait] of Object.entries(ROTATION_TRAITS)) {
    if (trait.aliases.some((alias) => new RegExp(`\\b${alias}\\b`, "i").test(lower))) return { id, ...trait };
  }
  return null;
}

// Parses "- <name> | <detail> | confidence: <level>" list-format answers
// (companion_planting, pest_disease) into structured entries.
export function parseListAnswer(answer) {
  const lines = answer.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("-"));
  const entries = [];
  for (const line of lines) {
    const match = line.match(/^-\s*(.+?)\s*\|\s*(.+?)\s*\|\s*confidence:\s*(high|medium|low)/i);
    if (match) entries.push({ name: match[1].trim(), detail: match[2].trim(), confidence: match[3].toLowerCase() });
  }
  return entries;
}

// Parses freeform paragraph answers (soil_amendment, rotation_sequence)
// ending in "confidence: <level>" into { text, confidence }. Note this
// regex requires the tag as the literal last token -- some Llama rows use
// variant punctuation (e.g. trailing periods/brackets) that doesn't match,
// leaving confidence: null. build_labeled_dataset.mjs treats that as an
// honest "unparsed" state rather than silently defaulting it to a level.
export function parseFreeformAnswer(answer) {
  const match = answer.match(/confidence:\s*(high|medium|low)\s*$/i);
  const confidence = match ? match[1].toLowerCase() : null;
  const text = match ? answer.slice(0, match.index).trim() : answer.trim();
  return { text, confidence };
}

// Generic legume-family words an answer might use for the OTHER partner in a
// companion-planting pair, distinct from the crop ROTATION_TRAITS already
// tracks by id -- used below to tell "the named crop itself is claimed to fix
// nitrogen" (a real error, e.g. mustard) apart from "the named crop is paired
// with a legume, and the legume is what fixes nitrogen" (a real, common,
// CORRECT companion-planting claim that just happens to co-occur with the
// named crop in the same entry).
export const GENERIC_LEGUME_PATTERN =
  /\b(cowpea|bean|beans|soybean|pea|peas|pulse|legume|gram|clover|vetch|sesbania|dhaincha|azolla|sunn ?hemp|stylo|lucerne|berseem)\b/i;

export function factCheckNitrogenClaim(name, detail) {
  const mentionsNitrogen = /nitrogen/i.test(detail);
  if (!mentionsNitrogen) return { ok: true };
  const known = findKnownCropForName(name);
  if (!known) return { ok: true }; // no real data to check this specific companion against
  const claimsFixes = /fix/i.test(detail);
  if (claimsFixes && known.nitrogenEffect !== "fixes") {
    const detailWithoutName = detail.replace(new RegExp(`\\b${name}\\b`, "gi"), "");
    if (GENERIC_LEGUME_PATTERN.test(detailWithoutName)) {
      return {
        ok: true,
        caveat: `This entry names "${name}" (this app's own data has "${known.id}" as nitrogenEffect="${known.nitrogenEffect}") alongside a nitrogen-fixing claim, but also mentions another legume-like plant -- if the claim is about THAT plant fixing nitrogen (a real, common companion-planting pattern) this is fine; if it's claiming ${name} itself fixes nitrogen, that would be wrong. Word-co-occurrence check only, not a subject parse -- read the entry yourself.`,
        knownCrop: known,
      };
    }
    return {
      ok: false,
      reason: `"${name}" is claimed to fix nitrogen, but this app's own sourced data (rotation.js ROTATION_TRAITS) has "${known.id}" as nitrogenEffect="${known.nitrogenEffect}" -- ${known.id} is a real nitrogen-DEPLETING crop, not a fixer.`,
      knownCrop: known,
    };
  }
  return { ok: true };
}

// Same check, applied sentence-by-sentence to FREEFORM text. Co-occurrence
// heuristic, not a real subject/negation parse -- see build_growing_tips.mjs
// for the false-positive this wording is deliberately hedged around.
export function factCheckFreeformText(text) {
  const violations = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    if (!/nitrogen/i.test(sentence) || !/fix/i.test(sentence)) continue;
    for (const [id, trait] of Object.entries(ROTATION_TRAITS)) {
      if (trait.nitrogenEffect === "fixes") continue;
      if (trait.aliases.some((alias) => new RegExp(`\\b${alias}\\b`, "i").test(sentence))) {
        violations.push({
          sentence: sentence.trim(),
          reason: `This sentence may be describing "${id}" as fixing nitrogen -- but this app's own sourced data has "${id}" as nitrogenEffect="depletes". (Automated word-co-occurrence check, not a subject parse -- if the sentence is actually crediting a DIFFERENT crop with fixing nitrogen and just mentioning ${id} as context, this flag is a false positive. Read the sentence yourself.)`,
          knownCrop: { id, ...trait },
        });
      }
    }
  }
  return violations;
}

// Splits freeform text into sentences using the exact same splitter
// factCheckFreeformText uses internally, so sentence-level labeling lines up
// 1:1 with what the fact-checker actually evaluated.
export function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

export const LIST_KEYS = { companion_planting: "companionPlanting", pest_disease: "pestDisease" };
export const FREEFORM_KEYS = { soil_amendment: "soilAmendment", rotation_sequence: "rotationSequence" };

export function loadSourceRows() {
  const rows = [];
  const perModelRawCount = {};
  for (const source of MODEL_SOURCES) {
    if (!existsSync(source.file)) {
      console.log(`Skipping ${source.model} -- ${source.file} not found (pass not run/finished yet).`);
      continue;
    }
    const lines = readFileSync(source.file, "utf8").split("\n").filter(Boolean);
    perModelRawCount[source.model] = lines.length;
    for (const line of lines) {
      const raw = JSON.parse(line);
      const normalized = source.normalize(raw);
      if (normalized) rows.push({ ...normalized, model: source.model });
    }
  }
  return { rows, perModelRawCount };
}

// ---------------------------------------------------------------------
// Probabilistic scoring -- shared by build_growing_tips.mjs (filters what
// the live app shows) and build_labeled_dataset.mjs (the full labeled
// export). Single formula, single place, so the two can never disagree on
// what a given claim's confidence actually is. Full rationale for why this
// exists (self-reported confidence already proven unreliable) lives in
// build_labeled_dataset.mjs's file header.
// ---------------------------------------------------------------------

// Self-reported confidence -> base score, compressed toward the middle
// (0.30-0.60) since self-report alone is weak evidence, not dominant.
// `null` (an unparsed confidence tag) gets the same base as "medium".
export const SELF_REPORT_BASE = { high: 0.6, medium: 0.45, low: 0.3, null: 0.45 };

// +0.15 per additional independently-agreeing model beyond the first.
export const AGREEMENT_BONUS_PER_EXTRA_SOURCE = 0.15;

// Multiplies the raw score based on fact-check outcome. "rejected" doesn't
// go to 0 -- the checker is a simple heuristic and could itself be wrong --
// but 0.08 reflects "direct contradiction against real sourced data" as
// strong negative evidence.
export const FACT_CHECK_MULTIPLIER = { clean: 1.0, caveat: 0.85, rejected: 0.08 };

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

export function round3(n) {
  return Math.round(n * 1000) / 1000;
}

export function bandFor(p) {
  if (p >= 0.75) return "high";
  if (p >= 0.5) return "medium";
  if (p >= 0.25) return "low";
  return "very_low";
}

// confidences: array of "high"|"medium"|"low"|null, one per contributing
// model. numSources: how many models independently named this exact claim.
export function scoreListEntry(confidences, numSources, factCheckStatus) {
  const bases = confidences.map((c) => SELF_REPORT_BASE[c ?? "null"]);
  const selfReportBase = bases.reduce((a, b) => a + b, 0) / bases.length;
  const agreementBonus = (numSources - 1) * AGREEMENT_BONUS_PER_EXTRA_SOURCE;
  const factCheckMultiplier = FACT_CHECK_MULTIPLIER[factCheckStatus];
  const raw = clamp(selfReportBase + agreementBonus, 0, 0.97);
  const probability = clamp(raw * factCheckMultiplier, 0.02, 0.97);
  return { probability, breakdown: { selfReportBase: round3(selfReportBase), agreementBonus: round3(agreementBonus), factCheckMultiplier } };
}

// No cross-model agreement signal for freeform text -- models phrase the
// same idea differently, so exact-match agreement (list entries' strongest
// signal) doesn't apply here. Scored on self-report + fact-check only.
export function scoreFreeformSentence(confidence, flagged) {
  const selfReportBase = SELF_REPORT_BASE[confidence ?? "null"];
  const factCheckMultiplier = flagged ? FACT_CHECK_MULTIPLIER.rejected : FACT_CHECK_MULTIPLIER.clean;
  const probability = clamp(selfReportBase * factCheckMultiplier, 0.02, 0.97);
  return { probability, breakdown: { selfReportBase: round3(selfReportBase), agreementBonus: 0, factCheckMultiplier } };
}

// Groups normalized rows by the exact scenario the live app looks tips up
// by: (cropId, gramZone, season) -> { byQuestion: { questionType: [rows] } }.
export function groupByScenario(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.cropId}|${row.gramZone}|${row.season}`;
    if (!groups.has(key)) {
      groups.set(key, { cropId: row.cropId, cropName: row.cropName, gramZone: row.gramZone, season: row.season, byQuestion: {} });
    }
    const group = groups.get(key);
    group.byQuestion[row.questionType] ??= [];
    group.byQuestion[row.questionType].push(row);
  }
  return groups;
}
