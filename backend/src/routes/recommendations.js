import { Router } from "express";
import enterpriseData from "../data/enterprises.json" with { type: "json" };
import soilInputsData from "../data/soilInputs.json" with { type: "json" };
import {
  getRecommendations,
  generateAllocationPlans,
  describeLandTier,
  optimizePlan,
  suggestNextMove,
} from "../services/scoring.js";
import { generateRotationPlans, bestSequenceForSegment } from "../services/rotation.js";
import { generateFieldLayouts } from "../services/fieldLayouts.js";
import { buildMonthlyGrid } from "../services/monthlyMap.js";
import { currentSeason, SEASONS } from "../services/season.js";
import { checkRegion } from "../services/region.js";
import { buildSaturationLookup, recordRecommendation } from "../services/marketBalance.js";
import { getGrowingTips, growingTipsMeta } from "../services/growingTips.js";
import { getGeoConditions } from "../services/geoConditions.js";

const router = Router();

export const SOIL_TYPES = ["alluvial", "loamy", "clayey", "sandy-loam"];
export const WATER_SOURCES = ["irrigated", "rainfed"];
export const ZONES = ["terai", "hills", "high-hills"];

router.get("/enterprises", (req, res) => {
  res.json(enterpriseData);
});

router.get("/options", (req, res) => {
  res.json({ soilTypes: SOIL_TYPES, waterSources: WATER_SOURCES, seasons: SEASONS, zones: ZONES });
});

// Static reference data (N-P-K% and cost per kg for chemical fertilizers and
// organic manures) -- deliberately NOT a per-crop dosing engine, see
// soilInputs.json's own disclaimer field for why. Farmer picks their own
// target dose (from a package label or Krishi Gyan Kendra); this just gives
// real numbers to compare organic vs chemical options and estimate cost.
router.get("/soil-inputs", (req, res) => {
  res.json(soilInputsData);
});

// Real elevation + rainfall lookup for a traced plot's centroid, used to
// auto-suggest a starting zone instead of a blank manual pick. See
// geoConditions.js for exactly what is (elevation, rainfall) and isn't
// (soil type/pH -- the free source for that is currently unreliable, not
// used rather than faked) auto-detected, and why.
router.get("/geo-conditions", async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: "lat and lng query params are required" });
  }
  const conditions = await getGeoConditions(lat, lng);
  res.json(conditions);
});

// AI-suggested growing tips (companion planting, soil amendment, pest
// management, rotation) -- explicitly a lower-trust, supplementary layer
// (see growingTips.js). Optional/on-demand: fetched by the frontend only
// when a farmer actually expands a card's detail, not bundled into every
// recommendation response.
router.get("/growing-tips", (req, res) => {
  const { cropId, zone, season } = req.query;
  if (!cropId || !zone || !season) {
    return res.status(400).json({ error: "cropId, zone, and season query params are required" });
  }
  const tips = getGrowingTips(cropId, zone, season);
  res.json({ tips, meta: growingTipsMeta });
});

router.post("/recommendations", (req, res) => {
  const { areaSqm, soilType, waterSource, season, budget, location, zone } = req.body ?? {};

  if (!Number.isFinite(areaSqm) || areaSqm <= 0) {
    return res.status(400).json({ error: "areaSqm must be a positive number" });
  }
  if (!SOIL_TYPES.includes(soilType)) {
    return res.status(400).json({ error: `soilType must be one of: ${SOIL_TYPES.join(", ")}` });
  }
  if (!WATER_SOURCES.includes(waterSource)) {
    return res.status(400).json({ error: `waterSource must be one of: ${WATER_SOURCES.join(", ")}` });
  }
  if (!ZONES.includes(zone)) {
    return res.status(400).json({ error: `zone must be one of: ${ZONES.join(", ")}` });
  }
  const resolvedSeason = season && SEASONS.includes(season) ? season : currentSeason();
  const resolvedBudget = budget != null && Number.isFinite(budget) && budget > 0 ? budget : null;
  const resolvedLocation =
    location && Number.isFinite(location.lat) && Number.isFinite(location.lng) ? location : null;

  const params = { areaSqm, soilType, waterSource, season: resolvedSeason, budget: resolvedBudget, zone };
  const { areaAcre, weights, recommendations } = getRecommendations(params, enterpriseData);
  const allocationPlans = generateAllocationPlans(params, enterpriseData, {
    saturationLookup: buildSaturationLookup(zone),
  });
  const regionCheck = checkRegion(resolvedLocation);
  const landTier = describeLandTier(areaAcre);

  // Market-balance: record what this request's top pick was, so later
  // requests in the same zone get nudged toward something else -- see
  // marketBalance.js for why this exists (naive "everyone gets told the
  // most profitable crop" advice floods the local market for that crop).
  const topPick = allocationPlans.find((s) => s.key === "maxProfit")?.plans[0];
  if (topPick) recordRecommendation(zone, topPick.components.map((c) => c.id));

  // Phase 3: each segment of each plan gets its own rest-of-year answer,
  // independent of what the other segments in the same plan are doing --
  // see rotation.js's bestSequenceForSegment for why this can't just reuse
  // generateRotationPlans (that assumes one crop on 100% of the land).
  // allocationPlans is now a list of scenario groups (see generateAllocationPlans),
  // so this walks scenario -> plan -> component.
  for (const scenario of allocationPlans) {
    for (const plan of scenario.plans) {
      for (const comp of plan.components) {
        const enterprise = enterpriseData.enterprises.find((e) => e.id === comp.id);
        if (!enterprise || enterprise.scalesWith !== "area" || comp.areaAcre == null) continue;
        comp.segmentTimeline = bestSequenceForSegment(
          {
            areaAcre: comp.areaAcre,
            soilType,
            waterSource,
            zone,
            budget: resolvedBudget,
            anchorSeason: resolvedSeason,
            anchorEnterprise: enterprise,
          },
          enterpriseData
        );
        // The last step down from "which season" to "which month" -- turns
        // the segment's rotation plan into an actual Jan-Dec calendar using
        // the researched monthlyCalendar data on each enterprise.
        comp.monthlyGrid = buildMonthlyGrid(enterprise, comp.segmentTimeline, enterpriseData);
      }
    }
  }

  res.json({
    areaAcre,
    season: resolvedSeason,
    zone,
    region: enterpriseData.regionLabel,
    disclaimer: enterpriseData.disclaimer,
    regionCheck,
    pipelineWeights: weights,
    landTier,
    allocationPlans,
    recommendations,
  });
});

// "Optimize this plan": given a plan the user is already looking at (its
// components as {id, share|null} pairs -- never trust client-sent cost/
// profit numbers, scoring.js recomputes from scratch), searches nearby
// rebalancings -- shrink one segment, grow or add another -- and returns
// the best few, each with an explicit before/after diff. See scoring.js's
// optimizePlan for why this is a local search over real plans rather than
// a separate model.
const OBJECTIVES = ["maxProfit", "diversified", "lowRisk"];

router.post("/optimize-plan", (req, res) => {
  const { areaSqm, soilType, waterSource, season, budget, zone, components, objective } = req.body ?? {};

  if (!Number.isFinite(areaSqm) || areaSqm <= 0) {
    return res.status(400).json({ error: "areaSqm must be a positive number" });
  }
  if (!SOIL_TYPES.includes(soilType)) {
    return res.status(400).json({ error: `soilType must be one of: ${SOIL_TYPES.join(", ")}` });
  }
  if (!WATER_SOURCES.includes(waterSource)) {
    return res.status(400).json({ error: `waterSource must be one of: ${WATER_SOURCES.join(", ")}` });
  }
  if (!ZONES.includes(zone)) {
    return res.status(400).json({ error: `zone must be one of: ${ZONES.join(", ")}` });
  }
  if (!Array.isArray(components) || components.length === 0) {
    return res.status(400).json({ error: "components must be a non-empty array of { id, share }" });
  }
  for (const c of components) {
    if (typeof c.id !== "string" || (c.share != null && typeof c.share !== "number")) {
      return res.status(400).json({ error: "each component needs a string id and a numeric share (or null for livestock)" });
    }
  }
  const resolvedSeason = season && SEASONS.includes(season) ? season : currentSeason();
  const resolvedBudget = budget != null && Number.isFinite(budget) && budget > 0 ? budget : null;
  const resolvedObjective = OBJECTIVES.includes(objective) ? objective : "maxProfit";

  try {
    const result = optimizePlan(
      {
        componentIds: components,
        areaSqm,
        soilType,
        waterSource,
        season: resolvedSeason,
        budget: resolvedBudget,
        zone,
        objective: resolvedObjective,
      },
      enterpriseData
    );
    res.json({ ...result, disclaimer: enterpriseData.disclaimer });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// "Build mode": piece-by-piece planning. Given whatever's already placed
// on the field (possibly nothing, for the first call) as {id, share|units}
// pairs, returns the running plan's own totals plus EVERY eligible next
// move, ranked but not filtered down -- see scoring.js's suggestNextMove
// for why this is a fresh rule-engine evaluation against the specific
// partial plan, not a separate model. The client owns the running `placed`
// list entirely (this route is stateless, same as every other endpoint
// here) and just re-posts it, one entry longer, after each pick.
router.post("/next-move", (req, res) => {
  const { areaSqm, soilType, waterSource, season, budget, zone, placed, shareOfRemaining } = req.body ?? {};

  if (!Number.isFinite(areaSqm) || areaSqm <= 0) {
    return res.status(400).json({ error: "areaSqm must be a positive number" });
  }
  if (!SOIL_TYPES.includes(soilType)) {
    return res.status(400).json({ error: `soilType must be one of: ${SOIL_TYPES.join(", ")}` });
  }
  if (!WATER_SOURCES.includes(waterSource)) {
    return res.status(400).json({ error: `waterSource must be one of: ${WATER_SOURCES.join(", ")}` });
  }
  if (!ZONES.includes(zone)) {
    return res.status(400).json({ error: `zone must be one of: ${ZONES.join(", ")}` });
  }
  if (placed != null && !Array.isArray(placed)) {
    return res.status(400).json({ error: "placed must be an array of { id, share } or { id, units }" });
  }
  for (const p of placed ?? []) {
    if (typeof p.id !== "string" || (p.share != null && typeof p.share !== "number") || (p.units != null && typeof p.units !== "number")) {
      return res.status(400).json({ error: "each placed entry needs a string id and a numeric share and/or units" });
    }
  }
  const resolvedSeason = season && SEASONS.includes(season) ? season : currentSeason();
  const resolvedBudget = budget != null && Number.isFinite(budget) && budget > 0 ? budget : null;
  const resolvedShareOfRemaining =
    shareOfRemaining != null && Number.isFinite(shareOfRemaining) && shareOfRemaining > 0 && shareOfRemaining <= 1
      ? shareOfRemaining
      : 1;

  try {
    const result = suggestNextMove(
      {
        areaSqm,
        soilType,
        waterSource,
        season: resolvedSeason,
        budget: resolvedBudget,
        zone,
        placed: placed ?? [],
        shareOfRemaining: resolvedShareOfRemaining,
      },
      enterpriseData
    );

    // Once something's placed, give it the same "rest of year" / monthly
    // detail every other plan view gets, so a farmer who's build-moded
    // their way to a finished plan sees the exact same depth as the
    // instant-scenario view -- not a second-class result.
    if (result.placed) {
      for (const comp of result.placed.components) {
        const enterprise = enterpriseData.enterprises.find((e) => e.id === comp.id);
        if (!enterprise || enterprise.scalesWith !== "area" || comp.areaAcre == null) continue;
        comp.segmentTimeline = bestSequenceForSegment(
          {
            areaAcre: comp.areaAcre,
            soilType,
            waterSource,
            zone,
            budget: resolvedBudget,
            anchorSeason: resolvedSeason,
            anchorEnterprise: enterprise,
          },
          enterpriseData
        );
        comp.monthlyGrid = buildMonthlyGrid(enterprise, comp.segmentTimeline, enterpriseData);
      }
    }

    res.json({ ...result, zone, season: resolvedSeason, disclaimer: enterpriseData.disclaimer });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// "Shuffle": a browsable set of full-year, full-field layouts -- deliberately
// NOT ranked by profit (see fieldLayouts.js for why: a ranked "#1 plan" gets
// followed by every farmer who sees it, flooding whatever crop it picks).
// Ordered by land productivity (how much of the year each layout keeps the
// land actively growing something) instead, with every segment's own
// kharif->rabi->zaid rotation attached up front, not hidden behind a click.
router.post("/field-layouts", (req, res) => {
  const { areaSqm, soilType, waterSource, season, budget, zone } = req.body ?? {};

  if (!Number.isFinite(areaSqm) || areaSqm <= 0) {
    return res.status(400).json({ error: "areaSqm must be a positive number" });
  }
  if (!SOIL_TYPES.includes(soilType)) {
    return res.status(400).json({ error: `soilType must be one of: ${SOIL_TYPES.join(", ")}` });
  }
  if (!WATER_SOURCES.includes(waterSource)) {
    return res.status(400).json({ error: `waterSource must be one of: ${WATER_SOURCES.join(", ")}` });
  }
  if (!ZONES.includes(zone)) {
    return res.status(400).json({ error: `zone must be one of: ${ZONES.join(", ")}` });
  }
  const resolvedSeason = season && SEASONS.includes(season) ? season : currentSeason();
  const resolvedBudget = budget != null && Number.isFinite(budget) && budget > 0 ? budget : null;

  const { areaAcre, layouts } = generateFieldLayouts(
    { areaSqm, soilType, waterSource, season: resolvedSeason, budget: resolvedBudget, zone },
    enterpriseData
  );

  // Month-by-month grid per segment, same as every other detailed view in
  // this app -- built from each segment's OWN rotation (already computed),
  // not re-derived.
  for (const layout of layouts) {
    for (const segment of layout.segments) {
      if (segment.rotation.perennial) continue;
      const enterprise = enterpriseData.enterprises.find((e) => e.id === segment.id);
      segment.monthlyGrid = buildMonthlyGrid(enterprise, segment.rotation, enterpriseData);
    }
  }

  res.json({
    areaAcre,
    season: resolvedSeason,
    zone,
    region: enterpriseData.regionLabel,
    disclaimer: enterpriseData.disclaimer,
    layouts,
  });
});

// Scores a full-year kharif->rabi->zaid sequence on the SAME land, instead
// of one season in isolation like /recommendations does -- see
// services/rotation.js for the two agronomic rules this applies (same-crop
// repeat penalty, legume-followup bonus) and why they're deliberately just
// two, not a larger unexplained heuristic stack. No `season` input needed
// since every season is scored at once; budget still applies per-step.
router.post("/rotation-plans", (req, res) => {
  const { areaSqm, soilType, waterSource, budget, zone } = req.body ?? {};

  if (!Number.isFinite(areaSqm) || areaSqm <= 0) {
    return res.status(400).json({ error: "areaSqm must be a positive number" });
  }
  if (!SOIL_TYPES.includes(soilType)) {
    return res.status(400).json({ error: `soilType must be one of: ${SOIL_TYPES.join(", ")}` });
  }
  if (!WATER_SOURCES.includes(waterSource)) {
    return res.status(400).json({ error: `waterSource must be one of: ${WATER_SOURCES.join(", ")}` });
  }
  if (!ZONES.includes(zone)) {
    return res.status(400).json({ error: `zone must be one of: ${ZONES.join(", ")}` });
  }
  const resolvedBudget = budget != null && Number.isFinite(budget) && budget > 0 ? budget : null;

  const { areaAcre, plans } = generateRotationPlans(
    { areaSqm, soilType, waterSource, zone, budget: resolvedBudget },
    enterpriseData
  );

  res.json({
    areaAcre,
    zone,
    region: enterpriseData.regionLabel,
    disclaimer: enterpriseData.disclaimer,
    rotationPlans: plans,
  });
});

export default router;
