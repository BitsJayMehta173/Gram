// Small 2D polygon toolkit backing the blueprint editor: projects the real
// traced lat/lng plot into local meters, and supports guillotine-style
// clipping so a segment can be cut vertically or horizontally into two,
// following the plot's true (possibly irregular) boundary rather than an
// assumed rectangle.

export function projectLatLngPolygon(latLngs) {
  const lat0 = latLngs.reduce((s, p) => s + p.lat, 0) / latLngs.length;
  const lng0 = latLngs.reduce((s, p) => s + p.lng, 0) / latLngs.length;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return latLngs.map((p) => ({
    x: (p.lng - lng0) * mPerDegLng,
    y: -(p.lat - lat0) * mPerDegLat, // north (increasing lat) renders upward
  }));
}

export function rectPolygon(w, h) {
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
}

export function polygonBounds(poly) {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

export function polygonArea(poly) {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function lerp(a, b, t) {
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

// Sutherland-Hodgman clip against a single axis-aligned half-plane — exact
// for any simple polygon (convex or concave) since a half-plane is convex.
// side "lower" keeps coord <= position, "upper" keeps coord >= position.
export function clipPolygon(poly, orientation, position, side) {
  const coordOf = orientation === "v" ? (p) => p.x : (p) => p.y;
  const inside = side === "lower" ? (p) => coordOf(p) <= position + 1e-9 : (p) => coordOf(p) >= position - 1e-9;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const curr = poly[i];
    const prev = poly[(i - 1 + poly.length) % poly.length];
    const currIn = inside(curr);
    const prevIn = inside(prev);
    if (currIn !== prevIn) {
      const ca = coordOf(prev);
      const cb = coordOf(curr);
      const t = (position - ca) / (cb - ca);
      out.push(lerp(prev, curr, t));
    }
    if (currIn) out.push(curr);
  }
  return out;
}

// Finds the cut position along `orientation` whose "lower" side has area =
// targetFraction * polygonArea(poly) -- via binary search against the EXACT
// clipped area (clipPolygon + polygonArea), not the bounding-box span. That
// distinction matters: interpolating linearly across the bounding box only
// gives area-proportional pieces for an axis-aligned rectangle. For a real
// traced (possibly concave/irregular) plot, a bounding-box-proportional cut
// can put noticeably more or less than the target share on either side, e.g.
// if the plot bulges or narrows across the cut direction. Binary search
// converges regardless of concavity because sweeping a half-plane clip
// across a simple polygon in a fixed direction always grows its area
// monotonically -- {x <= mid1} subset of {x <= mid2} whenever mid1 < mid2,
// so the intersection with a fixed polygon can only gain area, never lose it.
export function solveCutForAreaFraction(poly, orientation, targetFraction, iterations = 40) {
  const bounds = polygonBounds(poly);
  let lo = orientation === "v" ? bounds.minX : bounds.minY;
  let hi = orientation === "v" ? bounds.maxX : bounds.maxY;
  const targetArea = targetFraction * polygonArea(poly);

  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    const lowerArea = polygonArea(clipPolygon(poly, orientation, mid, "lower"));
    if (lowerArea < targetArea) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

// The exact segment where a cut line crosses a polygon's boundary — used to
// draw resize handles and live cut previews that hug the real plot shape.
export function boundarySegment(poly, orientation, position) {
  const pts = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ca = orientation === "v" ? a.x : a.y;
    const cb = orientation === "v" ? b.x : b.y;
    if ((ca - position) * (cb - position) < -1e-9) {
      const t = (position - ca) / (cb - ca);
      pts.push(lerp(a, b, t));
    } else if (Math.abs(ca - position) < 1e-9) {
      pts.push(a);
    }
  }
  if (pts.length < 2) return null;
  const other = orientation === "v" ? (p) => p.y : (p) => p.x;
  pts.sort((a, b) => other(a) - other(b));
  return [pts[0], pts[pts.length - 1]];
}
