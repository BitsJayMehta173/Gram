// Area units relevant to farmers in India and Nepal.
// Regional units (bigha, kattha, ropani, etc.) vary by state/district —
// values below are common approximations and should be labeled as such in the UI.
export const AREA_UNITS = [
  { key: "sqm", label: "Square meters (m²)", short: "m²", sqm: 1, region: "universal" },
  { key: "hectare", label: "Hectare (ha)", short: "ha", sqm: 10000, region: "universal" },
  { key: "acre", label: "Acre", short: "acre", sqm: 4046.8564224, region: "universal" },
  {
    key: "bigha_pucca",
    label: "Bigha (pucca, ~UP/Bihar/Punjab avg.)",
    sqm: 2529.285,
    region: "india",
    approximate: true,
  },
  {
    key: "bigha_kaccha",
    label: "Bigha (kaccha, ~MP/Rajasthan avg.)",
    sqm: 1011.71,
    region: "india",
    approximate: true,
  },
  { key: "guntha", label: "Guntha", sqm: 101.17, region: "india" },
  {
    key: "bigha_np",
    label: "Bigha (Nepal, Terai)",
    sqm: 6772.63,
    region: "nepal",
  },
  { key: "kattha_np", label: "Kattha (Nepal, Terai)", sqm: 338.63, region: "nepal" },
  { key: "dhur_np", label: "Dhur (Nepal, Terai)", sqm: 16.93, region: "nepal" },
  { key: "ropani", label: "Ropani (Nepal, hills)", sqm: 508.72, region: "nepal" },
  { key: "aana", label: "Aana (Nepal, hills)", sqm: 31.795, region: "nepal" },
];

export const LENGTH_UNITS = [
  { key: "m", label: "Meters (m)", meters: 1 },
  { key: "ft", label: "Feet (ft)", meters: 0.3048 },
  { key: "km", label: "Kilometers (km)", meters: 1000 },
];

export function convertArea(valueInSqm, unitKey) {
  const unit = AREA_UNITS.find((u) => u.key === unitKey);
  if (!unit) return valueInSqm;
  return valueInSqm / unit.sqm;
}

export function areaFromUnit(value, unitKey) {
  const unit = AREA_UNITS.find((u) => u.key === unitKey);
  if (!unit) return value;
  return value * unit.sqm;
}

export function convertLength(valueInMeters, unitKey) {
  const unit = LENGTH_UNITS.find((u) => u.key === unitKey);
  if (!unit) return valueInMeters;
  return valueInMeters / unit.meters;
}

export function formatNumber(n, digits = 2) {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}
