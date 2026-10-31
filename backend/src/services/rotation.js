import { scoreEnterprise, SQM_PER_ACRE } from "./scoring.js";

// ---------- Rotation/succession scoring ----------
// Scores a full-YEAR sequence of what to grow on the SAME land across
// Nepal's three cropping seasons (kharif -> rabi -> zaid), instead of
// scoring one season in isolation like scoreEnterprise()/getRecommendations
// do. Three well-established, specifically-evidenced agronomic principles
// are encoded as explicit, tunable adjustments -- kept to a small, named,
// individually-justified set rather than a black box of stacked heuristics:
//
//   1. Repeating the SAME enterprise in back-to-back seasons is penalized.
//      Continuous monocropping depletes the exact same soil nutrients and
//      lets crop-specific pests/pathogens build up in the soil -- a
//      foundational reason crop rotation exists as a practice at all.
//
//   2. A legume (nitrogen-fixing) crop immediately followed by any other
//      crop gives that FOLLOWING crop a profit bonus. Legume root nodules
//      host Rhizobium bacteria that fix atmospheric nitrogen into the soil;
//      harvesting the grain still leaves nitrogen-enriched root/stubble
//      residue behind for the next crop. This is a smaller version of the
//      same principle behind the Sesbania-green-manure-before-wheat effect
//      already cited elsewhere in this project (+10-13% yield) -- real, but
//      likely a more modest boost here since lentil is harvested for grain
//      rather than grown purely as green manure.
//
//   3. A DIFFERENT crop from the SAME disease-risk family, back-to-back, is
//      penalized -- but ONLY for families with real, multiple-source-
//      documented soil-borne disease carryover: allium (white rot, persists
//      20+ years once established), brassica (clubroot, documented in
//      Nepal since 1993 with severe epidemics since 2004), and solanaceae
//      (bacterial wilt, late blight -- volunteer tubers directly seed the
//      next crop -- and root-knot nematodes; three independent documented
//      mechanisms for potato/tomato specifically). This is deliberately a
//      narrow, evidenced allowlist, NOT a blanket "same family" rule --
//      see the note below on why cereals are excluded from it.
//
// Explicitly NOT penalized by rule 3: cereal same-family sequences (e.g.
// rice -> wheat). That's the rice-wheat cropping system, one of the most
// common and agronomically sound rotations across the whole Indo-Gangetic
// plain including the Nepal Terai -- a blanket "same family = bad" rule
// would get this backwards, which is exactly why rule 3 is a specific
// allowlist rather than a general family check.
const SAME_CROP_REPEAT_PENALTY = 0.85; // -15% profit on an immediate repeat
const LEGUME_FOLLOWUP_BONUS = 1.08; // +8% profit on the crop right after a legume
const DISEASE_RISK_FAMILY_PENALTY = 0.85; // -15% profit on a same-risk-family repeat
const DISEASE_RISK_FAMILIES = new Set(["allium", "brassica", "solanaceae"]);

// Traits used for scoring (nitrogenEffect drives rule 2, family drives rule
// 3 for the families in DISEASE_RISK_FAMILIES above; other families are
// tracked for explanation/future extensibility only).
export const ROTATION_TRAITS = {
  rice: { family: "cereal", nitrogenEffect: "depletes" },
  wheat: { family: "cereal", nitrogenEffect: "depletes" },
  maize: { family: "cereal", nitrogenEffect: "depletes" },
  millet: { family: "cereal", nitrogenEffect: "depletes" },
  lentil: { family: "legume", nitrogenEffect: "fixes" },
  // Botanically Solanaceae (nightshade), same family as tomato -- matters
  // for rule 3 (bacterial wilt/late blight/nematodes are shared risks).
  potato: { family: "solanaceae", nitrogenEffect: "depletes" },
  ginger: { family: "rhizome", nitrogenEffect: "depletes" },
  mungbean: { family: "legume", nitrogenEffect: "fixes" },
  sesame: { family: "oilseed", nitrogenEffect: "depletes" },
  jute: { family: "fiber", nitrogenEffect: "depletes" },
  garlic: { family: "allium", nitrogenEffect: "depletes" },
  mustard: { family: "brassica", nitrogenEffect: "depletes" },
  cauliflower: { family: "brassica", nitrogenEffect: "depletes" },
  cabbage: { family: "brassica", nitrogenEffect: "depletes" },
  tomato: { family: "solanaceae", nitrogenEffect: "depletes" },
  turmeric: { family: "rhizome", nitrogenEffect: "depletes" },
  chickpea: { family: "legume", nitrogenEffect: "fixes" },
  // tea/coffee/large_cardamom/banana/citrus_mandarin/kiwi deliberately omitted:
  // durationDays=365 already excludes them from isRotatable() below (perennial
  // orchards/gardens, not annual crops that get replanted each season).
  // sugarcane deliberately omitted: durationDays=365 already excludes it from
  // isRotatable() below (it occupies the land for the better part of a year
  // and can't be slotted into a single kharif/rabi/zaid rotation step).
};

const SEASON_ORDER = ["kharif", "rabi", "zaid"];

// Perennial orchards (apple) aren't replanted each season, and livestock
// doesn't occupy land the way a rotated crop does -- neither belongs in a
// land-rotation sequence.
function isRotatable(enterprise) {
  return enterprise.scalesWith === "area" && enterprise.durationDays < 365;
}

function scoreStep(enterprise, ctx, budget) {
  if (!enterprise) return null; // explicit fallow
  const result = scoreEnterprise(enterprise, ctx, budget);
  return result.eligible ? result : null;
}

// One candidate sequence -> per-step results + rotation adjustments + total
// annual profit. Each step is { season, enterprise|null }; null = fallow.
function scoreSequence(steps, ctx, budget) {
  let totalProfit = 0;
  const detail = [];
  let prevEnterpriseId = null;
  let prevWasLegume = false;
  let prevFamily = null;

  for (const { season, enterprise } of steps) {
    const result = scoreStep(enterprise, { ...ctx, season }, budget);

    if (!enterprise || !result) {
      detail.push({ season, enterpriseId: null, name: "Fallow", profitAvg: 0, adjustment: null });
      prevEnterpriseId = null;
      prevWasLegume = false;
      prevFamily = null;
      continue;
    }

    const family = ROTATION_TRAITS[enterprise.id]?.family ?? null;
    let profit = result.economics.profitAvg;
    let adjustment = null;

    if (prevEnterpriseId === enterprise.id) {
      profit = Math.round(profit * SAME_CROP_REPEAT_PENALTY);
      adjustment = { type: "same-crop-repeat", factor: SAME_CROP_REPEAT_PENALTY };
    } else if (prevWasLegume) {
      profit = Math.round(profit * LEGUME_FOLLOWUP_BONUS);
      adjustment = { type: "legume-followup", factor: LEGUME_FOLLOWUP_BONUS };
    } else if (family && family === prevFamily && DISEASE_RISK_FAMILIES.has(family)) {
      profit = Math.round(profit * DISEASE_RISK_FAMILY_PENALTY);
      adjustment = { type: "disease-risk-family-repeat", factor: DISEASE_RISK_FAMILY_PENALTY, family };
    }

    totalProfit += profit;
    detail.push({
      season,
      enterpriseId: enterprise.id,
      name: enterprise.name,
      baseProfitAvg: Math.round(result.economics.profitAvg),
      profitAvg: profit,
      riskLabel: result.riskLabel,
      adjustment,
    });

    prevEnterpriseId = enterprise.id;
    prevWasLegume = ROTATION_TRAITS[enterprise.id]?.nitrogenEffect === "fixes";
    prevFamily = family;
  }

  return { steps: detail, totalProfit: Math.round(totalProfit) };
}

function sequenceId(detail) {
  return detail.map((d) => d.enterpriseId ?? "fallow").join(">");
}

function explainSequence(detail) {
  const parts = detail.map((d) => (d.enterpriseId ? d.name : "fallow"));
  const notes = detail
    .filter((d) => d.adjustment)
    .map((d) => {
      if (d.adjustment.type === "legume-followup") return `${d.name} gets a nitrogen-carryover boost following a legume`;
      if (d.adjustment.type === "disease-risk-family-repeat")
        return `${d.name} follows another ${d.adjustment.family} crop — shared soil-disease risk, yield penalty applied`;
      return `${d.name} repeats the previous season's crop — yield penalty applied`;
    });
  const base = `${parts.join(" → ")} across the year`;
  return notes.length > 0 ? `${base}. ${notes.join(". ")}.` : `${base}.`;
}

// Enumerates candidate season sequences from eligible rotatable crops (plus
// explicit fallow) per season, scores each with scoreSequence, and returns
// the top-ranked ones by total annual profit.
export function generateRotationPlans({ areaSqm, soilType, waterSource, zone, budget }, enterpriseData) {
  const areaAcre = areaSqm / SQM_PER_ACRE;
  const ctx = { soilType, waterSource, areaAcre, zone };

  const rotatable = enterpriseData.enterprises.filter(isRotatable);

  const bySeasonCandidates = SEASON_ORDER.map((season) => [
    null,
    ...rotatable.filter((e) => scoreStep(e, { ...ctx, season }, budget) != null),
  ]);

  const pool = [];
  for (const kharifPick of bySeasonCandidates[0]) {
    for (const rabiPick of bySeasonCandidates[1]) {
      for (const zaidPick of bySeasonCandidates[2]) {
        if (!kharifPick && !rabiPick && !zaidPick) continue; // all-fallow isn't a real plan
        const steps = [
          { season: "kharif", enterprise: kharifPick },
          { season: "rabi", enterprise: rabiPick },
          { season: "zaid", enterprise: zaidPick },
        ];
        pool.push(scoreSequence(steps, ctx, budget));
      }
    }
  }

  pool.sort((a, b) => b.totalProfit - a.totalProfit);

  const seen = new Set();
  const top = [];
  for (const seq of pool) {
    const id = sequenceId(seq.steps);
    if (seen.has(id)) continue;
    seen.add(id);
    top.push({ id, steps: seq.steps, totalProfit: seq.totalProfit, explanation: explainSequence(seq.steps) });
    if (top.length >= 8) break;
  }

  return { areaAcre: Math.round(areaAcre * 100) / 100, plans: top };
}

// ---------- Per-segment rotation (Phase 3: land segments x seasonal timeline) ----------
// generateRotationPlans above answers "what should the WHOLE plot grow all
// year" -- it assumes one crop occupies 100% of the land each season. Once
// a plot is split into segments (see scoring.js's generateAllocationPlans),
// each segment needs its OWN answer to "what grows here for the rest of the
// year", independent of what the other segments are doing -- a large farm's
// litchi block doesn't need to agree with its vegetable block about what
// comes after kharif. This reuses the exact same scoring/adjustment rules
// as generateRotationPlans (same-crop-repeat penalty, legume-followup
// bonus, disease-risk-family penalty) at the segment's own area, with
// whichever season the segment's already committed to (the crop the
// allocation plan chose) held fixed rather than re-optimized.
export function bestSequenceForSegment(
  { areaAcre, soilType, waterSource, zone, budget, anchorSeason, anchorEnterprise },
  enterpriseData
) {
  const ctx = { soilType, waterSource, areaAcre, zone };

  if (!isRotatable(anchorEnterprise)) {
    // Perennial orchard/plantation crop (or anything durationDays >= 365):
    // occupies this segment year-round rather than getting replanted each
    // season, so there's no rotation to compute -- showing it 3 times over
    // would triple-count a profit figure that's already "per year".
    return {
      perennial: true,
      enterpriseId: anchorEnterprise.id,
      name: anchorEnterprise.name,
      note: `${anchorEnterprise.name} occupies this segment year-round (established planting) — no seasonal rotation applies.`,
    };
  }

  const rotatable = enterpriseData.enterprises.filter(isRotatable);
  const bySeasonCandidates = SEASON_ORDER.map((season) => {
    if (season === anchorSeason) return [anchorEnterprise]; // already committed by the allocation plan
    return [null, ...rotatable.filter((e) => scoreStep(e, { ...ctx, season }, budget) != null)];
  });

  const pool = [];
  for (const kharifPick of bySeasonCandidates[0]) {
    for (const rabiPick of bySeasonCandidates[1]) {
      for (const zaidPick of bySeasonCandidates[2]) {
        const steps = [
          { season: "kharif", enterprise: kharifPick },
          { season: "rabi", enterprise: rabiPick },
          { season: "zaid", enterprise: zaidPick },
        ];
        pool.push(scoreSequence(steps, ctx, budget));
      }
    }
  }
  pool.sort((a, b) => b.totalProfit - a.totalProfit);
  const best = pool[0];

  // Sum of each step's own adjustment (legume-followup bonus minus
  // disease-risk-family/same-crop-repeat penalties) -- the "residual
  // benefit" of rotating this segment well, isolated from the crops' own
  // direct profit. Already computed per-step in scoreSequence; this just
  // rolls it up so callers (the /recommendations detailed breakdown) don't
  // have to re-derive it from the raw steps.
  const rotationBenefitTotal = best.steps.reduce((s, step) => s + ((step.profitAvg ?? 0) - (step.baseProfitAvg ?? 0)), 0);

  return {
    perennial: false,
    id: sequenceId(best.steps),
    steps: best.steps,
    totalProfit: best.totalProfit,
    rotationBenefitTotal: Math.round(rotationBenefitTotal),
    explanation: explainSequence(best.steps),
  };
}
