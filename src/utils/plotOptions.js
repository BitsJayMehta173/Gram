// Shared zone/soil/water option lists for the frontend. Values must match
// the backend's SOIL_TYPES/WATER_SOURCES/ZONES (backend/src/routes/
// recommendations.js) — those are what the API actually validates against.
export const ZONES = [
  { key: "terai", label: "Terai" },
  { key: "hills", label: "Hills" },
  { key: "high-hills", label: "High-hills" },
];

export const SOIL_TYPES = [
  { key: "alluvial", label: "Alluvial" },
  { key: "loamy", label: "Loamy" },
  { key: "clayey", label: "Clayey" },
  { key: "sandy-loam", label: "Sandy loam" },
];

export const WATER_SOURCES = [
  { key: "irrigated", label: "Irrigated" },
  { key: "rainfed", label: "Rainfed" },
];

// "" (Auto) means let the backend infer it from today's date (currentSeason()
// in backend/src/services/season.js) rather than sending a fixed value.
export const SEASONS = [
  { key: "", label: "Auto" },
  { key: "kharif", label: "Kharif" },
  { key: "rabi", label: "Rabi" },
  { key: "zaid", label: "Zaid" },
];
