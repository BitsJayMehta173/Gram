// Merges every completed model pass into one fact-checked growing_tips.json
// the live app can serve -- this is the "safe integration" path: don't wait
// for every model to finish, but do cross-check whatever has landed so far
// against both real sourced data and against each other.
//
// Multi-model merge logic:
//   - companion_planting / pest_disease (list answers): entries are parsed
//     per model, fact-checked individually, then merged by name. An entry
//     named by more than one model is marked confirmed -- real cross-model
//     agreement, the strongest signal this pipeline can produce without a
//     human reviewer. An entry only one model named is kept too (never
//     silently drop a single-source claim), just visibly unconfirmed.
//   - soil_amendment / rotation_sequence (freeform paragraphs): can't be
//     merged into one paragraph without inventing a synthesis neither model
//     actually said, so each model's answer is kept side by side, fact-
//     checked independently, and labeled by which model said it.
//
// Shared parsing/fact-check logic lives in lib.mjs (also used by
// build_labeled_dataset.mjs, which turns this same raw data into a
// probabilistically-scored structured dataset instead of the live app's
// tips.json shape -- see that script for the scoring model).
//
// Every surviving entry also gets a probability/probabilityBand attached
// (same formula as build_labeled_dataset.mjs, imported from lib.mjs so the
// two can't disagree) and lists are sorted highest-probability first --
// this is what the frontend (GrowingTips.jsx) uses to show only
// medium+high-band claims by default, with "low" band ones behind a
// "show more" toggle rather than mixed in undifferentiated. Rejected
// entries never reach scoring at all -- already fully excluded above.
//
// Output: growing_tips.json (keyed cropId -> zone -> season -> tips),
// rejected_claims.json (every fact-check rejection/warning, with source
// model), and merge_report.json (coverage + cross-model agreement stats,
// now including the probability-band distribution of what got shipped).

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import {
  MODEL_SOURCES,
  LIST_KEYS,
  FREEFORM_KEYS,
  parseListAnswer,
  parseFreeformAnswer,
  factCheckNitrogenClaim,
  factCheckFreeformText,
  splitSentences,
  loadSourceRows,
  groupByScenario,
  scoreListEntry,
  scoreFreeformSentence,
  bandFor,
  round3,
} from "./lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.resolve(__dirname, "growing_tips.json");
const REJECTED_PATH = path.resolve(__dirname, "rejected_claims.json");
const REPORT_PATH = path.resolve(__dirname, "merge_report.json");

function main() {
  const { rows, perModelRawCount } = loadSourceRows();
  console.log(`Loaded ${rows.length} usable rows across ${Object.keys(perModelRawCount).length} model source(s).`);
  console.log(`Raw rows per model: ${JSON.stringify(perModelRawCount)}`);

  const groups = groupByScenario(rows);

  const tips = {};
  const rejected = [];
  const stats = {
    scenarios: groups.size,
    cropsCovered: new Set(),
    perModel: {},
    listEntries: { total: 0, confirmedByMultipleModels: 0, singleSource: 0, rejected: 0 },
    freeformAnswers: { total: 0, withFactCheckWarning: 0 },
    newFromLatestSource: [],
    probabilityBands: { list_entry: {}, freeform_source: {} },
  };
  const latestModel = MODEL_SOURCES[MODEL_SOURCES.length - 1].model;
  for (const source of MODEL_SOURCES) stats.perModel[source.model] = { listEntries: 0, freeformAnswers: 0, rejected: 0 };

  for (const group of groups.values()) {
    stats.cropsCovered.add(group.cropId);
    tips[group.cropId] ??= {};
    tips[group.cropId][group.gramZone] ??= {};
    const bucket = (tips[group.cropId][group.gramZone][group.season] ??= {});

    for (const [questionType, listKey] of Object.entries(LIST_KEYS)) {
      const rowsForQ = group.byQuestion[questionType] ?? [];
      const merged = new Map();
      for (const row of rowsForQ) {
        for (const entry of parseListAnswer(row.answer)) {
          stats.listEntries.total += 1;
          stats.perModel[row.model].listEntries += 1;
          const check = factCheckNitrogenClaim(entry.name, entry.detail);
          if (!check.ok) {
            stats.listEntries.rejected += 1;
            stats.perModel[row.model].rejected += 1;
            rejected.push({ cropId: group.cropName, zone: group.gramZone, season: group.season, questionType, model: row.model, entry, reason: check.reason });
            continue;
          }
          const nameKey = entry.name.toLowerCase().trim();
          if (!merged.has(nameKey)) {
            merged.set(nameKey, {
              name: entry.name,
              detail: entry.detail,
              confidence: entry.confidence,
              byModel: { [row.model]: entry.confidence },
              factCheckStatus: check.caveat ? "caveat" : "clean",
              factCheckWarnings: check.caveat ? [check.caveat] : [],
            });
          } else {
            const existing = merged.get(nameKey);
            existing.byModel[row.model] = entry.confidence;
            if (check.caveat) existing.factCheckStatus = "caveat";
            if (check.caveat && !existing.factCheckWarnings.includes(check.caveat)) existing.factCheckWarnings.push(check.caveat);
            const rank = { high: 3, medium: 2, low: 1 };
            if ((rank[entry.confidence] ?? 0) > (rank[existing.confidence] ?? 0)) {
              existing.detail = entry.detail;
              existing.confidence = entry.confidence;
            }
          }
        }
      }
      const list = [...merged.values()].map((e) => {
        const sources = Object.keys(e.byModel);
        const { probability } = scoreListEntry(Object.values(e.byModel), sources.length, e.factCheckStatus);
        return {
          name: e.name,
          detail: e.detail,
          confidence: e.confidence,
          sources,
          factCheckWarnings: e.factCheckWarnings,
          confirmed: sources.length > 1,
          probability: round3(probability),
          probabilityBand: bandFor(probability),
        };
      });
      list.sort((a, b) => b.probability - a.probability);
      for (const e of list) {
        if (e.confirmed) stats.listEntries.confirmedByMultipleModels += 1;
        else stats.listEntries.singleSource += 1;
        stats.probabilityBands.list_entry[e.probabilityBand] = (stats.probabilityBands.list_entry[e.probabilityBand] ?? 0) + 1;
        if (e.sources.length === 1 && e.sources[0] === latestModel && MODEL_SOURCES.length > 1) {
          stats.newFromLatestSource.push({ crop: group.cropName, zone: group.gramZone, season: group.season, type: listKey, name: e.name });
        }
      }
      if (list.length > 0) bucket[listKey] = list;
    }

    for (const [questionType, freeformKey] of Object.entries(FREEFORM_KEYS)) {
      const rowsForQ = group.byQuestion[questionType] ?? [];
      const bySource = [];
      for (const row of rowsForQ) {
        stats.freeformAnswers.total += 1;
        stats.perModel[row.model].freeformAnswers += 1;
        const parsed = parseFreeformAnswer(row.answer);
        const violations = factCheckFreeformText(parsed.text);
        if (violations.length > 0) {
          stats.freeformAnswers.withFactCheckWarning += 1;
          for (const v of violations) rejected.push({ cropId: group.cropName, zone: group.gramZone, season: group.season, questionType, model: row.model, sentence: v.sentence, reason: v.reason });
        }
        // Per-sentence scoring, then averaged into one probability for this
        // source's whole paragraph -- prose can't be cleanly redacted
        // sentence-by-sentence without mangling grammar, so filtering here
        // happens at the paragraph level (sort order + a probability the
        // frontend can use to visually de-emphasize a weak source), not by
        // dropping individual sentences.
        const sentences = splitSentences(parsed.text);
        const flaggedSentences = new Set(violations.map((v) => v.sentence));
        const sentenceProbabilities = sentences.map(
          (s) => scoreFreeformSentence(parsed.confidence, flaggedSentences.has(s)).probability
        );
        const probability =
          sentenceProbabilities.length > 0
            ? sentenceProbabilities.reduce((a, b) => a + b, 0) / sentenceProbabilities.length
            : scoreFreeformSentence(parsed.confidence, false).probability;
        const probabilityBand = bandFor(probability);
        stats.probabilityBands.freeform_source[probabilityBand] = (stats.probabilityBands.freeform_source[probabilityBand] ?? 0) + 1;
        bySource.push({
          model: row.model,
          ...parsed,
          factCheckWarnings: violations.map((v) => v.reason),
          probability: round3(probability),
          probabilityBand,
        });
      }
      bySource.sort((a, b) => b.probability - a.probability);
      if (bySource.length > 0) bucket[freeformKey] = { bySource };
    }
  }

  writeFileSync(
    OUTPUT_PATH,
    JSON.stringify(
      {
        generatedFrom: MODEL_SOURCES.filter((s) => stats.perModel[s.model].listEntries > 0 || stats.perModel[s.model].freeformAnswers > 0).map((s) => s.model),
        generatedAt: new Date().toISOString(),
        tips,
      },
      null,
      2
    )
  );
  writeFileSync(REJECTED_PATH, JSON.stringify(rejected, null, 2));

  const report = {
    generatedAt: new Date().toISOString(),
    modelsIncluded: Object.keys(stats.perModel),
    scenarios: stats.scenarios,
    cropsCovered: stats.cropsCovered.size,
    listEntries: stats.listEntries,
    freeformAnswers: stats.freeformAnswers,
    perModel: stats.perModel,
    newFromLatestSourceCount: stats.newFromLatestSource.length,
    newFromLatestSourceSample: stats.newFromLatestSource.slice(0, 25),
    probabilityBands: stats.probabilityBands,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log(`\nScenarios covered: ${stats.scenarios} (${stats.cropsCovered.size} crops)`);
  console.log(`Companion/pest entries: ${stats.listEntries.total} total, ${stats.listEntries.confirmedByMultipleModels} confirmed by 2+ models, ${stats.listEntries.singleSource} single-source, ${stats.listEntries.rejected} rejected by fact-check`);
  console.log(`Freeform answers (soil/rotation): ${stats.freeformAnswers.total} total, ${stats.freeformAnswers.withFactCheckWarning} carry a fact-check warning`);
  console.log(`Per-model breakdown: ${JSON.stringify(stats.perModel, null, 2)}`);
  console.log(`Probability bands shipped: ${JSON.stringify(stats.probabilityBands, null, 2)}`);
  console.log(`New companion/pest entries contributed ONLY by ${latestModel}: ${stats.newFromLatestSource.length}`);
  console.log(`Wrote ${OUTPUT_PATH}, ${REJECTED_PATH}, ${REPORT_PATH}`);
}

main();
