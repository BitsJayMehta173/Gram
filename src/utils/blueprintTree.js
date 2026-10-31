import { clipPolygon, polygonArea, polygonBounds, solveCutForAreaFraction } from "./polygonOps";

let counter = 0;
function uid() {
  counter += 1;
  return `n${Date.now()}-${counter}`;
}

export function makeLeaf(polygon, cropId, options = {}) {
  return { type: "leaf", id: options.id ?? uid(), polygon, cropId, isRecommended: options.isRecommended ?? false };
}

export function makeSplit(orientation, position, parentPolygon, a, b) {
  return { type: "split", id: uid(), orientation, position, parentPolygon, a, b };
}

export function collectLeaves(node, acc = []) {
  if (node.type === "leaf") acc.push(node);
  else {
    collectLeaves(node.a, acc);
    collectLeaves(node.b, acc);
  }
  return acc;
}

export function collectHandles(node, acc = []) {
  if (node.type === "split") {
    acc.push(node);
    collectHandles(node.a, acc);
    collectHandles(node.b, acc);
  }
  return acc;
}

function mapTree(node, fn) {
  const replaced = fn(node);
  if (replaced !== undefined) return replaced;
  if (node.type === "split") {
    return { ...node, a: mapTree(node.a, fn), b: mapTree(node.b, fn) };
  }
  return node;
}

// Re-applies a subtree's own stored cuts against a newly shaped parent
// polygon. This is what lets resizing or removing a cut correctly ripple
// through any further cuts nested inside its children, instead of flattening
// them back into a plain rectangle.
function reclipSubtree(node, newParentPolygon) {
  if (node.type === "leaf") {
    return { ...node, polygon: newParentPolygon };
  }
  const a = clipPolygon(newParentPolygon, node.orientation, node.position, "lower");
  const b = clipPolygon(newParentPolygon, node.orientation, node.position, "upper");
  return {
    ...node,
    parentPolygon: newParentPolygon,
    a: reclipSubtree(node.a, a),
    b: reclipSubtree(node.b, b),
  };
}

export function updateSplitPosition(root, splitId, newPosition, minArea) {
  return mapTree(root, (node) => {
    if (node.type === "split" && node.id === splitId) {
      const aPoly = clipPolygon(node.parentPolygon, node.orientation, newPosition, "lower");
      const bPoly = clipPolygon(node.parentPolygon, node.orientation, newPosition, "upper");
      if (aPoly.length < 3 || bPoly.length < 3 || polygonArea(aPoly) < minArea || polygonArea(bPoly) < minArea) {
        return node;
      }
      return {
        ...node,
        position: newPosition,
        a: reclipSubtree(node.a, aPoly),
        b: reclipSubtree(node.b, bPoly),
      };
    }
    return undefined;
  });
}

// The freshly cropped piece (b) always starts with NO crop chosen (cropId:
// null) and not-recommended — it's new land the user just carved out, so it
// should prompt them to choose rather than silently guessing one. The
// retained piece (a) keeps whatever crop/recommendation status it had.
export function replaceLeafWithSplit(root, leafId, orientation, position, minArea, newLeafId) {
  return mapTree(root, (node) => {
    if (node.type === "leaf" && node.id === leafId) {
      const aPoly = clipPolygon(node.polygon, orientation, position, "lower");
      const bPoly = clipPolygon(node.polygon, orientation, position, "upper");
      if (aPoly.length < 3 || bPoly.length < 3 || polygonArea(aPoly) < minArea || polygonArea(bPoly) < minArea) {
        return node;
      }
      return makeSplit(
        orientation,
        position,
        node.polygon,
        makeLeaf(aPoly, node.cropId, { id: node.id, isRecommended: node.isRecommended }),
        makeLeaf(bPoly, null, { id: newLeafId, isRecommended: false })
      );
    }
    return undefined;
  });
}

export function removeLeaf(root, leafId) {
  function recurse(node) {
    if (node.type === "split") {
      if (node.a.type === "leaf" && node.a.id === leafId) return reclipSubtree(node.b, node.parentPolygon);
      if (node.b.type === "leaf" && node.b.id === leafId) return reclipSubtree(node.a, node.parentPolygon);
      return { ...node, a: recurse(node.a), b: recurse(node.b) };
    }
    return node;
  }
  return recurse(root);
}

// A user explicitly choosing a crop always clears the "recommended" flag —
// it's now their call, not the starting suggestion.
export function setLeafCrop(root, leafId, cropId) {
  return mapTree(root, (node) => {
    if (node.type === "leaf" && node.id === leafId) {
      return { ...node, cropId, isRecommended: false };
    }
    return undefined;
  });
}

// Builds a tree from a flat list of { cropId, share } (shares need not be
// pre-normalized) coming from the backend's random-layout endpoint, or from
// a real recommendation plan's land allocation.
// orientation: "v" | "h" | "mixed" (mixed picks the LONGER axis of the
// current remaining piece at each cut, so a wide-short remainder gets
// side-by-side segments and a narrow-tall one gets stacked segments,
// avoiding sliver-shaped segments as pieces get carved away).
export function buildTreeFromShares(polygon, segments, orientation) {
  const rec = { isRecommended: true };

  function orientationAt(dir, poly) {
    if (dir === "v" || dir === "h") return dir;
    const b = polygonBounds(poly);
    return b.maxX - b.minX >= b.maxY - b.minY ? "v" : "h";
  }

  function build(segs, poly) {
    if (segs.length === 1) return makeLeaf(poly, segs[0].cropId, rec);
    const total = segs.reduce((s, x) => s + x.share, 0) || 1;
    const [first, ...rest] = segs;
    const dir = orientationAt(orientation, poly);
    // Area-accurate cut: solve for the position whose actual clipped area
    // matches the target share of poly's REAL area, not its bounding-box
    // span — exact for concave/irregular real-plot shapes, where a
    // bounding-box-proportional cut can be noticeably off. See
    // solveCutForAreaFraction in polygonOps.js for why binary search here
    // is valid even on concave polygons.
    const cutPos = solveCutForAreaFraction(poly, dir, first.share / total);
    const firstPoly = clipPolygon(poly, dir, cutPos, "lower");
    const restPoly = clipPolygon(poly, dir, cutPos, "upper");
    if (firstPoly.length < 3 || restPoly.length < 3) {
      // Degenerate cut (share ~0 or ~1) — fold this crop out rather than
      // producing an invalid sliver, and continue with the remaining ones.
      return build(rest, poly);
    }
    return makeSplit(dir, cutPos, poly, makeLeaf(firstPoly, first.cropId, rec), build(rest, restPoly));
  }

  return build(segments, polygon);
}

// A modest starting layout — a handful of vertical cuts across the real
// polygon, pre-labeled as recommendations the farmer can accept or change.
export function buildInitialTree(polygon) {
  const b = polygonBounds(polygon);
  const span = b.maxX - b.minX;
  const cut1 = b.minX + span * 0.4;
  const cut2 = b.minX + span * 0.7;
  const cut3 = b.minX + span * 0.9;

  const left = clipPolygon(polygon, "v", cut1, "lower");
  const rest1 = clipPolygon(polygon, "v", cut1, "upper");
  const mid = clipPolygon(rest1, "v", cut2, "lower");
  const rest2 = clipPolygon(rest1, "v", cut2, "upper");
  const third = clipPolygon(rest2, "v", cut3, "lower");
  const fourth = clipPolygon(rest2, "v", cut3, "upper");
  const rec = { isRecommended: true };

  return makeSplit(
    "v",
    cut1,
    polygon,
    makeLeaf(left, "rice", rec),
    makeSplit(
      "v",
      cut2,
      rest1,
      makeLeaf(mid, "maize", rec),
      makeSplit("v", cut3, rest2, makeLeaf(third, "lentil", rec), makeLeaf(fourth, "potato", rec))
    )
  );
}
