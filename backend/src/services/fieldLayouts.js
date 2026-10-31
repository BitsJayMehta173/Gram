import { buildCandidatePool, toPlanView } from "./scoring.js";
import { bestSequenceForSegment } from "./rotation.js";
import { findAiCompanionMatches } from "./growingTips.js";

// ---------- Full-year, land-productivity-first field layouts ("Shuffle") ----------
// generateAllocationPlans (scoring.js) answers "what's the single best plan
// for one season, ranked by profit/risk/diversification". That framing has a
// real failure mode at scale: if every farmer in a zone is shown the same
// "#1 max-profit plan", they all plant the same thing and flood the same
// local market -- the opposite of what a recommendation tool should cause.
// marketBalance.js already nudges rankings away from that; this file goes
// further for the "Shuffle" experience specifically, by not filtering on
// profit, risk, OR budget AT ALL -- only real agronomic eligibility
// (isEligible, inside buildCandidatePool: does this crop even grow in this
// zone/season/soil/water) ever excludes something. A crop that would cost
// more than the stated budget, or lose money, still shows up here, clearly
// flagged as such -- the farmer sees the real number and decides for
// themselves, the same way an "exceeds budget" plan was always still shown
// (not hidden) elsewhere in this app. Everything else is about ORDER, never
// about hiding a genuinely possible option. Instead this answers a
// different question: "show me every real way to use this land, each with
// its own full YEAR of rotation (not just this season)" -- closer to
// browsing base layouts than picking a winner.
//
// Reuses buildCandidatePool's exact same pool of structurally-valid spatial
// splits as generateAllocationPlans (so "what's eligible to be in a layout"
// never drifts between the two features) and bestSequenceForSegment's exact
// same full-year rotation rules (same-crop-repeat penalty, legume-followup
// bonus, disease-risk-family penalty) already used elsewhere in this app --
// no new agronomic rules invented for this view, just a different selection
// and presentation of the same underlying facts.

// Monocrops are cheap to enumerate fully (bounded by the crop catalog, not
// combinatorics) and are exactly the shape a real, well-known staple like
// sugarcane/potato/jute shows up as -- so unlike multi-way splits, EVERY
// eligible monocrop is always included (affordable or not -- see the file
// header), never capped or round-robin-rationed. A profit-, budget-, or
// productivity-based cap here was the actual root cause of prominent Terai
// crops silently vanishing from Shuffle: they don't have to win any ranking
// or clear any financial bar to appear, only to be real.
const MAX_MULTIWAY_SAMPLE = 60; // distinct multi-way shapes to bother computing full-year rotation for
const MAX_LAYOUTS = 80; // overall response cap, generous -- the frontend collapses long lists behind "show more"
const MAX_PER_CROP_ACROSS_LAYOUTS = 6; // applies to MULTI-way layouts only, see below

// How much of the YEAR this layout's land is actively growing something,
// weighted by each segment's share of the plot -- 1.0 means every segment
// has a crop in all three seasons (or is a year-round perennial), 0 means
// the whole plot sits fallow all year. Unassigned/leftover land counts in
// the denominator at zero coverage, so leaving 40% of a plot untouched
// scores worse than filling it, even with a lower-value crop.
function landProductivityScore(landSegments, leftoverShare) {
  const totalShare = landSegments.reduce((s, seg) => s + seg.share, 0) + leftoverShare;
  if (totalShare <= 0) return 0;
  const weightedCoverage = landSegments.reduce((sum, seg) => {
    const coverage = seg.rotation.perennial ? 1 : seg.rotation.steps.filter((s) => s.enterpriseId != null).length / 3;
    return sum + seg.share * coverage;
  }, 0);
  return weightedCoverage / totalShare;
}

function countRotationBenefits(landSegments) {
  return landSegments.reduce((count, seg) => {
    if (seg.rotation.perennial) return count;
    return count + seg.rotation.steps.filter((s) => s.adjustment?.type === "legume-followup").length;
  }, 0);
}

// budgetShortfall is accepted but deliberately not woven into this sentence
// -- the frontend renders it as its own prominent warning line instead of
// burying it in this paragraph (see FieldLayoutCard's "Costs NPR X more
// than your stated budget" block).
function describeLayout(planView, productivityScore, rotationBenefits) {
  const compStr = planView.components.map((c) => `${c.shareLabel} ${c.name}`).join(" + ");
  const coveragePct = Math.round(productivityScore * 100);
  const benefitNote =
    rotationBenefits > 0
      ? ` Includes ${rotationBenefits} nitrogen-carryover rotation ${rotationBenefits === 1 ? "benefit" : "benefits"} across the year's rotation.`
      : "";
  const fallowNote = planView.leftoverAreaAcre > 0 ? ` ${planView.leftoverAreaAcre} acre left unassigned this season.` : "";
  return `${compStr} — this land stays in active use ${coveragePct}% of the year across its rotation.${benefitNote}${fallowNote}`;
}

// Display order only -- affordable-within-budget layouts read first (most
// immediately actionable), unaffordable ones still fully included right
// after rather than hidden, then productivity/rotation-benefits as before.
function compareLayoutsForDisplay(a, b) {
  const affA = a.affordable === false ? 0 : 1;
  const affB = b.affordable === false ? 0 : 1;
  if (affA !== affB) return affB - affA;
  return b.productivityScore - a.productivityScore || b.rotationBenefits - a.rotationBenefits;
}

function layoutKey(components) {
  return components
    .map((c) => (c.share != null ? c.enterprise.id : `${c.enterprise.id}:unit`))
    .sort()
    .join("+");
}

// Fisher-Yates -- used so repeated "Shuffle" calls genuinely surface
// different multi-crop combinations over time (the feature's whole point),
// not the same deterministic set every single call.
function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildLayoutFromCandidate(candidate, { areaAcre, soilType, waterSource, zone, budget, season }, enterpriseData) {
  const landComponents = candidate.components.filter((c) => c.share != null);
  const livestockComponents = candidate.components.filter((c) => c.share == null);
  if (landComponents.length === 0) return null; // livestock-only "layouts" don't say anything about land use

  const landSegments = landComponents.map((c) => ({
    id: c.enterprise.id,
    name: c.enterprise.name,
    share: c.share,
    rotation: bestSequenceForSegment(
      { areaAcre: areaAcre * c.share, soilType, waterSource, zone, budget, anchorSeason: season, anchorEnterprise: c.enterprise },
      enterpriseData
    ),
  }));

  const planView = toPlanView(candidate.components, candidate.summary, areaAcre);
  const leftoverShare = planView.leftoverAreaAcre > 0 ? planView.leftoverAreaAcre / areaAcre : 0;
  const productivityScore = landProductivityScore(landSegments, leftoverShare);
  const rotationBenefits = countRotationBenefits(landSegments);
  // Informational only -- never gates whether this layout is included (see
  // the file header). budgetShortfall is how much MORE than the stated
  // budget this would actually cost, so the frontend can say a real number
  // instead of just "unaffordable".
  const budgetShortfall =
    budget != null && candidate.summary.affordable === false ? Math.round(candidate.summary.totalCost - budget) : null;

  // AI-suggested (unverified) companion pairings found among this layout's
  // own crop segments -- see growingTips.js for the resolution/trust rules.
  // Purely informational: computed AFTER productivityScore/summary above and
  // never fed back into either, unlike candidate.summary.companionMatches
  // (the cited COMPANION_RELATIONSHIPS, which DO affect totalProfitAvg).
  const aiCompanionMatches = findAiCompanionMatches(
    landSegments.map((seg) => seg.id),
    zone,
    season
  );

  return {
    id: planView.id,
    components: planView.components,
    leftoverAreaAcre: planView.leftoverAreaAcre,
    livestockNote:
      livestockComponents.length > 0
        ? `${livestockComponents.map((c) => c.enterprise.name).join(", ")} raised alongside using budget/space, not a land share.`
        : null,
    segments: landSegments.map((seg) => ({
      id: seg.id,
      name: seg.name,
      shareLabel: `${Math.round(seg.share * 100)}% of land`,
      rotation: seg.rotation,
    })),
    productivityScore: Math.round(productivityScore * 100) / 100,
    rotationBenefits,
    companionMatches: candidate.summary.companionMatches,
    aiCompanionMatches,
    // Shown for information, never used to select, order, or exclude layouts.
    totalProfitAvg: candidate.summary.totalProfitAvg,
    roiPercent: candidate.summary.roiPercent,
    riskLabel: candidate.summary.riskLabel,
    affordable: candidate.summary.affordable,
    budgetShortfall,
    description: describeLayout(planView, productivityScore, rotationBenefits),
  };
}

export function generateFieldLayouts(params, enterpriseData) {
  const { soilType, waterSource, zone, budget, season } = params;
  const { areaAcre, pool } = buildCandidatePool(params, enterpriseData);
  const ctx = { areaAcre, soilType, waterSource, zone, budget, season };

  // Pass 1 (cheap, no rotation yet): dedupe the pool into distinct crop
  // combinations, keeping the FIRST variant of each shape seen. Budget is
  // NOT a filter here (see file header) -- a crop's full 100%-share monocrop
  // is pushed first and a smaller budget-capped share of the SAME crop
  // second (only relevant when the full share is unaffordable); keeping the
  // full-share version first means the layout shows the crop's REAL full-plot
  // economics with an honest "costs NPR X more than your budget" flag,
  // rather than silently substituting a smaller area the farmer never asked
  // to see -- they can size it down themselves in Build mode if they want to.
  const seenShapes = new Set();
  const monocropCandidates = [];
  const multiWayCandidates = [];
  for (const candidate of pool) {
    const shape = layoutKey(candidate.components);
    if (seenShapes.has(shape)) continue;
    seenShapes.add(shape);
    if (candidate.components.length === 1) monocropCandidates.push(candidate);
    else multiWayCandidates.push(candidate);
  }

  // Pass 2 (expensive: bestSequenceForSegment per segment): compute full-year
  // rotation for EVERY monocrop candidate (bounded by the crop catalog, not
  // combinatorics -- cheap enough, and this is exactly the shape a farmer
  // expects a well-known single crop to show up as) plus a randomly-sampled
  // slice of the multi-way candidates (their combinatorics genuinely can be
  // large, so full enumeration isn't computed every request -- random
  // sampling instead means a different slice surfaces on each Shuffle call,
  // so which crops show up together varies over repeated use rather than
  // the same handful of "top profit" pairings every single time).
  const sampledMultiWay = shuffleArray(multiWayCandidates).slice(0, MAX_MULTIWAY_SAMPLE);

  const monocropLayouts = monocropCandidates
    .map((c) => buildLayoutFromCandidate(c, ctx, enterpriseData))
    .filter(Boolean);
  const multiWayLayouts = sampledMultiWay.map((c) => buildLayoutFromCandidate(c, ctx, enterpriseData)).filter(Boolean);

  // Monocrops: ALL of them, ordered by productivity for a sensible reading
  // order, but never trimmed by that order -- inclusion is unconditional.
  monocropLayouts.sort(compareLayoutsForDisplay);

  // Multi-way: bucketed by segment count and taken round-robin so a 2-way
  // and a 4-way split both get real representation instead of one size
  // crowding out the rest, same discipline as before -- but this bucket
  // cap only ever trims REDUNDANT combinations (there are always far more
  // possible splits than slots), never a specific crop's only chance to
  // appear, since that guarantee now lives entirely in the monocrop list.
  const bySegmentCount = new Map();
  for (const layout of multiWayLayouts) {
    const k = layout.components.length;
    if (!bySegmentCount.has(k)) bySegmentCount.set(k, []);
    bySegmentCount.get(k).push(layout);
  }
  for (const bucket of bySegmentCount.values()) {
    bucket.sort(compareLayoutsForDisplay);
  }
  const bucketKeys = [...bySegmentCount.keys()].sort((a, b) => a - b);

  const multiWayBudget = Math.max(0, MAX_LAYOUTS - monocropLayouts.length);
  const cropCount = new Map();
  const selectedMultiWay = [];
  let remaining = true;
  while (remaining && selectedMultiWay.length < multiWayBudget) {
    remaining = false;
    for (const k of bucketKeys) {
      const bucket = bySegmentCount.get(k);
      while (bucket.length > 0) {
        const layout = bucket.shift();
        const cropIds = layout.components.map((c) => c.id);
        const wouldExceed = cropIds.some((cid) => (cropCount.get(cid) ?? 0) >= MAX_PER_CROP_ACROSS_LAYOUTS);
        if (wouldExceed) continue; // skip, don't re-offer -- keeps the round-robin moving
        selectedMultiWay.push(layout);
        for (const cid of cropIds) cropCount.set(cid, (cropCount.get(cid) ?? 0) + 1);
        remaining = true;
        break;
      }
      if (selectedMultiWay.length >= multiWayBudget) break;
    }
  }

  return { areaAcre: Math.round(areaAcre * 100) / 100, layouts: [...monocropLayouts, ...selectedMultiWay] };
}
