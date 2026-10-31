export const SQM_PER_ACRE = 4046.8564224;
// Simple, transparent heuristic: each point of composite risk (1-5 scale)
// shaves this fraction off profit when ranking "safer bet" order. Not a
// statistical model — just a tunable penalty so risk isn't ignored.
const RISK_PENALTY_PER_POINT = 0.08;

// ---------- Layered scoring: independent pipelines + a transparent combiner ----------
// Each pipeline scores a candidate on ONE dimension only (0-1, higher = better)
// and is returned in full alongside the combined score — never collapsed away.
// That's deliberate: it's what lets a later explanation layer say *why* something
// ranked where it did, and it's what makes the weights tunable/debuggable instead
// of buried inside one opaque model.
const PIPELINE_WEIGHTS = { agronomic: 0.25, economic: 0.45, risk: 0.3 };

// Agronomic fit pipeline — the hard pass/fail gate already happened in
// isEligible(); this scores HOW WELL a already-eligible candidate matches,
// since "technically tolerates this soil" and "this soil is its ideal match"
// shouldn't rank the same.
function agronomicPipeline(enterprise, ctx) {
  const soilExact = enterprise.soilTypes.includes(ctx.soilType);
  const waterExact = enterprise.waterSources.includes(ctx.waterSource);
  let score = 0.5;
  if (soilExact) score += 0.25;
  if (waterExact) score += 0.25;
  return {
    score: Math.round(Math.min(1, score) * 100) / 100,
    soilExact,
    waterExact,
    reasons: [
      soilExact ? `Directly suited to ${ctx.soilType} soil` : `Only broadly tolerant of ${ctx.soilType} soil`,
      waterExact ? `Directly suited to ${ctx.waterSource} water` : `Only broadly tolerant of ${ctx.waterSource} water`,
    ],
  };
}

// Economic pipeline's score: ROI% squashed to 0-1, saturating around 250% ROI.
// The raw cost/revenue/profit numbers travel separately — this is only the
// normalized signal used for ranking/combining.
function economicPipelineScore(roiPercent) {
  if (roiPercent == null) return 0.5;
  return Math.round(Math.max(0, Math.min(1, roiPercent / 250)) * 100) / 100;
}

// Risk pipeline's score: composite risk (1-5, higher = riskier) inverted to
// 0-1 (higher = safer), so every pipeline shares the same "higher is better"
// convention going into the combiner.
function riskPipelineScore(risk) {
  return Math.round(Math.max(0, Math.min(1, (5 - risk) / 4)) * 100) / 100;
}

function combinedScoreFrom(agronomicScore, economicScoreVal, riskScoreVal) {
  const raw =
    agronomicScore * PIPELINE_WEIGHTS.agronomic +
    economicScoreVal * PIPELINE_WEIGHTS.economic +
    riskScoreVal * PIPELINE_WEIGHTS.risk;
  return Math.round(raw * 1000) / 1000;
}

function isEligible(enterprise, { season, soilType, waterSource, areaAcre, zone }) {
  if (!enterprise.zones.includes(zone)) return false;
  if (!enterprise.seasons.includes(season)) return false;
  if (!enterprise.soilTypes.includes(soilType) && !enterprise.soilTypes.includes("any")) return false;
  if (!enterprise.waterSources.includes(waterSource) && !enterprise.waterSources.includes("any")) return false;
  if (areaAcre < enterprise.minAreaAcre) return false;
  return true;
}

function compositeRisk(enterprise) {
  const r = enterprise.risk;
  return (r.priceVolatility + r.waterDependency + r.capitalLockIn) / 3;
}

function riskLabel(score) {
  if (score <= 2.2) return "Low";
  if (score <= 3.4) return "Medium";
  return "High";
}

function riskAdjust(profit, riskScore) {
  return Math.round(profit * (1 - RISK_PENALTY_PER_POINT * riskScore));
}

function economicsForUnits(enterprise, units) {
  const e = enterprise.economics;
  const cost = e.costPerUnit * units;
  const yieldTotal = e.yieldPerUnit * units;
  const priceAvg = (e.priceMin + e.priceMax) / 2;
  const revenueMin = yieldTotal * e.priceMin;
  const revenueMax = yieldTotal * e.priceMax;
  const revenueAvg = yieldTotal * priceAvg;
  const profitAvg = revenueAvg - cost;
  return { units, cost, yieldTotal, revenueMin, revenueMax, profitAvg };
}

// Units for dedicating the *entire* available area/budget to one enterprise.
function resolveUnitsForFullArea(enterprise, areaAcre, budget) {
  if (enterprise.scalesWith === "area") {
    return enterprise.maxAreaAcre ? Math.min(areaAcre, enterprise.maxAreaAcre) : areaAcre;
  }
  const maxUnitsBySpace = Math.floor(areaAcre / enterprise.minAreaAcre);
  const maxUnitsByBudget = budget != null ? Math.floor(budget / enterprise.economics.costPerUnit) : null;
  return Math.max(
    1,
    maxUnitsByBudget != null ? Math.min(maxUnitsBySpace, maxUnitsByBudget) : Math.min(maxUnitsBySpace, 1)
  );
}

function explainSingle(enterprise, econ, riskScore, { season }) {
  return `${enterprise.name} fits your ${season} season plot with ${econ.units} ${econ.unitLabel}${
    econ.units === 1 ? "" : "s"
  } of scale. Estimated cost NPR ${econ.cost.toLocaleString("en-IN")}, revenue NPR ${econ.revenueMin.toLocaleString(
    "en-IN"
  )}–NPR ${econ.revenueMax.toLocaleString("en-IN")}, average profit NPR ${econ.profitAvg.toLocaleString(
    "en-IN"
  )} over ~${enterprise.durationDays} days (${riskLabel(riskScore).toLowerCase()} risk).`;
}

// The single source of truth for "how good is this one enterprise for this
// one scenario" — used by both the live API (getRecommendations, below) and
// the offline dataset generator (scripts/generate_dataset.js), so the two
// can never silently drift apart. Returns { eligible: false } immediately
// for anything that fails the hard agronomic gate.
export function scoreEnterprise(enterprise, ctx, budget) {
  if (!isEligible(enterprise, ctx)) {
    return { eligible: false, id: enterprise.id, name: enterprise.name, category: enterprise.category };
  }

  const units = resolveUnitsForFullArea(enterprise, ctx.areaAcre, budget);
  const { units: u, cost, yieldTotal, revenueMin, revenueMax, profitAvg } = economicsForUnits(enterprise, units);
  const roiPercent = cost > 0 ? (profitAvg / cost) * 100 : null;
  const affordable = budget == null ? null : cost <= budget;
  const risk = compositeRisk(enterprise);
  const econ = {
    units: Math.round(u * 100) / 100,
    unitLabel: enterprise.economics.unit,
    cost: Math.round(cost),
    yieldTotal: Math.round(yieldTotal * 100) / 100,
    yieldUnitLabel: enterprise.economics.yieldUnitLabel,
    revenueMin: Math.round(revenueMin),
    revenueMax: Math.round(revenueMax),
    profitAvg: Math.round(profitAvg),
    roiPercent: roiPercent != null ? Math.round(roiPercent * 10) / 10 : null,
    affordable,
  };

  // Three independent pipelines, each scoring one dimension only...
  const agronomic = agronomicPipeline(enterprise, ctx);
  const economicScoreVal = economicPipelineScore(econ.roiPercent);
  const riskScoreVal = riskPipelineScore(risk);
  // ...combined here, transparently, rather than inside a single model.
  const combinedScore = combinedScoreFrom(agronomic.score, economicScoreVal, riskScoreVal);

  return {
    eligible: true,
    id: enterprise.id,
    name: enterprise.name,
    category: enterprise.category,
    durationDays: enterprise.durationDays,
    notes: enterprise.notes,
    economics: econ,
    riskScore: Math.round(risk * 10) / 10,
    riskLabel: riskLabel(risk),
    riskAdjustedProfit: riskAdjust(econ.profitAvg, risk),
    explanation: explainSingle(enterprise, econ, risk, { season: ctx.season }),
    pipelines: {
      agronomic,
      production: {
        units: econ.units,
        unitLabel: econ.unitLabel,
        yieldTotal: econ.yieldTotal,
        yieldUnitLabel: econ.yieldUnitLabel,
      },
      economic: {
        cost: econ.cost,
        revenueMin: econ.revenueMin,
        revenueMax: econ.revenueMax,
        profitAvg: econ.profitAvg,
        roiPercent: econ.roiPercent,
        affordable: econ.affordable,
        score: economicScoreVal,
      },
      risk: { score: riskScoreVal, riskScore: Math.round(risk * 10) / 10, riskLabel: riskLabel(risk) },
    },
    combinedScore,
  };
}

export { PIPELINE_WEIGHTS };

// The flat, one-row-per-enterprise list — useful as a reference/detail view
// alongside the land-allocation plans below.
export function getRecommendations({ areaSqm, soilType, waterSource, season, budget, zone }, enterpriseData) {
  const areaAcre = areaSqm / SQM_PER_ACRE;
  const ctx = { season, soilType, waterSource, areaAcre, zone };

  const scored = enterpriseData.enterprises
    .map((e) => scoreEnterprise(e, ctx, budget))
    .filter((r) => r.eligible)
    .sort((a, b) => {
      const affA = a.economics.affordable === false ? 0 : 1;
      const affB = b.economics.affordable === false ? 0 : 1;
      if (affA !== affB) return affB - affA;
      return b.combinedScore - a.combinedScore;
    });

  return { areaAcre: Math.round(areaAcre * 100) / 100, weights: PIPELINE_WEIGHTS, recommendations: scored };
}

// ---------- Land allocation plans ----------

export function buildComponents(items, areaAcre) {
  // items: [{ enterprise, share }] for crops, or [{ enterprise, units }] for livestock
  return items.map(({ enterprise, share, units }) => {
    const resolvedUnits = share != null ? areaAcre * share : units;
    const econ = economicsForUnits(enterprise, resolvedUnits);
    return { enterprise, share: share ?? null, econ, risk: compositeRisk(enterprise) };
  });
}

// ---------- Companion planting (intercropping) ----------
// Distinct from ROTATION_TRAITS/rotation.js above: this scores crops grown
// SIMULTANEOUSLY on different segments of the same plot in the same
// season, not crops grown in sequence across seasons. A deliberately
// short, individually-justified starter set of well-established, multiply-
// documented relationships -- the same "narrow allowlist, not a blanket
// rule" discipline rotation.js uses for DISEASE_RISK_FAMILIES, meant to
// grow via real sourced research (see the sibling nepal_agri_ai project)
// rather than a large invented table. Every pair here is checked against
// this file's own zone/season/soil eligibility data before it can ever
// apply -- e.g. banana+ginger and banana+turmeric (banana understory
// shade-cropping, well documented in Nepal's mid-hills) are deliberately
// NOT included yet because this file's banana entry is zoned terai-only,
// so the pair could never actually fire; worth adding once that's
// expanded with real research rather than shipping a dead relationship.
export const COMPANION_RELATIONSHIPS = [
  {
    pair: ["maize", "cowpea"],
    effect: "synergy",
    magnitude: 1.08,
    mechanism:
      "Cereal-legume intercropping: cowpea fixes atmospheric nitrogen that partly offsets maize's heavy nitrogen draw, and the two occupy different canopy layers so light competition is limited. One of the most widely documented intercropping systems worldwide.",
  },
  {
    pair: ["maize", "soybean"],
    effect: "synergy",
    magnitude: 1.08,
    mechanism: "Same cereal-legume nitrogen-sharing and canopy-layering mechanism as maize+cowpea.",
  },
  {
    pair: ["maize", "pigeon_pea"],
    effect: "synergy",
    magnitude: 1.1,
    mechanism:
      "Pigeon pea's deep root system draws water and nutrients from a different soil depth than maize's shallower roots, on top of nitrogen fixation -- a standard cereal-legume intercrop across South Asia.",
  },
  {
    pair: ["sugarcane", "lentil"],
    effect: "synergy",
    magnitude: 1.05,
    mechanism:
      "Sugarcane has a ~4-5 month juvenile period before canopy closure; growing a short-duration legume in the row middles during that window is standard relay-intercropping practice and adds a harvest without displacing the sugarcane.",
  },
  {
    pair: ["marigold", "tomato"],
    effect: "synergy",
    magnitude: 1.05,
    mechanism:
      "Marigold roots release compounds (alpha-terthienyl) documented to suppress root-knot nematodes, a major tomato pest, when interplanted or used as a border -- one of the more rigorously studied companion-planting effects (nematology research, not folk wisdom).",
  },
  {
    pair: ["marigold", "cauliflower"],
    effect: "synergy",
    magnitude: 1.04,
    mechanism: "Marigold's scent is documented to deter some brassica pests (aphids, whitefly) as a border/companion planting.",
  },
  {
    pair: ["marigold", "cabbage"],
    effect: "synergy",
    magnitude: 1.04,
    mechanism: "Same pest-deterrent border-planting relationship as marigold+cauliflower.",
  },
  {
    pair: ["sunflower", "maize"],
    effect: "caution",
    magnitude: 0.95,
    mechanism:
      "Sunflower is documented to release allelopathic compounds that can suppress the growth of some neighboring crops when planted too close -- a real but modest effect, so this is a caution rather than a hard exclusion.",
  },
];

function findCompanionMatches(components) {
  const ids = new Set(components.map((c) => c.enterprise.id));
  const nameById = new Map(components.map((c) => [c.enterprise.id, c.enterprise.name]));
  return COMPANION_RELATIONSHIPS.filter((rel) => ids.has(rel.pair[0]) && ids.has(rel.pair[1])).map((rel) => ({
    crops: rel.pair,
    cropNames: rel.pair.map((id) => nameById.get(id)),
    effect: rel.effect,
    magnitude: rel.magnitude,
    mechanism: rel.mechanism,
  }));
}

// Multiple simultaneous matches multiply together, but clamped to a modest
// band -- with only a handful of narrow, evidenced relationships in the
// list above, stacking three or four at once should never happen in
// practice, but the clamp keeps this from compounding into something
// implausible if it ever does.
function companionMultiplier(matches) {
  if (matches.length === 0) return 1;
  const raw = matches.reduce((m, rel) => m * rel.magnitude, 1);
  return Math.max(0.85, Math.min(1.2, raw));
}

export function summarizePlan(components, budget) {
  const totalCost = components.reduce((s, c) => s + c.econ.cost, 0);
  const baseProfitAvg = components.reduce((s, c) => s + c.econ.profitAvg, 0);
  const companionMatches = findCompanionMatches(components);
  const totalProfitAvg = Math.round(baseProfitAvg * companionMultiplier(companionMatches));
  const totalRevenueMin = components.reduce((s, c) => s + c.econ.revenueMin, 0);
  const totalRevenueMax = components.reduce((s, c) => s + c.econ.revenueMax, 0);
  const weightedRisk =
    totalCost > 0
      ? components.reduce((s, c) => s + c.risk * c.econ.cost, 0) / totalCost
      : components.reduce((s, c) => s + c.risk, 0) / components.length;
  const roiPercent = totalCost > 0 ? (totalProfitAvg / totalCost) * 100 : null;

  return {
    totalCost: Math.round(totalCost),
    baseProfitAvg: Math.round(baseProfitAvg),
    totalProfitAvg,
    companionMatches,
    totalRevenueMin: Math.round(totalRevenueMin),
    totalRevenueMax: Math.round(totalRevenueMax),
    roiPercent: roiPercent != null ? Math.round(roiPercent * 10) / 10 : null,
    riskScore: Math.round(weightedRisk * 10) / 10,
    riskLabel: riskLabel(weightedRisk),
    riskAdjustedProfit: riskAdjust(totalProfitAvg, weightedRisk),
    affordable: budget == null ? null : totalCost <= budget,
  };
}

function planId(components) {
  return components
    .map((c) => (c.share != null ? `${c.enterprise.id}:${Math.round(c.share * 100)}` : `${c.enterprise.id}:unit`))
    .sort()
    .join("+");
}

function leftoverAreaAcre(components, areaAcre) {
  const usedShare = components.filter((c) => c.share != null).reduce((s, c) => s + c.share, 0);
  const leftover = areaAcre * (1 - usedShare);
  return leftover > 0.01 ? Math.round(leftover * 100) / 100 : 0;
}

function explainPlan(components, summary, leftover) {
  const compStr = components
    .map((c) => (c.share != null ? `${Math.round(c.share * 100)}% ${c.enterprise.name}` : `1 ${c.enterprise.name}`))
    .join(" + ");
  const fallowNote = leftover > 0 ? ` ${leftover} acre left fallow this season (budget-limited).` : "";
  const companionNote =
    summary.companionMatches.length > 0
      ? ` ${summary.companionMatches.length === 1 ? "Includes 1 companion-planting effect" : `Includes ${summary.companionMatches.length} companion-planting effects`} (see below).`
      : "";
  return `${compStr} — est. cost NPR ${summary.totalCost.toLocaleString(
    "en-IN"
  )}, profit NPR ${summary.totalProfitAvg.toLocaleString("en-IN")} (${summary.riskLabel.toLowerCase()} risk).${fallowNote}${companionNote}`;
}

export function toPlanView(components, summary, areaAcre) {
  const leftover = leftoverAreaAcre(components, areaAcre);
  return {
    id: planId(components),
    components: components.map((c) => ({
      id: c.enterprise.id,
      name: c.enterprise.name,
      category: c.enterprise.category,
      shareLabel:
        c.share != null
          ? `${Math.round(c.share * 100)}% of land`
          : `${c.econ.units === 1 ? "1" : c.econ.units} × ${c.enterprise.economics.unit}`,
      // Raw 0-1 fraction (null for livestock, which scales with budget/units
      // rather than a land share) -- kept alongside the rounded display
      // fields above so a geometric partition can use the exact figure
      // instead of re-deriving it from a rounded areaAcre.
      share: c.share ?? null,
      areaAcre: c.share != null ? Math.round(areaAcre * c.share * 100) / 100 : null,
      cost: Math.round(c.econ.cost),
      profitAvg: Math.round(c.econ.profitAvg),
      riskLabel: riskLabel(c.risk),
    })),
    leftoverAreaAcre: leftover,
    ...summary,
    explanation: explainPlan(components, summary, leftover),
  };
}

// ---------- Land-size tiers ----------
// A 0.1-acre kitchen garden and a 15-acre farm need fundamentally different
// advice, not the same "maximize profit, split into two crops" plan just
// scaled down. These thresholds are a starting judgment call (documented
// here so they're easy to retune later), not derived from a dataset:
//   - micro  (< 0.5 acre, ~4 ropani):  a homestead plot. Priority is
//     household food security -- enough variety to feed the family --
//     over squeezing maximum cash profit from one dominant crop.
//   - small  (0.5-2 acres, ~4-16 ropani): still close to subsistence, but
//     with room for a real marketable surplus alongside food crops.
//   - medium (2-10 acres): primarily commercial; the priority is a
//     genuinely diversified, non-redundant set of options.
//   - large  (10+ acres): can support real segmentation into several
//     blocks, each carrying a different enterprise.
const LAND_TIER_THRESHOLDS_ACRE = { micro: 0.5, small: 2, medium: 10 };

export function classifyLandTier(areaAcre) {
  if (areaAcre < LAND_TIER_THRESHOLDS_ACRE.micro) return "micro";
  if (areaAcre < LAND_TIER_THRESHOLDS_ACRE.small) return "small";
  if (areaAcre < LAND_TIER_THRESHOLDS_ACRE.medium) return "medium";
  return "large";
}

// shortlistSize values were tuned back when enterprises.json held ~78
// crops; the catalog has since grown to 126+ (see the 57-crop integration
// pass). Left at the old sizes, only the same ~10 profit-leading crops ever
// entered the multi-crop-split combinatorics, silently squeezing out real,
// well-known, agronomically-valid crops (sugarcane/potato/jute and similar
// higher-cost staples) purely because dozens of newer, often higher-B:C
// crops now out-rank them on the pure profit sort before they even get
// tried in a combination. Raised roughly in proportion to the catalog's
// growth so a meaningfully wider slice of what's actually eligible gets a
// chance to surface, not just the same repeat winners.
const TIER_CONFIG = {
  micro: {
    label: "Homestead plot",
    note: "Under 0.5 acre — plans favor food variety for the household over one dominant cash crop.",
    shortlistSize: 12,
    splitSizes: [2, 3, 4],
    prioritize: "diversity",
  },
  small: {
    label: "Small holding",
    note: "0.5–2 acres — a mix of food crops and marketable surplus, spread so one bad season doesn't wipe out the whole plot.",
    shortlistSize: 16,
    splitSizes: [2, 3],
    prioritize: "profit",
  },
  medium: {
    label: "Medium farm",
    note: "2–10 acres — enough room to diversify across the season without every plan repeating the same one or two crops.",
    shortlistSize: 18,
    splitSizes: [2, 3],
    prioritize: "profit",
  },
  large: {
    label: "Large farm",
    note: "10+ acres — segmented into several blocks so a price swing in one crop doesn't sink the whole plot.",
    shortlistSize: 16,
    splitSizes: [3, 4, 5],
    prioritize: "profit",
  },
};

export function describeLandTier(areaAcre) {
  const tier = classifyLandTier(areaAcre);
  const { label, note } = TIER_CONFIG[tier];
  return { tier, label, note };
}

// Which crops are even worth combining. Keeps N-way combinatorics bounded
// (12 choose 4 is fine; 75 choose 4 is not) and, for the "diversity"
// tier, actively shapes the shortlist toward variety instead of just the
// N cheapest or N most-profitable crops overall.
function shortlistCrops(crops, monocropProfitById, tier) {
  const cfg = TIER_CONFIG[tier];
  if (cfg.prioritize === "diversity") {
    // Cheapest + fastest-to-harvest first (gets food on the table sooner,
    // ties up less of a small household's cash) -- capped per category so
    // the shortlist itself spans food groups instead of filling up with,
    // say, six leafy vegetables.
    const sorted = [...crops].sort((a, b) => {
      const byDuration = a.durationDays - b.durationDays;
      if (byDuration !== 0) return byDuration;
      return a.economics.costPerUnit - b.economics.costPerUnit;
    });
    const perCategoryCap = 2;
    const catCount = new Map();
    const shortlist = [];
    for (const c of sorted) {
      const n = catCount.get(c.category) ?? 0;
      if (n >= perCategoryCap) continue;
      catCount.set(c.category, n + 1);
      shortlist.push(c);
      if (shortlist.length >= cfg.shortlistSize) break;
    }
    return shortlist;
  }
  return [...crops]
    .sort((a, b) => (monocropProfitById.get(b.id) ?? -Infinity) - (monocropProfitById.get(a.id) ?? -Infinity))
    .slice(0, cfg.shortlistSize);
}

function combinations(arr, k) {
  const results = [];
  function helper(start, combo) {
    if (combo.length === k) {
      results.push(combo.slice());
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      helper(i + 1, combo);
      combo.pop();
    }
  }
  helper(0, []);
  return results;
}

// Canonical share vectors per split size (each sums to ~1). Kept as a
// short, fixed menu per k rather than arbitrary ratios so the combinatorics
// (combos x vectors) stay bounded -- see shortlistCrops above.
const SHARE_VECTORS = {
  2: [
    [0.5, 0.5],
    [0.7, 0.3],
    [0.3, 0.7],
  ],
  3: [
    [0.5, 0.3, 0.2],
    [0.34, 0.33, 0.33],
  ],
  4: [
    [0.4, 0.3, 0.2, 0.1],
    [0.25, 0.25, 0.25, 0.25],
  ],
  5: [
    [0.32, 0.27, 0.2, 0.13, 0.08],
    [0.2, 0.2, 0.2, 0.2, 0.2],
  ],
};

// Every k-crop combination from the shortlist, at each of that k's share
// vectors. Within one combination, whichever crop performs best alone
// leads (gets the largest share in that vector) -- a simple, explainable
// rule that avoids permuting all k! share assignments per combination.
function buildSplitPlans(shortlist, k, areaAcre, budget, monocropProfitById) {
  const vectors = SHARE_VECTORS[k] ?? [];
  const plans = [];
  for (const combo of combinations(shortlist, k)) {
    const ordered = [...combo].sort(
      (a, b) => (monocropProfitById.get(b.id) ?? -Infinity) - (monocropProfitById.get(a.id) ?? -Infinity)
    );
    for (const vector of vectors) {
      const items = ordered.map((enterprise, idx) => ({ enterprise, share: vector[idx] }));
      const components = buildComponents(items, areaAcre);
      plans.push({ components, summary: summarizePlan(components, budget) });
    }
  }
  return plans;
}

function planCategoryCoverage(components) {
  return new Set(components.map((c) => c.enterprise.category)).size;
}

// Same "affordable first" rule for every tier; tiers that prioritize
// household variety over profit (see TIER_CONFIG) also rank by how many
// distinct categories a plan covers before falling back to risk-adjusted
// profit -- so a 3-vegetable-1-pulse plan outranks 3 vegetables that all
// do the same job on the family's plate.
function comparePlansForTier(tier) {
  const prioritizeDiversity = TIER_CONFIG[tier].prioritize === "diversity";
  return (a, b) => {
    const affA = a.summary.affordable === false ? 0 : 1;
    const affB = b.summary.affordable === false ? 0 : 1;
    if (affA !== affB) return affB - affA;
    if (prioritizeDiversity) {
      const covDiff = planCategoryCoverage(b.components) - planCategoryCoverage(a.components);
      if (covDiff !== 0) return covDiff;
    }
    return b.summary.riskAdjustedProfit - a.summary.riskAdjustedProfit;
  };
}

// Final top-N selection: rank by the tier's rule, but cap how many times
// any single crop can appear across the returned set. Without this cap,
// the two or three best-scoring crops dominate every slot (e.g. "maize"
// and "wheat" alone, plus every ratio split of maize+wheat) -- correct
// individually, but it reads as the same recommendation repeated rather
// than a real set of distinct choices. Falls back to filling remaining
// slots from the capped-out overflow if the eligible pool is too small to
// stay diverse, so the result is never smaller than the pool allows.
//
// `globalCropCount` (optional) is a Map the CALLER owns and mutates across
// several selectDiverse calls -- see buildScenarios below, where it's what
// stops one genuinely strong crop from anchoring every single scenario.
// `globalMaxPerCrop` is the cap against THAT shared map; maxPerCrop/limit
// stay scoped to this one call, exactly as before.
function selectDiverse(pool, rankFn, maxPerCrop, limit, globalCropCount, globalMaxPerCrop) {
  const ranked = [...pool].sort(rankFn);
  const seenPlanIds = new Set();
  const localCropCount = new Map();
  const selected = [];
  const overflow = [];

  for (const plan of ranked) {
    const id = planId(plan.components);
    if (seenPlanIds.has(id)) continue;
    seenPlanIds.add(id);

    const cropIds = plan.components.map((c) => c.enterprise.id);
    const wouldExceedLocal = cropIds.some((cid) => (localCropCount.get(cid) ?? 0) >= maxPerCrop);
    const wouldExceedGlobal =
      globalCropCount && globalMaxPerCrop != null && cropIds.some((cid) => (globalCropCount.get(cid) ?? 0) >= globalMaxPerCrop);
    if (wouldExceedLocal || wouldExceedGlobal) {
      overflow.push(plan);
      continue;
    }
    selected.push(plan);
    for (const cid of cropIds) localCropCount.set(cid, (localCropCount.get(cid) ?? 0) + 1);
    if (selected.length >= limit) break;
  }
  for (const plan of overflow) {
    if (selected.length >= limit) break;
    selected.push(plan);
  }
  if (globalCropCount) {
    for (const plan of selected) {
      for (const c of plan.components) globalCropCount.set(c.enterprise.id, (globalCropCount.get(c.enterprise.id) ?? 0) + 1);
    }
  }
  return selected;
}

// ---------- Scenario-based final selection ----------
// Ranking every candidate plan by one objective (profit) and capping
// repeats was still "greedy with one lens" -- a farmer weighing tradeoffs
// wants to see the actual tradeoffs, not one blended list. So the final
// step doesn't produce one ranked list; it runs the SAME pool through
// three different, named objectives and returns each one's own top picks.
// The underlying economics (cost/revenue/profit) are identical everywhere
// -- only the ranking rule and the diversity cap differ per scenario.

// How much genuine risk-spreading a plan provides. Not just "more than one
// crop" -- crops whose risk PROFILES actually differ (price volatility,
// water dependency, capital lock-in), since two crops that are both
// high-price-volatility don't protect a farmer from a price swing the way
// one high-volatility + one low-volatility crop would. Variance across
// each risk dimension, plus category/crop-count variety, blended into a
// bonus multiplier applied to risk-adjusted profit -- so "diversified"
// ranking still respects economics, it just also rewards genuine spread.
function diversificationScore(components) {
  if (components.length <= 1) return 0;
  const dims = ["priceVolatility", "waterDependency", "capitalLockIn"];
  let spread = 0;
  for (const dim of dims) {
    const values = components.map((c) => c.enterprise.risk[dim]);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    spread += values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  }
  const categoryCoverage = new Set(components.map((c) => c.enterprise.category)).size;
  return (
    Math.min(1, spread / 6) * 0.5 +
    Math.min(1, (categoryCoverage - 1) / 3) * 0.3 +
    Math.min(1, (components.length - 1) / 3) * 0.2
  );
}

// `sat(plan)` is the market-saturation multiplier (see marketBalance.js) --
// 1.0 by default (no data / not wired up), dipping toward 0.85 the more a
// plan's crops have been recommended recently in this zone. Deliberately
// only ever multiplies into RANKING here, never into the plan's own
// displayed cost/profit/revenue (computed once in summarizePlan, upstream
// of this file entirely) -- "other users were told this too" is a
// diversification signal, not a claim about the crop's real economics.
const SCENARIOS = [
  {
    key: "maxProfit",
    label: "Maximum profit",
    description: "Ranked purely by expected return — the highest-earning options, whatever the mix.",
    maxPerCrop: 2,
    compare: (a, b, sat) => b.summary.riskAdjustedProfit * sat(b) - a.summary.riskAdjustedProfit * sat(a),
  },
  {
    key: "diversified",
    label: "Diversified portfolio",
    description:
      "Favors spreading land across genuinely different crops and risk types, even at some cost to peak profit — so one bad season or one crashed price doesn't take out the whole plot.",
    maxPerCrop: 1, // force genuinely distinct crops across this scenario's own picks
    compare: (a, b, sat) => {
      const scoreA = a.summary.riskAdjustedProfit * (1 + diversificationScore(a.components)) * sat(a);
      const scoreB = b.summary.riskAdjustedProfit * (1 + diversificationScore(b.components)) * sat(b);
      return scoreB - scoreA;
    },
  },
  {
    key: "lowRisk",
    label: "Lowest risk",
    description: "Ranked by composite risk first, profit second — the safest bets for a farmer who can't absorb a bad season.",
    maxPerCrop: 2,
    compare: (a, b, sat) => {
      if (a.summary.riskScore !== b.summary.riskScore) return a.summary.riskScore - b.summary.riskScore;
      return b.summary.riskAdjustedProfit * sat(b) - a.summary.riskAdjustedProfit * sat(a);
    },
  },
];

function planSaturation(components, saturationLookup) {
  if (!saturationLookup || components.length === 0) return 1;
  const values = components.map((c) => saturationLookup(c.enterprise.id));
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// A crop that's genuinely the best pick on every axis (profit AND risk AND
// diversification) would otherwise legitimately win all three scenarios --
// individually correct, but it defeats the entire point of having three
// scenarios: they're supposed to read as three different ideas, not the
// same anchor crop three times with a different side dish. This shared
// counter (mutated across the SCENARIOS.map below, in order) caps how many
// of the 6 total plan slots any one crop can occupy, so "maximum profit",
// "diversified", and "lowest risk" are forced to actually diverge from
// each other whenever a reasonable alternative exists -- falling back to
// the repeat only when selectDiverse's own overflow logic finds nothing
// else viable, exactly like the within-scenario cap already does.
const GLOBAL_MAX_PER_CROP = 2;

function buildScenarios(pool, areaAcre, saturationLookup) {
  const sat = (plan) => planSaturation(plan.components, saturationLookup);
  const globalCropCount = new Map();
  return SCENARIOS.map((scenario) => {
    const rankFn = (a, b) => {
      const affA = a.summary.affordable === false ? 0 : 1;
      const affB = b.summary.affordable === false ? 0 : 1;
      if (affA !== affB) return affB - affA;
      return scenario.compare(a, b, sat);
    };
    const selected = selectDiverse(pool, rankFn, scenario.maxPerCrop, 2, globalCropCount, GLOBAL_MAX_PER_CROP);
    return {
      key: scenario.key,
      label: scenario.label,
      description: scenario.description,
      plans: selected.map((plan) => ({
        ...toPlanView(plan.components, plan.summary, areaAcre),
        marketSaturation: Math.round(sat(plan) * 100) / 100,
      })),
    };
  });
}

// The candidate-pool-building step shared by generateAllocationPlans (below,
// grouped into profit/diversified/lowRisk scenarios) and generateFieldLayouts
// (fieldLayouts.js, grouped by land-productivity instead) -- both start from
// exactly the same set of structurally-valid spatial splits for this plot;
// they differ only in how they SELECT and PRESENT from that pool, not in
// what's eligible to be in it. Extracted here so that decision (what counts
// as a valid split) can never silently drift between the two callers.
export function buildCandidatePool({ areaSqm, soilType, waterSource, season, budget, zone }, enterpriseData) {
  const areaAcre = areaSqm / SQM_PER_ACRE;
  const ctx = { season, soilType, waterSource, areaAcre, zone };
  const tier = classifyLandTier(areaAcre);
  const tierCfg = TIER_CONFIG[tier];

  const crops = enterpriseData.enterprises.filter((e) => e.scalesWith === "area" && isEligible(e, ctx));
  const livestock = enterpriseData.enterprises.filter((e) => e.scalesWith === "budget" && isEligible(e, ctx));

  const pool = [];
  const monocropProfitById = new Map();

  // Monocrop: 100% of land to one crop. Runs over every eligible crop (not
  // just the shortlist below) since it also seeds monocropProfitById,
  // which both the shortlist ranking and the split-builder depend on.
  for (const crop of crops) {
    const components = buildComponents([{ enterprise: crop, share: 1 }], areaAcre);
    const summary = summarizePlan(components, budget);
    monocropProfitById.set(crop.id, summary.totalProfitAvg);
    pool.push({ components, summary });
  }

  // N-way splits: which split sizes are even considered, and which crops
  // are shortlisted for them, depends on the land tier (see TIER_CONFIG) --
  // a homestead plot gets 2-4-way splits shortlisted for variety, a large
  // farm gets 3-5-way splits shortlisted for profit.
  const shortlist = shortlistCrops(crops, monocropProfitById, tier);
  for (const k of tierCfg.splitSizes) {
    if (shortlist.length < k) continue;
    pool.push(...buildSplitPlans(shortlist, k, areaAcre, budget, monocropProfitById));
  }

  // Companion-planting pairs get an explicit chance in the pool even if
  // one partner wouldn't otherwise make the profit/diversity shortlist --
  // a known synergy (see COMPANION_RELATIONSHIPS above) should be able to
  // surface itself on its own agronomic merit, not depend on both crops
  // independently ranking high enough to be shortlisted together.
  for (const rel of COMPANION_RELATIONSHIPS) {
    const cropA = crops.find((c) => c.id === rel.pair[0]);
    const cropB = crops.find((c) => c.id === rel.pair[1]);
    if (!cropA || !cropB) continue;
    pool.push(...buildSplitPlans([cropA, cropB], 2, areaAcre, budget, monocropProfitById));
  }

  // Budget-capped monocrop: when the budget can't cover planting the whole
  // plot, cultivate only as much as the budget allows and leave the rest
  // fallow this season, rather than only ever showing unaffordable plans.
  if (budget != null) {
    for (const crop of crops) {
      const fullAreaAcre = crop.maxAreaAcre ? Math.min(areaAcre, crop.maxAreaAcre) : areaAcre;
      const affordableAreaAcre = budget / crop.economics.costPerUnit;
      const cappedAreaAcre = Math.min(fullAreaAcre, affordableAreaAcre);
      // Tolerance kept tiny (0.001 acre, ~4 sqm) rather than a coarser cut --
      // a crop whose full cost lands just a few rupees over budget (e.g.
      // real floating-point area like 2.0000709 acres vs a clean 2.0-acre
      // budget line) still deserves its almost-full affordable version
      // instead of being silently skipped as "basically already full".
      if (cappedAreaAcre >= crop.minAreaAcre && cappedAreaAcre < fullAreaAcre - 0.001) {
        const share = cappedAreaAcre / areaAcre;
        const components = buildComponents([{ enterprise: crop, share }], areaAcre);
        pool.push({ components, summary: summarizePlan(components, budget) });
      }
    }
  }

  // Livestock alone, sized to the plot's full capacity (space/budget-limited).
  for (const animal of livestock) {
    const units = resolveUnitsForFullArea(animal, areaAcre, budget);
    const components = buildComponents([{ enterprise: animal, units }], areaAcre);
    pool.push({ components, summary: summarizePlan(components, budget) });
  }

  // Diversified: this tier's best crop plans plus one unit of livestock on
  // the side -- backyard poultry/goat alongside crops is exactly the kind
  // of household food-security combination a micro plot should surface.
  const rankFn = comparePlansForTier(tier);
  const topCropPlans = [...pool]
    .filter((p) => p.components.every((c) => c.enterprise.scalesWith === "area"))
    .sort(rankFn)
    .slice(0, 3);
  for (const base of topCropPlans) {
    for (const animal of livestock) {
      const remainingBudget = budget != null ? budget - base.summary.totalCost : null;
      if (budget != null && (remainingBudget == null || remainingBudget < animal.economics.costPerUnit)) continue;
      const addOn = buildComponents([{ enterprise: animal, units: 1 }], areaAcre);
      const components = [...base.components, ...addOn];
      pool.push({ components, summary: summarizePlan(components, budget) });
    }
  }

  return { areaAcre, ctx, tier, pool };
}

// `saturationLookup(cropId) -> 0.85-1.0` is optional and supplied by the
// route (see marketBalance.js) -- omitted entirely for the ML dataset
// generator and any other caller that doesn't pass it, which is exactly
// the point: this file stays pure/side-effect-free, saturation is a
// caller-supplied signal, not something scoring.js reaches out and fetches
// itself.
export function generateAllocationPlans(params, enterpriseData, { saturationLookup } = {}) {
  const { areaAcre, pool } = buildCandidatePool(params, enterpriseData);
  return buildScenarios(pool, areaAcre, saturationLookup);
}

// ---------- Plan optimizer ("Optimize this plan") ----------
// Everything above generates a fresh candidate pool from scratch. This is
// different: given a plan the user is ALREADY looking at, search plans
// nearby it in "share space" -- shrink one segment a bit, use the freed
// land to grow an existing crop or add a new one -- and surface the best
// few, each with an explicit before/after diff. Deliberately a local
// search over ACTUAL plans, scored by the exact same summarizePlan
// (companion bonuses and all) as everywhere else in this file, not a
// separate model -- an "optimized" plan has to be explainable exactly like
// every other plan, not just asserted to be better.
const REBALANCE_STEPS = [0.15, 0.25]; // how much land-share to move per attempt
const MIN_VIABLE_SHARE = 0.05; // don't suggest shrinking a crop to a sliver smaller than this

function buildRebalancedComponents(baseCrops, otherComponents, fromId, toEnterprise, moveShare, areaAcre) {
  const items = baseCrops
    .map((c) => {
      if (c.enterprise.id === fromId) {
        const newShare = Math.round((c.share - moveShare) * 1000) / 1000;
        return newShare > 0.001 ? { enterprise: c.enterprise, share: newShare } : null;
      }
      if (c.enterprise.id === toEnterprise.id) {
        return { enterprise: c.enterprise, share: Math.round((c.share + moveShare) * 1000) / 1000 };
      }
      return { enterprise: c.enterprise, share: c.share };
    })
    .filter(Boolean);
  if (!items.some((i) => i.enterprise.id === toEnterprise.id)) {
    items.push({ enterprise: toEnterprise, share: Math.round(moveShare * 1000) / 1000 });
  }
  const cropBuilt = buildComponents(items, areaAcre);
  const otherBuilt = buildComponents(
    otherComponents.map((c) => ({ enterprise: c.enterprise, units: c.econ.units })),
    areaAcre
  );
  return [...cropBuilt, ...otherBuilt];
}

// Re-hydrates a plan from just the {id, share|units} pairs a client would
// send -- never trusts a client-supplied cost/profit number, recomputes
// from scratch the same way every other plan in this file is built. An
// explicit `units` (e.g. "I placed exactly 3 goats") is honored as-is;
// only when BOTH share and units are omitted does it fall back to
// resolving full-area/full-budget units (optimizePlan's baseline re-hydration
// relies on that fallback; suggestNextMove below always sends one or the
// other explicitly).
function hydrateComponents(componentRefs, enterpriseData, areaAcre, budget) {
  // Merge by id first -- suggestNextMove lets a farmer pick the same crop
  // again on a later round (e.g. "add more bottle gourd to what's left"),
  // and that should grow the existing segment's share, not create a second
  // separate line item for the same crop.
  const merged = new Map();
  for (const ref of componentRefs) {
    const existing = merged.get(ref.id);
    if (!existing) {
      merged.set(ref.id, { ...ref });
      continue;
    }
    if (ref.share != null) existing.share = (existing.share ?? 0) + ref.share;
    if (ref.units != null) existing.units = (existing.units ?? 0) + ref.units;
  }

  const items = [...merged.values()].map(({ id, share, units }) => {
    const enterprise = enterpriseData.enterprises.find((e) => e.id === id);
    if (!enterprise) throw new Error(`Unknown enterprise id: ${id}`);
    if (share != null) return { enterprise, share };
    if (units != null) return { enterprise, units };
    return { enterprise, units: resolveUnitsForFullArea(enterprise, areaAcre, budget) };
  });
  return buildComponents(items, areaAcre);
}

export function optimizePlan(
  { componentIds, areaSqm, soilType, waterSource, season, budget, zone, objective },
  enterpriseData
) {
  const areaAcre = areaSqm / SQM_PER_ACRE;
  const ctx = { season, soilType, waterSource, areaAcre, zone };

  const baseline = hydrateComponents(componentIds, enterpriseData, areaAcre, budget);
  const baselineSummary = summarizePlan(baseline, budget);
  const baseCrops = baseline.filter((c) => c.share != null);
  const others = baseline.filter((c) => c.share == null);

  const crops = enterpriseData.enterprises.filter((e) => e.scalesWith === "area" && isEligible(e, ctx));
  const currentIds = new Set(baseCrops.map((c) => c.enterprise.id));

  // Candidates to grow into: crops already in the plan (grow their share),
  // plus a short list of eligible crops not yet present -- prioritizing
  // ones with a real companion relationship to something already growing
  // here (an agronomic reason to add THIS crop specifically, not just "it's
  // next most profitable"), then filling out with the highest-profit
  // eligible crops not already present.
  const companionCandidates = crops.filter(
    (e) =>
      !currentIds.has(e.id) &&
      COMPANION_RELATIONSHIPS.some((rel) => rel.pair.includes(e.id) && rel.pair.some((id) => currentIds.has(id)))
  );
  const profitShortlist = [...crops]
    .filter((e) => !currentIds.has(e.id) && !companionCandidates.includes(e))
    .sort((a, b) => {
      const profitOf = (e) => summarizePlan(buildComponents([{ enterprise: e, share: 1 }], areaAcre), budget).totalProfitAvg;
      return profitOf(b) - profitOf(a);
    })
    .slice(0, 6);
  const growTargets = [...baseCrops.map((c) => c.enterprise), ...companionCandidates, ...profitShortlist];

  const neighbors = [];
  for (const from of baseCrops) {
    for (const step of REBALANCE_STEPS) {
      const remaining = from.share - step;
      if (remaining > 0.001 && remaining < MIN_VIABLE_SHARE) continue; // would leave an unviable sliver
      for (const to of growTargets) {
        if (to.id === from.enterprise.id) continue;
        const components = buildRebalancedComponents(baseCrops, others, from.enterprise.id, to, step, areaAcre);
        const summary = summarizePlan(components, budget);
        if (summary.affordable === false && baselineSummary.affordable !== false) continue;
        neighbors.push({
          components,
          summary,
          fromId: from.enterprise.id,
          fromName: from.enterprise.name,
          toId: to.id,
          toName: to.name,
          isNewCrop: !currentIds.has(to.id),
          movedShare: step,
        });
      }
    }
  }

  const scenario = SCENARIOS.find((s) => s.key === objective) ?? SCENARIOS[0];
  const noSaturation = () => 1; // a what-if tool on a plan the user already chose -- not re-applying the market-balance nudge here
  neighbors.sort((a, b) => scenario.compare(a, b, noSaturation));

  const baselineId = planId(baseline);
  const seen = new Set();
  const suggestions = [];
  for (const n of neighbors) {
    const id = planId(n.components);
    if (id === baselineId || seen.has(id)) continue;
    seen.add(id);
    const profitDelta = n.summary.totalProfitAvg - baselineSummary.totalProfitAvg;
    suggestions.push({
      ...toPlanView(n.components, n.summary, areaAcre),
      change: {
        reduced: { id: n.fromId, name: n.fromName, byShare: n.movedShare },
        grown: { id: n.toId, name: n.toName, isNewCrop: n.isNewCrop },
        profitDelta,
        profitDeltaPercent:
          baselineSummary.totalProfitAvg !== 0
            ? Math.round((profitDelta / Math.abs(baselineSummary.totalProfitAvg)) * 1000) / 10
            : null,
        diversificationBefore: Math.round(diversificationScore(baseline) * 100) / 100,
        diversificationAfter: Math.round(diversificationScore(n.components) * 100) / 100,
      },
    });
    if (suggestions.length >= 3) break;
  }

  return {
    objective: scenario.key,
    baseline: toPlanView(baseline, baselineSummary, areaAcre),
    suggestions,
  };
}

// ---------- Sequential planner ("Build mode": piece by piece) ----------
// Everything above answers "here's a complete plan" (generateAllocationPlans)
// or "here's a tweak to a complete plan" (optimizePlan). This answers a
// third, different question: "I've placed these pieces on my field so far
// -- what could I add next, and what would each option actually do to my
// plan?" Not a ranked list of finished plans, a ranked list of NEXT MOVES,
// re-evaluated fresh every call against whatever's already on the field --
// same scoring/companion/risk machinery as everywhere else (no separate
// model; see the conversation this was designed in for why that's a
// deliberate choice, not a gap), just applied to "what completes this
// specific partial plan well" instead of "what's the best plan from
// scratch". Returns EVERY eligible next move, not just the top few --
// ranked, but nothing hidden, so the farmer sees the real landscape of
// choices and picks for themselves.
export function suggestNextMove(
  { areaSqm, soilType, waterSource, season, budget, zone, placed, shareOfRemaining },
  enterpriseData
) {
  const areaAcre = areaSqm / SQM_PER_ACRE;
  const placedComponents = hydrateComponents(placed ?? [], enterpriseData, areaAcre, budget);
  const placedSummary = summarizePlan(placedComponents, budget);

  const usedShare = placedComponents.filter((c) => c.share != null).reduce((s, c) => s + c.share, 0);
  const remainingAreaAcre = Math.max(0, Math.round(areaAcre * (1 - usedShare) * 1000) / 1000);
  const remainingBudget = budget != null ? Math.max(0, Math.round(budget - placedSummary.totalCost)) : null;
  const claimFraction = Math.max(0, Math.min(1, shareOfRemaining ?? 1));

  const placedIds = new Set(placedComponents.map((c) => c.enterprise.id));
  // Companion effects already active among what's placed -- used to filter
  // each candidate's newCompanionMatches down to only the synergy/caution
  // THIS specific addition would newly introduce, not ones already there.
  const existingCompanionKeys = new Set(placedSummary.companionMatches.map((m) => m.crops.join("+")));

  const ctx = { season, soilType, waterSource, areaAcre: remainingAreaAcre, zone };
  const candidates = [];

  for (const enterprise of enterpriseData.enterprises) {
    if (!isEligible(enterprise, ctx)) continue;

    let proposalItem;
    if (enterprise.scalesWith === "area") {
      if (remainingAreaAcre <= 0.001) continue; // no physical space left, a hard limit unlike budget
      const proposedAreaAcre = remainingAreaAcre * claimFraction;
      if (proposedAreaAcre < enterprise.minAreaAcre) continue;
      proposalItem = { enterprise, share: Math.round((proposedAreaAcre / areaAcre) * 1000) / 1000 };
    } else {
      // Budget-scaling (livestock): proposed at whatever the REMAINING
      // budget/area affords -- shown even if that's unaffordable (the
      // projected plan's `affordable` flag below reflects that), matching
      // how the rest of this file always shows options flagged rather than
      // silently hiding budget-limited ones.
      proposalItem = { enterprise, units: resolveUnitsForFullArea(enterprise, remainingAreaAcre, remainingBudget) };
    }

    const standaloneComponent = buildComponents([proposalItem], areaAcre)[0];
    const projectedComponents = [...placedComponents, standaloneComponent];
    const projectedSummary = summarizePlan(projectedComponents, budget);
    const newCompanionMatches = projectedSummary.companionMatches.filter(
      (m) => !existingCompanionKeys.has(m.crops.join("+"))
    );

    candidates.push({
      id: enterprise.id,
      name: enterprise.name,
      category: enterprise.category,
      alreadyPlaced: placedIds.has(enterprise.id),
      proposal: {
        shareLabel:
          proposalItem.share != null
            ? `${Math.round(proposalItem.share * 100)}% of total land`
            : `${standaloneComponent.econ.units === 1 ? "1" : standaloneComponent.econ.units} × ${enterprise.economics.unit}`,
        share: proposalItem.share ?? null,
        units: proposalItem.units ?? null,
      },
      standalone: {
        cost: Math.round(standaloneComponent.econ.cost),
        profitAvg: Math.round(standaloneComponent.econ.profitAvg),
        roiPercent:
          standaloneComponent.econ.cost > 0
            ? Math.round((standaloneComponent.econ.profitAvg / standaloneComponent.econ.cost) * 1000) / 10
            : null,
        riskLabel: riskLabel(standaloneComponent.risk),
      },
      // Reuses the same agronomic-fit reasoning scoreEnterprise already
      // computes (see agronomicPipeline above) -- the plain-language basis
      // for a pros/cons view, not a new judgment invented for this endpoint.
      fit: agronomicPipeline(enterprise, ctx),
      projected: {
        totalCost: projectedSummary.totalCost,
        totalProfitAvg: projectedSummary.totalProfitAvg,
        roiPercent: projectedSummary.roiPercent,
        riskLabel: projectedSummary.riskLabel,
        riskAdjustedProfit: projectedSummary.riskAdjustedProfit,
        affordable: projectedSummary.affordable,
      },
      newCompanionMatches,
    });
  }

  candidates.sort((a, b) => b.projected.riskAdjustedProfit - a.projected.riskAdjustedProfit);

  return {
    areaAcre: Math.round(areaAcre * 100) / 100,
    remainingAreaAcre,
    remainingBudget,
    placed: placedComponents.length > 0 ? toPlanView(placedComponents, placedSummary, areaAcre) : null,
    candidates,
  };
}
