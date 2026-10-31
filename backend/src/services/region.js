// Coarse bounding box for Nepal as a whole — a country-level sanity check,
// not an agro-climatic one. It cannot tell Terai from high-hills; that's
// what the farmer's own "zone" selection is for. This will include a
// sliver of bordering India/China and exclude a little of Nepal's own
// panhandle extremes — good enough to catch "clearly not Nepal", no more.
const NEPAL_BOUNDS = {
  minLat: 26.3,
  maxLat: 30.5,
  minLng: 80.0,
  maxLng: 88.3,
};

export function checkRegion(location) {
  if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
    return {
      checked: false,
      inRegion: null,
      message: "Plot location wasn't available, so we couldn't confirm it's in Nepal — pick your zone carefully below.",
    };
  }

  const { lat, lng } = location;
  const inRegion =
    lat >= NEPAL_BOUNDS.minLat && lat <= NEPAL_BOUNDS.maxLat && lng >= NEPAL_BOUNDS.minLng && lng <= NEPAL_BOUNDS.maxLng;

  return {
    checked: true,
    inRegion,
    message: inRegion
      ? "Your plot falls roughly within Nepal's borders."
      : "Your plot appears to be outside Nepal — this dataset is curated for Nepal and the numbers below may not apply.",
  };
}
