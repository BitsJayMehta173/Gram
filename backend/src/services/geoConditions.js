// Real geospatial lookups for a farmer's traced plot location, used to
// auto-suggest starting growing conditions instead of making every farmer
// pick zone/soil/water from a blank slate. Two independent, verified-working
// free APIs (Open-Meteo, no key required):
//   - elevation: https://api.open-meteo.com/v1/elevation
//   - historical daily rainfall: https://archive-api.open-meteo.com/v1/archive
//
// SoilGrids (ISRIC) was evaluated for real soil pH/texture data and
// deliberately NOT used -- its public REST query endpoint currently returns
// null for every property at every coordinate, including ISRIC's own
// documented example query, confirmed by direct testing (not a Nepal-specific
// gap, a real current outage of that endpoint). Rather than fabricate soil
// pH/texture numbers, this module only auto-suggests what real, verified
// data actually supports: zone (from elevation) and rainfall (informational
// only -- annual rainfall alone can't tell us whether a plot has irrigation
// infrastructure, so it is never used to auto-set waterSource).
//
// Elevation bands are the same real Nepal agro-ecological zone boundaries
// already used in ml/knowledge_dataset/generate.mjs (sourced from
// nepal_agri_ai's `regions` table): Terai 60-300m, Inner Terai 300-1000m,
// Mid-Hills 1000-2000m, High Hills 2000-3000m, Mountain 3000-5500m --
// collapsed here to gram's own 3-zone schema.
const ELEVATION_OPEN_METEO_URL = "https://api.open-meteo.com/v1/elevation";
const RAINFALL_OPEN_METEO_URL = "https://archive-api.open-meteo.com/v1/archive";

export function classifyZoneFromElevation(elevationM) {
  if (elevationM < 1000) return "terai"; // covers Terai (60-300m) and Inner Terai (300-1000m)
  if (elevationM < 2000) return "hills"; // Mid-Hills
  return "high-hills"; // High Hills (2000-3000m) and Mountain (3000m+)
}

async function fetchElevation(lat, lng) {
  const url = `${ELEVATION_OPEN_METEO_URL}?latitude=${lat}&longitude=${lng}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Elevation lookup failed: ${res.status}`);
  const data = await res.json();
  const elevationM = data.elevation?.[0];
  if (!Number.isFinite(elevationM)) throw new Error("Elevation lookup returned no data");
  return elevationM;
}

// Sums the last 365 days of daily rainfall as a rough annual-rainfall
// estimate for this exact point -- a real single-year figure, not a long-term
// climate normal, so it's presented as "rainfall over the last 12 months"
// rather than "typical annual rainfall".
async function fetchAnnualRainfall(lat, lng) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 365);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const url =
    `${RAINFALL_OPEN_METEO_URL}?latitude=${lat}&longitude=${lng}` +
    `&start_date=${fmt(start)}&end_date=${fmt(end)}&daily=precipitation_sum&timezone=Asia%2FKathmandu`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Rainfall lookup failed: ${res.status}`);
  const data = await res.json();
  const values = data.daily?.precipitation_sum ?? [];
  if (values.length === 0) throw new Error("Rainfall lookup returned no data");
  const totalMm = values.reduce((sum, v) => sum + (v ?? 0), 0);
  return Math.round(totalMm);
}

// Fetches what's real and available, degrading gracefully field-by-field --
// a rainfall API hiccup shouldn't also take down the elevation-based zone
// suggestion, and vice versa. Never throws; failures are reported per-field.
export async function getGeoConditions(lat, lng) {
  const result = {
    elevationM: null,
    suggestedZone: null,
    annualRainfallMm: null,
    rainfallPeriod: "last 12 months",
    warnings: [],
  };

  const [elevationOutcome, rainfallOutcome] = await Promise.allSettled([
    fetchElevation(lat, lng),
    fetchAnnualRainfall(lat, lng),
  ]);

  if (elevationOutcome.status === "fulfilled") {
    result.elevationM = Math.round(elevationOutcome.value);
    result.suggestedZone = classifyZoneFromElevation(elevationOutcome.value);
  } else {
    result.warnings.push("Couldn't look up elevation for this location — pick your zone manually.");
  }

  if (rainfallOutcome.status === "fulfilled") {
    result.annualRainfallMm = rainfallOutcome.value;
  } else {
    result.warnings.push("Couldn't look up rainfall history for this location.");
  }

  result.warnings.push(
    "Soil type and pH couldn't be auto-detected (the free soil-data source we tried is currently unreliable) -- pick soil type yourself, ideally checked against your nearest Krishi Gyan Kendra."
  );

  return result;
}
