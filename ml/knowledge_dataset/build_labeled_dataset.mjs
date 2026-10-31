// Turns the raw qualitative model output into a structured, probabilistically
// SCORED dataset -- one row per individually labeled claim, each with a real
// numeric probability in [0,1] instead of trusting a model's own self-reported
// "confidence: high/medium/low" tag at face value.
//
// Why not just use the self-reported tag directly: already proven unreliable
// in this project. The original motivating error (wheat/mustard wrongly
// claimed to fix nitrogen) was tagged "confidence: high" by the model that
// made it. A labeled dataset that just copies that tag would be laundering a
// known-untrustworthy signal into something that LOOKS quantitative.
//
// What this IS: a transparent, hand-specified scoring formula combining the
// only real signals actually available from this data:
//   1. self-reported confidence (kept, but heavily compressed toward the
//      middle -- weak evidence, not dropped entirely)
//   2. cross-model agreement (the strongest available signal: 2-3
//      independently-prompted models naming the exact same claim is real
//      corroboration a single model's self-report can't provide)
//   3. rule-based fact-check outcome (the one place this pipeline has actual
//      ground truth -- rotation.js's ROTATION_TRAITS -- rather than another
//      layer of unverified text)
//
// What this is NOT: a trained/calibrated probability model. There is no
// outcome data (real yields, real farmer results) to calibrate against --
// see [[project-gram-ml-maturity-staging]]. This is a principled ensemble
// heuristic, not a claim that e.g. "0.87" means "87% of the time this is
// literally true." Treat the resulting probabilityBand (high/medium/low/
// very_low) as the primary signal; the raw number as a ranking tool.
//
// "Fixing" claims the fact-checker catches: rather than only flagging or
// dropping a wrong claim, this script also emits a companion `corrected_fact`
// row sourced directly from rotation.js's real data, so a wrong claim and
// its real correction sit side by side in the same dataset.
//
// Output:
//   labeled_claims.jsonl  -- one row per claim (see SCHEMA below)
//   labeled_claims.csv    -- same data, flattened, for spreadsheet use
//   labeled_dataset_report.json -- score distribution + methodology summary

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import {
  LIST_KEYS,
  FREEFORM_KEYS,
  parseListAnswer,
  parseFreeformAnswer,
  factCheckNitrogenClaim,
  factCheckFreeformText,
  splitSentences,
  loadSourceRows,
  groupByScenario,
  SELF_REPORT_BASE,
  AGREEMENT_BONUS_PER_EXTRA_SOURCE,
  FACT_CHECK_MULTIPLIER,
  bandFor,
  round3,
  scoreListEntry,
  scoreFreeformSentence,
} from "./lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSONL_PATH = path.resolve(__dirname, "labeled_claims.jsonl");
const CSV_PATH = path.resolve(__dirname, "labeled_claims.csv");
const REPORT_PATH = path.resolve(__dirname, "labeled_dataset_report.json");

// SCHEMA (fields present on every row; some are claimType-specific and null
// otherwise):
//   cropId, cropName, gramZone, season, questionType, claimType
//     ("list_entry" | "freeform_sentence" | "corrected_fact")
//   name, detail                 -- list_entry only
//   text, sentenceIndex           -- freeform_sentence / corrected_fact
//   model                         -- single source for freeform_sentence/
//                                    corrected_fact; null for list_entry
//                                    (see `sources` instead)
//   sources, numSources           -- list_entry only: which models named it
//   selfReportedConfidences       -- {model: "high"|"medium"|"low"|null}
//   factCheckStatus                -- "clean" | "caveat" | "rejected"
//   probability                    -- final numeric score, [0.02, 0.97]
//   probabilityBand                -- "high" | "medium" | "low" | "very_low"
//   scoreBreakdown                 -- {selfReportBase, agreementBonus,
//                                      factCheckMultiplier} for transparency

// Scoring formula (SELF_REPORT_BASE, AGREEMENT_BONUS_PER_EXTRA_SOURCE,
// FACT_CHECK_MULTIPLIER, scoreListEntry, scoreFreeformSentence, bandFor)
// now lives in lib.mjs, shared with build_growing_tips.mjs so the live
// app's filtering and this full labeled export can never disagree on a
// given claim's score.

function main() {
  const { rows } = loadSourceRows();
  const groups = groupByScenario(rows);

  const outRows = [];
  const bandCounts = { list_entry: {}, freeform_sentence: {}, corrected_fact: {} };
  let correctedFactsEmitted = 0;

  for (const group of groups.values()) {
    const base = { cropId: group.cropId, cropName: group.cropName, gramZone: group.gramZone, season: group.season };

    // ---- list_entry claims (companion_planting, pest_disease) ----
    for (const questionType of Object.keys(LIST_KEYS)) {
      const rowsForQ = group.byQuestion[questionType] ?? [];
      // name (lowercased) -> { name, detail, byModel: {model: confidence}, factCheckStatus, correctionsToEmit: [] }
      const merged = new Map();
      for (const row of rowsForQ) {
        for (const entry of parseListAnswer(row.answer)) {
          const check = factCheckNitrogenClaim(entry.name, entry.detail);
          const nameKey = entry.name.toLowerCase().trim();
          const status = !check.ok ? "rejected" : check.caveat ? "caveat" : "clean";
          if (!merged.has(nameKey)) {
            merged.set(nameKey, { name: entry.name, detail: entry.detail, byModel: {}, factCheckStatus: status, knownCrop: check.knownCrop ?? null });
          }
          const m = merged.get(nameKey);
          m.byModel[row.model] = entry.confidence;
          // Escalate status if any contributing model's version was rejected/caveated --
          // never let a later "clean" source quietly launder an earlier flagged claim.
          const rank = { clean: 0, caveat: 1, rejected: 2 };
          if (rank[status] > rank[m.factCheckStatus]) m.factCheckStatus = status;
        }
      }
      for (const entry of merged.values()) {
        const sources = Object.keys(entry.byModel);
        const confidences = Object.values(entry.byModel);
        const { probability, breakdown } = scoreListEntry(confidences, sources.length, entry.factCheckStatus);
        const probabilityBand = bandFor(probability);
        bandCounts.list_entry[probabilityBand] = (bandCounts.list_entry[probabilityBand] ?? 0) + 1;
        outRows.push({
          ...base,
          questionType,
          claimType: "list_entry",
          name: entry.name,
          detail: entry.detail,
          text: null,
          sentenceIndex: null,
          model: null,
          sources,
          numSources: sources.length,
          selfReportedConfidences: entry.byModel,
          factCheckStatus: entry.factCheckStatus,
          probability: round3(probability),
          probabilityBand,
          scoreBreakdown: breakdown,
        });

        if (entry.factCheckStatus === "rejected" && entry.knownCrop) {
          correctedFactsEmitted += 1;
          outRows.push({
            ...base,
            questionType,
            claimType: "corrected_fact",
            name: null,
            detail: null,
            text: `"${entry.knownCrop.id}" nitrogenEffect = "${entry.knownCrop.nitrogenEffect}" (sourced from this app's own rotation.js ROTATION_TRAITS, not model output)`,
            sentenceIndex: null,
            model: null,
            sources: ["rule_based_ground_truth"],
            numSources: null,
            selfReportedConfidences: null,
            factCheckStatus: "ground_truth",
            probability: 0.97,
            probabilityBand: "high",
            scoreBreakdown: null,
          });
          bandCounts.corrected_fact.high = (bandCounts.corrected_fact.high ?? 0) + 1;
        }
      }
    }

    // ---- freeform_sentence claims (soil_amendment, rotation_sequence) ----
    for (const questionType of Object.keys(FREEFORM_KEYS)) {
      const rowsForQ = group.byQuestion[questionType] ?? [];
      for (const row of rowsForQ) {
        const parsed = parseFreeformAnswer(row.answer);
        const violations = factCheckFreeformText(parsed.text);
        const flaggedSentences = new Set(violations.map((v) => v.sentence));
        const sentences = splitSentences(parsed.text);
        sentences.forEach((sentence, i) => {
          const flagged = flaggedSentences.has(sentence);
          const { probability, breakdown } = scoreFreeformSentence(parsed.confidence, flagged);
          const probabilityBand = bandFor(probability);
          bandCounts.freeform_sentence[probabilityBand] = (bandCounts.freeform_sentence[probabilityBand] ?? 0) + 1;
          outRows.push({
            ...base,
            questionType,
            claimType: "freeform_sentence",
            name: null,
            detail: null,
            text: sentence,
            sentenceIndex: i,
            model: row.model,
            sources: [row.model],
            numSources: 1,
            selfReportedConfidences: { [row.model]: parsed.confidence },
            factCheckStatus: flagged ? "rejected" : "clean",
            probability: round3(probability),
            probabilityBand,
            scoreBreakdown: breakdown,
          });

          if (flagged) {
            const violation = violations.find((v) => v.sentence === sentence);
            if (violation?.knownCrop) {
              correctedFactsEmitted += 1;
              outRows.push({
                ...base,
                questionType,
                claimType: "corrected_fact",
                name: null,
                detail: null,
                text: `"${violation.knownCrop.id}" nitrogenEffect = "${violation.knownCrop.nitrogenEffect}" (sourced from this app's own rotation.js ROTATION_TRAITS, not model output)`,
                sentenceIndex: null,
                model: null,
                sources: ["rule_based_ground_truth"],
                numSources: null,
                selfReportedConfidences: null,
                factCheckStatus: "ground_truth",
                probability: 0.97,
                probabilityBand: "high",
                scoreBreakdown: null,
              });
              bandCounts.corrected_fact.high = (bandCounts.corrected_fact.high ?? 0) + 1;
            }
          }
        });
      }
    }
  }

  writeFileSync(JSONL_PATH, outRows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  // Flattened CSV for spreadsheet use -- nested fields (sources,
  // selfReportedConfidences, scoreBreakdown) serialized to JSON strings
  // within their cell rather than expanded to columns, so the CSV stays a
  // stable fixed-width shape regardless of how many models a row has.
  const csvColumns = [
    "cropId", "cropName", "gramZone", "season", "questionType", "claimType",
    "name", "detail", "text", "sentenceIndex", "model", "sources", "numSources",
    "selfReportedConfidences", "factCheckStatus", "probability", "probabilityBand",
  ];
  function csvEscape(value) {
    if (value == null) return "";
    const s = typeof value === "object" ? JSON.stringify(value) : String(value);
    return `"${s.replace(/"/g, '""')}"`;
  }
  const csvLines = [csvColumns.join(",")];
  for (const row of outRows) csvLines.push(csvColumns.map((c) => csvEscape(row[c])).join(","));
  writeFileSync(CSV_PATH, csvLines.join("\n") + "\n");

  const totalsByClaimType = { list_entry: 0, freeform_sentence: 0, corrected_fact: 0 };
  for (const r of outRows) totalsByClaimType[r.claimType] += 1;

  const report = {
    generatedAt: new Date().toISOString(),
    methodology: {
      description: "Probabilistic scoring, not a trained/calibrated model -- see file header comment for full rationale and limitations.",
      selfReportBaseScores: SELF_REPORT_BASE,
      agreementBonusPerExtraSource: AGREEMENT_BONUS_PER_EXTRA_SOURCE,
      factCheckMultipliers: FACT_CHECK_MULTIPLIER,
      knownLimitations: [
        "Cross-model agreement bonus only applies to list_entry claims (exact-name matching); freeform_sentence claims have no automated agreement signal since models phrase the same idea differently.",
        "The fact-checker only covers ONE class of error (nitrogen-fixing misattribution against a 17-crop table) -- a 'clean' factCheckStatus means 'not caught by this specific check', not 'verified correct'.",
        "No real-world outcome data exists to calibrate these scores against -- probability values are a ranking/triage tool, not a measured accuracy rate.",
      ],
    },
    totalRows: outRows.length,
    totalsByClaimType,
    correctedFactsEmitted,
    probabilityBandDistribution: bandCounts,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log(`Wrote ${outRows.length} labeled rows to ${JSONL_PATH}`);
  console.log(`  list_entry: ${totalsByClaimType.list_entry}, freeform_sentence: ${totalsByClaimType.freeform_sentence}, corrected_fact: ${totalsByClaimType.corrected_fact}`);
  console.log(`Probability band distribution:`, JSON.stringify(bandCounts, null, 2));
  console.log(`Also wrote ${CSV_PATH} and ${REPORT_PATH}`);
}

main();
