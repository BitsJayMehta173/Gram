// Simple non-overlapping cropping-calendar bands used across the
// Indo-Gangetic Plain / Nepal Terai. Deliberately coarse for v1 — a real
// implementation might shift bands by sub-region.
export function currentSeason(date = new Date()) {
  const month = date.getMonth() + 1; // 1-12
  if (month >= 6 && month <= 10) return "kharif"; // Jun-Oct
  if (month >= 3 && month <= 5) return "zaid"; // Mar-May
  return "rabi"; // Nov-Feb
}

export const SEASONS = ["kharif", "rabi", "zaid"];
