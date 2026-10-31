// ---------- Month-by-month land-use map ----------
// scoring.js answers "what to grow this season" and rotation.js answers
// "what to grow each Nepal season (kharif/rabi/zaid) on this segment for
// the rest of the year" -- this is the last step down: turning that
// season-level plan into an actual Jan-Dec calendar per segment, using the
// monthlyCalendar research data now on each enterprise (sowing/growth-
// stage/harvest months, real-researched, see each entry's own sourceNote).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A crop can have several monthlyCalendar entries (one per season variant
// it's grown in, e.g. maize has "kharif" and "rabi" entries; perennials
// have a single "year-round" entry). Picks the one matching the season
// this step of the rotation actually uses.
function findCalendarEntry(enterprise, seasonLabel) {
  const cal = enterprise.monthlyCalendar;
  if (!cal || cal.length === 0) return null;
  if (seasonLabel) {
    const match = cal.find((c) => c.seasonLabel === seasonLabel);
    if (match) return match;
  }
  return cal.find((c) => c.seasonLabel === "year-round") ?? cal[0];
}

// Paints one crop's stage months onto the grid. Later calls overwrite
// earlier ones on any overlapping month -- deliberate, not a bug: when one
// step's harvest month coincides with the next step's land-prep month
// (the normal case for back-to-back rotation), the later step is what's
// actually happening on the ground by then.
function paintMonths(grid, entry, enterprise) {
  if (!entry) return;
  for (const stage of entry.stages) {
    for (const month of stage.months) {
      grid[month] = { cropId: enterprise.id, cropName: enterprise.name, stage: stage.stage };
    }
  }
}

// Builds a Jan-Dec grid for ONE segment, given the crop it's anchored to
// this season and its rest-of-year plan (a rotation.js
// bestSequenceForSegment result). Perennial segments just get their single
// annual cycle painted once; rotatable segments get each rotation step's
// own crop/season calendar painted in sequence.
export function buildMonthlyGrid(enterprise, segmentTimeline, enterpriseData) {
  const grid = Object.fromEntries(MONTHS.map((m) => [m, null]));

  if (!segmentTimeline || segmentTimeline.perennial) {
    paintMonths(grid, findCalendarEntry(enterprise, null), enterprise);
  } else {
    for (const step of segmentTimeline.steps) {
      if (!step.enterpriseId) continue; // an explicit fallow step in the rotation
      const stepEnterprise = enterpriseData.enterprises.find((e) => e.id === step.enterpriseId);
      if (!stepEnterprise) continue;
      paintMonths(grid, findCalendarEntry(stepEnterprise, step.season), stepEnterprise);
    }
  }

  return MONTHS.map((month) => ({
    month,
    ...(grid[month] ?? { cropId: null, cropName: "Fallow", stage: null }),
  }));
}
