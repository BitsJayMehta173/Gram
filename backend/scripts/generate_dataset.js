// Builds a training dataset for the crop/livestock recommendation ML
// pipeline by sweeping the input space (land size chief among them) through
// the SAME scoring engine the live API uses (scoreEnterprise in
// services/scoring.js) — so this dataset reflects exactly what the app
// currently believes, not a second, hand-written approximation of it.
//
// IMPORTANT — what this dataset IS and ISN'T:
//   IS:  a systematically-generated dataset, grounded in the real cited
//        yield/cost/price figures already in enterprises.json, spanning
//        land size / zone / soil / water / season / budget combinations.
//        Useful for training an initial model to interpolate/generalize
//        across that input space, or to distill the rule engine into a
//        faster model.
//   ISN'T: real observed farm outcomes. No actual farmer's actual yield or
//        profit is in this file. It should eventually be validated against
//        (and ultimately superseded by) real outcome data collected once
//        farmers actually use the tool — see Phase 5 of the roadmap.
//
// Usage: npm run generate-dataset   (from backend/)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import enterpriseData from "../src/data/enterprises.json" with { type: "json" };
import { scoreEnterprise } from "../src/services/scoring.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "../data/training");
const OUT_CSV = path.join(OUT_DIR, "land_recommendation_dataset.csv");
const OUT_README = path.join(OUT_DIR, "README.md");

// ---------- The sweep grid ----------
// Deliberately covers Nepal's realistic smallholder-to-mid-size range
// (0.1 acre kitchen-garden plot up to an 8-acre holding), not just Sunsari's
// Terai — filter zone == "terai" for the Sunsari-relevant subset.
const AREA_ACRE_VALUES = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 8];
const ZONES = ["terai", "hills", "high-hills"];
const SOIL_TYPES = ["alluvial", "loamy", "clayey", "sandy-loam"];
const WATER_SOURCES = ["irrigated", "rainfed"];
const SEASONS = ["kharif", "rabi", "zaid"];
const BUDGETS = [null, 30000, 75000, 150000, 300000]; // null = unconstrained

const CSV_COLUMNS = [
  "scenario_id",
  "area_acre",
  "zone",
  "soil_type",
  "water_source",
  "season",
  "budget_npr",
  "enterprise_id",
  "enterprise_name",
  "category",
  "scales_with",
  "min_area_acre",
  "duration_days",
  "base_cost_per_unit",
  "base_yield_per_unit",
  "yield_unit_label",
  "price_min",
  "price_max",
  "price_volatility",
  "water_dependency",
  "capital_lock_in",
  "eligible",
  "units",
  "cost_npr",
  "yield_total",
  "revenue_min_npr",
  "revenue_max_npr",
  "profit_avg_npr",
  "roi_percent",
  "risk_score",
  "risk_label",
  "agronomic_score",
  "soil_exact_match",
  "water_exact_match",
  "economic_score",
  "risk_pipeline_score",
  "combined_score",
  "affordable",
  "is_best_for_scenario",
];

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildRows() {
  const rows = [];
  let scenarioId = 0;

  for (const areaAcre of AREA_ACRE_VALUES) {
    for (const zone of ZONES) {
      for (const soilType of SOIL_TYPES) {
        for (const waterSource of WATER_SOURCES) {
          for (const season of SEASONS) {
            for (const budget of BUDGETS) {
              scenarioId += 1;
              const ctx = { areaAcre, zone, soilType, waterSource, season };

              const scenarioRows = enterpriseData.enterprises.map((enterprise) => {
                const result = scoreEnterprise(enterprise, ctx, budget);
                return { enterprise, result };
              });

              // Best-for-scenario: highest combined_score among eligible AND
              // (when a budget is set) affordable candidates. Falls back to
              // "eligible only" if nothing fits the budget, so every
              // scenario still has exactly one positive label when at least
              // one candidate is agronomically eligible at all.
              const eligible = scenarioRows.filter((r) => r.result.eligible);
              const affordablePool = eligible.filter((r) => r.result.economics.affordable !== false);
              const pool = affordablePool.length > 0 ? affordablePool : eligible;
              let bestId = null;
              let bestScore = -Infinity;
              for (const r of pool) {
                if (r.result.combinedScore > bestScore) {
                  bestScore = r.result.combinedScore;
                  bestId = r.enterprise.id;
                }
              }

              for (const { enterprise, result } of scenarioRows) {
                rows.push({
                  scenario_id: scenarioId,
                  area_acre: areaAcre,
                  zone,
                  soil_type: soilType,
                  water_source: waterSource,
                  season,
                  budget_npr: budget,
                  enterprise_id: enterprise.id,
                  enterprise_name: enterprise.name,
                  category: enterprise.category,
                  scales_with: enterprise.scalesWith,
                  min_area_acre: enterprise.minAreaAcre,
                  duration_days: enterprise.durationDays,
                  base_cost_per_unit: enterprise.economics.costPerUnit,
                  base_yield_per_unit: enterprise.economics.yieldPerUnit,
                  yield_unit_label: enterprise.economics.yieldUnitLabel,
                  price_min: enterprise.economics.priceMin,
                  price_max: enterprise.economics.priceMax,
                  price_volatility: enterprise.risk.priceVolatility,
                  water_dependency: enterprise.risk.waterDependency,
                  capital_lock_in: enterprise.risk.capitalLockIn,
                  eligible: result.eligible ? 1 : 0,
                  units: result.eligible ? result.economics.units : "",
                  cost_npr: result.eligible ? result.economics.cost : "",
                  yield_total: result.eligible ? result.economics.yieldTotal : "",
                  revenue_min_npr: result.eligible ? result.economics.revenueMin : "",
                  revenue_max_npr: result.eligible ? result.economics.revenueMax : "",
                  profit_avg_npr: result.eligible ? result.economics.profitAvg : "",
                  roi_percent: result.eligible ? result.economics.roiPercent : "",
                  risk_score: result.eligible ? result.riskScore : "",
                  risk_label: result.eligible ? result.riskLabel : "",
                  agronomic_score: result.eligible ? result.pipelines.agronomic.score : "",
                  soil_exact_match: result.eligible ? (result.pipelines.agronomic.soilExact ? 1 : 0) : "",
                  water_exact_match: result.eligible ? (result.pipelines.agronomic.waterExact ? 1 : 0) : "",
                  economic_score: result.eligible ? result.pipelines.economic.score : "",
                  risk_pipeline_score: result.eligible ? result.pipelines.risk.score : "",
                  combined_score: result.eligible ? result.combinedScore : "",
                  affordable:
                    result.eligible && result.economics.affordable !== null
                      ? result.economics.affordable
                        ? 1
                        : 0
                      : "",
                  is_best_for_scenario: enterprise.id === bestId ? 1 : 0,
                });
              }
            }
          }
        }
      }
    }
  }

  return rows;
}

function writeCsv(rows) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((col) => csvCell(row[col])).join(","));
  }
  fs.writeFileSync(OUT_CSV, lines.join("\n") + "\n");
}

function writeReadme(rowCount, scenarioCount) {
  const content = `# Land recommendation training dataset

Generated by \`backend/scripts/generate_dataset.js\` on ${new Date().toISOString()}.

## What this is

A synthetic-but-grounded dataset: every row's cost/yield/price figures trace
back to \`src/data/enterprises.json\` (itself partly grounded in cited
MoALD/NARC/published-study numbers — see that file's \`sources\` fields), run
through the exact same scoring engine (\`scoreEnterprise\` in
\`services/scoring.js\`) that powers the live \`/api/recommendations\`
endpoint. It is **not** real observed farm outcomes — no actual farmer's
actual yield or profit is in this file. Treat it as a starting point for
training a model that interpolates/generalizes across land size, zone, soil,
water, and season — not as ground truth to validate against.

## Shape

- **${rowCount} rows** across **${scenarioCount} scenarios** × ${enterpriseData.enterprises.length} enterprises
  (rice, wheat, maize, millet, lentil, potato, ginger, apple, goat, buffalo, poultry)
- One row = one (land scenario, candidate enterprise) pair
- Sweep dimensions: area_acre (${AREA_ACRE_VALUES.join(", ")} acres), zone, soil_type,
  water_source, season, budget_npr (including unconstrained)
- Filter \`zone == "terai"\` for the Sunsari-relevant subset (Sunsari district
  is entirely Terai)

## Columns

**Scenario inputs**: \`area_acre\`, \`zone\`, \`soil_type\`, \`water_source\`, \`season\`, \`budget_npr\`

**Enterprise's static attributes** (features, constant per enterprise regardless of scenario):
\`enterprise_id\`, \`enterprise_name\`, \`category\`, \`scales_with\`, \`min_area_acre\`,
\`duration_days\`, \`base_cost_per_unit\`, \`base_yield_per_unit\`, \`yield_unit_label\`,
\`price_min\`, \`price_max\`, \`price_volatility\`, \`water_dependency\`, \`capital_lock_in\`

**Computed outcome / labels** (blank when \`eligible == 0\`):
\`eligible\` (hard agronomic gate — the correctness-critical field, see below),
\`units\`, \`cost_npr\`, \`yield_total\`, \`revenue_min_npr\`, \`revenue_max_npr\`,
\`profit_avg_npr\`, \`roi_percent\`, \`risk_score\`, \`risk_label\`, \`agronomic_score\`,
\`soil_exact_match\`, \`water_exact_match\`, \`economic_score\`, \`risk_pipeline_score\`,
\`combined_score\`, \`affordable\` (blank if no budget given), \`is_best_for_scenario\`

## Suggested first modeling tasks

1. **Eligibility classifier** — predict \`eligible\` from scenario + static features.
   Should be near-trivial (it's a deterministic rule today) — a useful sanity
   check that the pipeline/training setup is wired correctly before trying
   harder targets.
2. **Profit/yield regression** — predict \`profit_avg_npr\` or \`yield_total\`
   from scenario + static features, restricted to \`eligible == 1\` rows.
3. **Best-choice ranking** — predict \`is_best_for_scenario\` (1 positive per
   scenario_id group) — the closest task to "what should I plant here."

## Known limitations

- Cost and price figures are still illustrative for most enterprises (see
  \`enterprises.json\`'s \`disclaimer\` and per-enterprise \`sources\` fields) —
  a model trained here inherits that uncertainty.
- No rotation/succession or crop-residue/livestock-integration effects are
  captured (those pipelines don't exist yet) — this dataset only scores one
  season/one enterprise in isolation.
- Budget sweep is coarse (5 tiers including unconstrained) rather than continuous.
`;
  fs.writeFileSync(OUT_README, content);
}

const rows = buildRows();
const scenarioCount = rows.length / enterpriseData.enterprises.length;
writeCsv(rows);
writeReadme(rows.length, scenarioCount);

console.log(`Wrote ${rows.length} rows (${scenarioCount} scenarios x ${enterpriseData.enterprises.length} enterprises)`);
console.log(`  -> ${OUT_CSV}`);
console.log(`  -> ${OUT_README}`);
