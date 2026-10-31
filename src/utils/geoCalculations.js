import * as turf from "@turf/turf";

// Computes geodesic area, perimeter, and an axis-aligned bounding-box
// width/height approximation for an arbitrary (possibly irregular) polygon.
// The bounding box is a convenient stand-in for "length x width" — for
// non-rectangular plots it's clearly labeled as approximate in the UI.
export function analyzePolygon(latLngs) {
  if (!latLngs || latLngs.length < 3) return null;

  const coords = latLngs.map((p) => [p.lng, p.lat]);
  if (
    coords[0][0] !== coords[coords.length - 1][0] ||
    coords[0][1] !== coords[coords.length - 1][1]
  ) {
    coords.push(coords[0]);
  }

  const polygon = turf.polygon([coords]);
  const areaSqm = turf.area(polygon);
  const perimeterM = turf.length(turf.polygonToLine(polygon), { units: "kilometers" }) * 1000;

  const bbox = turf.bbox(polygon); // [minX, minY, maxX, maxY]
  const bl = turf.point([bbox[0], bbox[1]]);
  const br = turf.point([bbox[2], bbox[1]]);
  const tl = turf.point([bbox[0], bbox[3]]);

  const widthM = turf.distance(bl, br, { units: "kilometers" }) * 1000;
  const heightM = turf.distance(bl, tl, { units: "kilometers" }) * 1000;

  const centroid = turf.centroid(polygon).geometry.coordinates; // [lng, lat]

  return {
    areaSqm,
    perimeterM,
    boundingBox: { widthM, heightM },
    centroid: { lat: centroid[1], lng: centroid[0] },
  };
}
