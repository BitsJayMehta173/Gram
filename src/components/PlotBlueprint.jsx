import { useEffect, useMemo, useRef, useState } from "react";
import { convertArea, formatNumber } from "../utils/units";
import { projectLatLngPolygon, rectPolygon, polygonBounds, polygonArea, boundarySegment } from "../utils/polygonOps";
import {
  buildInitialTree,
  buildTreeFromShares,
  collectLeaves,
  collectHandles,
  updateSplitPosition,
  replaceLeafWithSplit,
  removeLeaf,
  setLeafCrop,
} from "../utils/blueprintTree";
import { loadJSON, saveJSON } from "../utils/persist";

const API_BASE = "http://localhost:4000";
const TREE_STORAGE_PREFIX = "gram:blueprint:v1:";

// Icon/color per real enterprise id (backend/src/data/enterprises.json is
// the source of truth for names — this is purely presentational). "fallow"
// isn't a real enterprise; it represents rested/unallocated land. Any id not
// listed here (e.g. a future 12th enterprise) still renders via
// DEFAULT_CROP_STYLE rather than breaking.
const ENTERPRISE_STYLE = {
  rice: { icon: "🌾", color: "#8FD19E" },
  wheat: { icon: "🌿", color: "#F6C453" },
  maize: { icon: "🌽", color: "#F2A65A" },
  millet: { icon: "🌱", color: "#C9A06B" },
  lentil: { icon: "🫘", color: "#B5895B" },
  potato: { icon: "🥔", color: "#D9B382" },
  ginger: { icon: "🫚", color: "#E0C097" },
  apple: { icon: "🍎", color: "#E07A5F" },
  goat: { icon: "🐐", color: "#B98B57" },
  buffalo: { icon: "🐃", color: "#7A6A58" },
  poultry_broiler: { icon: "🐔", color: "#E8B04B" },
  fallow: { icon: "◻", color: "#D9D9D9" },
};
const DEFAULT_CROP_STYLE = { icon: "🌱", color: "#9CB380" };
const FALLOW_CROP = { id: "fallow", name: "Fallow / rest", ...ENTERPRISE_STYLE.fallow };

const VIEW_W = 600;
const VIEW_H = 400;
const MAX_LEAVES = 12;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 6;
const ZOOM_STEP = 1.3;

// Fixed calendar order used everywhere a full-year rotation is scored
// (rotation.js's SEASON_ORDER) -- a segment's `rotation.steps` array is
// always in this order regardless of which season it was originally
// planned for, so the slider's index maps directly onto it.
const SEASON_STEPS = [
  { key: "kharif", label: "Kharif" },
  { key: "rabi", label: "Rabi" },
  { key: "zaid", label: "Zaid" },
];

const TOOLS = [
  { key: "select", label: "🖱 Select" },
  { key: "cut-v", label: "│ Vertical cutter" },
  { key: "cut-h", label: "── Horizontal cutter" },
];

async function fetchRandomLayout() {
  const res = await fetch(`${API_BASE}/api/blueprint/random`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  const data = await res.json();
  const cropSegments = data.segments.map((s) => ({ cropId: s.cropId, share: s.share }));
  return { cropSegments, orientation: data.orientation };
}

// Fetches the full ranked list of real allocation plans for this plot —
// the picker shows all of them; nothing is auto-applied here.
async function fetchRecommendationData(areaSqm, context) {
  const res = await fetch(`${API_BASE}/api/recommendations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ areaSqm, ...context }),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Request failed (${res.status})`);
  }
  const data = await res.json();
  if (!data.allocationPlans?.length) {
    throw new Error("No viable land-use plan for this zone/season/soil/water combination yet.");
  }
  return data;
}

// One chosen plan -> land segments. Livestock components (share == null)
// scale with budget/units, not land area, so they don't get a segment here —
// reported back separately so the caller can tell the farmer why.
function planToSegments(plan, areaAcre) {
  const landComponents = plan.components.filter((c) => c.share != null);
  const skippedLivestock = plan.components.filter((c) => c.share == null);
  const cropSegments = landComponents.map((c) => ({ cropId: c.id, share: c.share }));
  if (plan.leftoverAreaAcre > 0 && areaAcre > 0) {
    cropSegments.push({ cropId: "fallow", share: plan.leftoverAreaAcre / areaAcre });
  }
  return { cropSegments, skippedLivestock };
}

// Both a /api/recommendations "plan" (rotation data lives inline per
// component as c.segmentTimeline/c.monthlyGrid, attached by that route) and
// a /api/field-layouts "layout" (rotation data lives in its own parallel
// `segments` array, attached by that route) carry the exact same
// bestSequenceForSegment shape underneath -- this just reads whichever one
// the source has into one common { [cropId]: { rotation, monthlyGrid } }
// map, so the slider below doesn't need to know which endpoint a plan came
// from.
function extractRotationMap(source) {
  const map = {};
  if (source.segments) {
    for (const seg of source.segments) map[seg.id] = { rotation: seg.rotation, monthlyGrid: seg.monthlyGrid };
  } else if (source.components) {
    for (const c of source.components) {
      if (c.segmentTimeline) map[c.id] = { rotation: c.segmentTimeline, monthlyGrid: c.monthlyGrid };
    }
  }
  return map;
}

export default function PlotBlueprint({
  areaSqm,
  boundingBox,
  polygon,
  areaUnit,
  zone,
  soilType,
  waterSource,
  season,
  budget,
  onGoToMap,
  pendingLayout,
  onConsumeLayout,
}) {
  const planContext = {
    zone,
    soilType,
    waterSource,
    season: season || undefined,
    budget: budget ? parseFloat(budget) : undefined,
  };

  const [tool, setTool] = useState("select");
  const [tree, setTreeState] = useState(null);
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const [selectedLeafId, setSelectedLeafId] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [shuffling, setShuffling] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [planNote, setPlanNote] = useState(null);
  const [saveStatus, setSaveStatus] = useState("idle");
  // true once a specific layout picked in Shuffle (Recommendations tab) has
  // been applied here -- while true, this is "reviewing a chosen
  // recommendation" rather than free/custom building, so Shuffle (which
  // would randomly discard it) is hidden. Stays true even through manual
  // edits (cuts, crop reassignment) -- those refine the chosen layout, they
  // don't un-choose it.
  const [isAppliedLayout, setIsAppliedLayout] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [allEnterprises, setAllEnterprises] = useState([]);
  // Full-year rotation data for whatever plan/layout is currently applied,
  // keyed by the segment's own (anchor) crop id -- see extractRotationMap.
  // A leaf whose cropId has no entry here (freshly cut, or manually
  // reassigned to a crop that wasn't part of the applied plan) just shows
  // its own fixed crop at every slider position, which is the correct
  // fallback: there's no rotation data to show for an ad-hoc pick.
  const [rotationByCropId, setRotationByCropId] = useState({});
  const [seasonIndex, setSeasonIndex] = useState(0);
  const svgRef = useRef(null);
  const zoomGroupRef = useRef(null);
  const dragRef = useRef(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/enterprises`)
      .then((res) => res.json())
      .then((data) => setAllEnterprises(data.enterprises ?? []))
      .catch(() => setAllEnterprises([]));
  }, []);

  // Real enterprise names/icons/colors, keyed by id, plus the synthetic
  // "fallow" entry. A cropId not yet in this map (e.g. the brief window
  // before the enterprise fetch resolves) still renders via resolveCrop's
  // fallback rather than crashing.
  const paletteMap = useMemo(() => {
    const map = { fallow: FALLOW_CROP };
    for (const e of allEnterprises) {
      map[e.id] = { id: e.id, name: e.name, ...(ENTERPRISE_STYLE[e.id] ?? DEFAULT_CROP_STYLE) };
    }
    return map;
  }, [allEnterprises]);

  function resolveCrop(cropId) {
    if (!cropId) return null;
    return paletteMap[cropId] ?? { id: cropId, name: cropId, ...DEFAULT_CROP_STYLE };
  }

  // What a leaf should actually show at the CURRENT slider position, vs.
  // its fixed anchor cropId (still used for editing -- see setLeafCrop).
  // A leaf with no rotation data (freshly cut, or manually reassigned to a
  // crop that wasn't part of an applied plan) just shows its anchor crop at
  // every season, since there's nothing else to show for it.
  function displayCropIdForLeaf(leaf) {
    const entry = leaf.cropId ? rotationByCropId[leaf.cropId] : null;
    if (!entry || entry.rotation.perennial) return leaf.cropId;
    const step = entry.rotation.steps[seasonIndex];
    return step ? step.enterpriseId : null; // null = fallow this season
  }

  // The rotation step detail (profit, adjustment note) for a leaf at the
  // current slider position -- null when there's nothing to show (no
  // rotation data, or the segment is a year-round perennial).
  function rotationStepForLeaf(leaf) {
    const entry = leaf.cropId ? rotationByCropId[leaf.cropId] : null;
    if (!entry || entry.rotation.perennial) return null;
    return entry.rotation.steps[seasonIndex] ?? null;
  }

  const outerPolygon = useMemo(() => {
    if (polygon && polygon.length >= 3) return projectLatLngPolygon(polygon);
    if (boundingBox?.widthM > 0 && boundingBox?.heightM > 0) return rectPolygon(boundingBox.widthM, boundingBox.heightM);
    if (areaSqm > 0) {
      const side = Math.sqrt(areaSqm);
      return rectPolygon(side, side);
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polygon, boundingBox?.widthM, boundingBox?.heightM, areaSqm]);

  const polygonSignature = useMemo(
    () => (outerPolygon ? outerPolygon.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("|") : null),
    [outerPolygon]
  );

  function resetTree(newTree, appliedLayout = false) {
    setTreeState(newTree);
    setPast([]);
    setFuture([]);
    setSelectedLeafId(null);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setIsAppliedLayout(appliedLayout);
  }

  // Deliberately reads `tree` from the render closure rather than a
  // setState updater — updaters can be invoked more than once (React
  // StrictMode double-invokes them in dev), and pushing history as a side
  // effect inside one would double-record every commit.
  function commitTree(updaterOrValue) {
    const next = typeof updaterOrValue === "function" ? updaterOrValue(tree) : updaterOrValue;
    setPast((p) => [...p, tree]);
    setFuture([]);
    setTreeState(next);
  }

  function undo() {
    if (past.length === 0) return;
    const prevTree = past[past.length - 1];
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [tree, ...f]);
    setTreeState(prevTree);
    setSelectedLeafId(null);
  }

  function redo() {
    if (future.length === 0) return;
    const nextTree = future[0];
    setFuture((f) => f.slice(1));
    setPast((p) => [...p, tree]);
    setTreeState(nextTree);
    setSelectedLeafId(null);
  }

  useEffect(() => {
    if (!outerPolygon) {
      resetTree(null);
      return undefined;
    }

    // A layout just picked in Shuffle (see the pendingLayout effect below)
    // always wins here -- the farmer already made their choice, so this
    // effect must not also load a stored tree or fetch-and-open its own
    // picker on top of it. Without this guard, switching to this tab after
    // picking a layout would remount this component and race the two
    // effects, sometimes popping the "Choose a plan" modal right over the
    // layout that was just applied.
    if (pendingLayout) return undefined;

    // A layout already saved for this exact plot shape wins over fetching a
    // fresh random one — reopening the tab (or reloading the page) should
    // bring back your edits, not silently discard them for a new shuffle.
    // Stored as { tree, isAppliedLayout } so a picked-recommendation
    // blueprint still hides Shuffle after a tab switch or reload, not just
    // in the same render it was applied in; `stored.type` means it's a
    // legacy save from before that wrapping existed (a bare tree node).
    const stored = loadJSON(TREE_STORAGE_PREFIX + polygonSignature, null);
    if (stored) {
      const isLegacy = stored.type === "leaf" || stored.type === "split";
      resetTree(isLegacy ? stored : stored.tree, isLegacy ? false : stored.isAppliedLayout);
      return undefined;
    }

    // First-ever visit for this plot shape (custom build, not a picked
    // Shuffle layout -- see the pendingLayout guard above): compute the real
    // recommendation plans and open Blueprint already divided using the
    // actual top-ranked plan as a sensible starting point, rather than a
    // blank canvas -- "compute everything as soon as the plot is ready".
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetchRecommendationData(areaSqm, planContext)
      .then((data) => {
        if (cancelled) return;
        // allocationPlans is a list of scenario GROUPS ({key, plans: [...]}),
        // not a flat plan list -- flatten before treating any entry as one
        // plan (this exact mistake used to crash the now-removed "Choose a
        // plan" modal; fixed here too, same underlying shape).
        const topPlan = data.allocationPlans.flatMap((s) => s.plans)[0];
        if (!topPlan) throw new Error("no viable plan");
        const { cropSegments } = planToSegments(topPlan, data.areaAcre);
        resetTree(buildTreeFromShares(outerPolygon, cropSegments, "mixed"));
        setRotationByCropId(extractRotationMap(topPlan));
        setSeasonIndex(Math.max(0, SEASON_STEPS.findIndex((s) => s.key === data.season)));
      })
      .catch(() => {
        if (cancelled) return;
        resetTree(buildInitialTree(outerPolygon));
        setLoadError("Couldn't compute a recommended starting layout — showing a local default instead.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polygonSignature]);

  // Persist every edit (cuts, resizes, crop picks, shuffles, undo/redo)
  // against this plot's shape, so it survives a reload -- isAppliedLayout
  // travels alongside the tree so a picked-recommendation blueprint keeps
  // hiding Shuffle after a tab switch remounts this component, not just
  // immediately after applying it.
  useEffect(() => {
    if (!tree || !polygonSignature) return;
    saveJSON(TREE_STORAGE_PREFIX + polygonSignature, { tree, isAppliedLayout });
  }, [tree, polygonSignature, isAppliedLayout]);

  const totalLocalArea = useMemo(() => (outerPolygon ? polygonArea(outerPolygon) : 0), [outerPolygon]);
  const minArea = totalLocalArea * 0.02;

  const { scale, offsetX, offsetY, bounds } = useMemo(() => {
    if (!outerPolygon) return {};
    const b = polygonBounds(outerPolygon);
    const padding = 24;
    const maxW = VIEW_W - padding * 2;
    const maxH = VIEW_H - padding * 2;
    const w = b.maxX - b.minX || 1;
    const h = b.maxY - b.minY || 1;
    const s = Math.min(maxW / w, maxH / h);
    return { scale: s, offsetX: (VIEW_W - w * s) / 2, offsetY: (VIEW_H - h * s) / 2, bounds: b };
  }, [outerPolygon]);

  function toScreen(p) {
    return { x: offsetX + (p.x - bounds.minX) * scale, y: offsetY + (p.y - bounds.minY) * scale };
  }
  function pointsAttr(poly) {
    return poly.map((p) => toScreen(p)).map((p) => `${p.x},${p.y}`).join(" ");
  }
  // Uses the zoom/pan group's own CTM (not the <svg> root's) so the
  // conversion automatically accounts for the current zoom level — cutting
  // and resizing land in the right place regardless of how zoomed in you are.
  function localFromEvent(e) {
    const svg = svgRef.current;
    const zoomGroup = zoomGroupRef.current;
    if (!svg || !zoomGroup) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = zoomGroup.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: bounds.minX + (p.x - offsetX) / scale, y: bounds.minY + (p.y - offsetY) / scale };
  }

  // Screen point -> viewBox-space point (pre zoom/pan), used to anchor
  // zooming so the point under the cursor/center stays visually fixed.
  function viewBoxPointFromEvent(clientX, clientY) {
    const svg = svgRef.current;
    if (!svg) return { x: VIEW_W / 2, y: VIEW_H / 2 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: VIEW_W / 2, y: VIEW_H / 2 };
    return pt.matrixTransform(ctm.inverse());
  }

  function zoomAtScreenPoint(clientX, clientY, factor, currentZoom = zoom) {
    const anchor = viewBoxPointFromEvent(clientX, clientY);
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, currentZoom * factor));
    if (newZoom === currentZoom) return;
    setPan((prevPan) => ({
      x: prevPan.x + (currentZoom - newZoom) * anchor.x,
      y: prevPan.y + (currentZoom - newZoom) * anchor.y,
    }));
    setZoom(newZoom);
  }

  function zoomButton(factor) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAtScreenPoint(rect.x + rect.width / 2, rect.y + rect.height / 2, factor);
  }

  function resetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  // React's synthetic onWheel is registered as a passive listener, so
  // e.preventDefault() inside it is silently ignored (and logs a warning) —
  // scroll-to-zoom needs a real non-passive native listener instead.
  const zoomRef = useRef(zoom);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    function handleNativeWheel(e) {
      e.preventDefault();
      zoomAtScreenPoint(e.clientX, e.clientY, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, zoomRef.current);
    }
    svg.addEventListener("wheel", handleNativeWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleNativeWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!tree]);

  const isPanning = tool === "pan";

  const leaves = tree ? collectLeaves(tree) : [];
  const handles = tree && tool === "select" ? collectHandles(tree) : [];
  const selectedLeaf = leaves.find((l) => l.id === selectedLeafId) ?? null;
  const busy = loading || shuffling;
  const hasUnsetSegment = leaves.some((l) => !l.cropId);

  function handleRemove(leafId) {
    if (leaves.length <= 1) return;
    commitTree((t) => removeLeaf(t, leafId));
    if (selectedLeafId === leafId) setSelectedLeafId(null);
  }

  function handlePickCrop(cropId) {
    if (!selectedLeafId) return;
    commitTree((t) => setLeafCrop(t, selectedLeafId, cropId));
  }

  async function handleShuffle() {
    if (!outerPolygon || busy) return;
    setShuffling(true);
    setLoadError(null);
    setPlanNote(null);
    try {
      const { cropSegments, orientation } = await fetchRandomLayout();
      commitTree(buildTreeFromShares(outerPolygon, cropSegments, orientation));
    } catch {
      setLoadError("Shuffle failed — couldn't reach the backend.");
    } finally {
      setShuffling(false);
    }
  }

  // Hand-off from Shuffle's "Use this layout" button -- a /api/field-layouts
  // layout already carries the same shape planToSegments/extractRotationMap
  // expect (components with share, a parallel segments array with rotation),
  // just under a different top-level key than a /api/recommendations plan.
  useEffect(() => {
    if (!pendingLayout || !outerPolygon) return;
    const { cropSegments } = planToSegments(pendingLayout, pendingLayout.areaAcre);
    commitTree(buildTreeFromShares(outerPolygon, cropSegments, "mixed"));
    setSelectedLeafId(null);
    setRotationByCropId(extractRotationMap(pendingLayout));
    setSeasonIndex(Math.max(0, SEASON_STEPS.findIndex((s) => s.key === pendingLayout.anchorSeason)));
    const livestockNote = pendingLayout.livestockNote ? ` ${pendingLayout.livestockNote}` : "";
    setPlanNote(`Applied: ${pendingLayout.description}${livestockNote}`);
    setIsAppliedLayout(true);
    onConsumeLayout?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLayout, outerPolygon]);

  async function handleSaveLayout() {
    if (!leaves.length || hasUnsetSegment) return;
    setSaveStatus("saving");
    try {
      const payload = {
        areaSqm,
        segments: leaves.map((l) => ({
          cropId: l.cropId,
          share: polygonArea(l.polygon) / totalLocalArea,
        })),
      };
      const res = await fetch(`${API_BASE}/api/blueprint/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("save failed");
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus((s) => (s === "saved" ? "idle" : s)), 2500);
    } catch {
      setSaveStatus("error");
    }
  }

  function handleDividerDown(splitId, orientation, e) {
    e.stopPropagation();
    dragRef.current = { type: "resize", splitId, orientation, beforeTree: tree };
    setIsDragging(true);
  }

  function handleStagePointerDown(e) {
    if (!isPanning) return;
    dragRef.current = { type: "pan", startClientX: e.clientX, startClientY: e.clientY, startPan: pan };
    setIsDragging(true);
  }

  function handleLeafDown(leaf, e) {
    if (tool !== "cut-v" && tool !== "cut-h") return;
    if (leaves.length >= MAX_LEAVES) return;
    e.stopPropagation();
    const orientation = tool === "cut-v" ? "v" : "h";
    const local = localFromEvent(e);
    const position = orientation === "v" ? local.x : local.y;
    const seg = boundarySegment(leaf.polygon, orientation, position);
    dragRef.current = { type: "cut", leafId: leaf.id, leafPolygon: leaf.polygon, orientation, lastPosition: position };
    setPreview(seg ? { p1: seg[0], p2: seg[1] } : null);
    setIsDragging(true);
  }

  useEffect(() => {
    if (!isDragging) return undefined;

    function handleMove(e) {
      const d = dragRef.current;
      if (!d) return;
      if (d.type === "pan") {
        const svg = svgRef.current;
        const rect = svg?.getBoundingClientRect();
        if (!rect || !rect.width) return;
        const pxToViewBox = VIEW_W / rect.width;
        const dx = (e.clientX - d.startClientX) * pxToViewBox;
        const dy = (e.clientY - d.startClientY) * pxToViewBox;
        setPan({ x: d.startPan.x + dx, y: d.startPan.y + dy });
        return;
      }
      const local = localFromEvent(e);
      const pos = d.orientation === "v" ? local.x : local.y;
      if (d.type === "resize") {
        setTreeState((t) => updateSplitPosition(t, d.splitId, pos, minArea));
      } else if (d.type === "cut") {
        const seg = boundarySegment(d.leafPolygon, d.orientation, pos);
        setPreview(seg ? { p1: seg[0], p2: seg[1] } : null);
        dragRef.current = { ...d, lastPosition: pos };
      }
    }

    function handleUp() {
      const d = dragRef.current;
      if (d?.type === "resize") {
        setPast((p) => [...p, d.beforeTree]);
        setFuture([]);
      } else if (d?.type === "cut") {
        const newLeafId = `leaf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        commitTree((t) => replaceLeafWithSplit(t, d.leafId, d.orientation, d.lastPosition, minArea, newLeafId));
        setSelectedLeafId(newLeafId);
        setTool("select");
      }
      dragRef.current = null;
      setPreview(null);
      setIsDragging(false);
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDragging, minArea]);

  if (!outerPolygon) {
    return (
      <div className="blueprint-empty">
        <p className="hint">Trace or enter your plot in the Map tab first — the blueprint replicates its real shape.</p>
        <button className="btn-primary" onClick={onGoToMap}>
          Go to Map
        </button>
      </div>
    );
  }

  const totalAreaDisplay = formatNumber(convertArea(areaSqm, areaUnit));

  return (
    <>
      <div className="blueprint-canvas">
        <div className="blueprint-header">
          <div>
            <div className="section-label">Plot blueprint</div>
            <p className="hint">
              Your {totalAreaDisplay} {areaUnit} plot, real shape, editable. Pick a cutter to split a block, Select
              to resize or edit one. Scroll or use +/− to zoom, and the hand button to pan around.
            </p>
          </div>
          {loadError && <p className="region-note blueprint-load-error">ℹ️ {loadError}</p>}
          {planNote && <p className="region-note blueprint-plan-note">📊 {planNote}</p>}
        </div>

        {Object.keys(rotationByCropId).length > 0 && (
          <div className="blueprint-season-slider">
            <div className="blueprint-season-slider-labels">
              {SEASON_STEPS.map((s, i) => (
                <span key={s.key} className={i === seasonIndex ? "season-step-active" : ""}>
                  {s.label}
                </span>
              ))}
            </div>
            <input
              type="range"
              min={0}
              max={SEASON_STEPS.length - 1}
              step={1}
              value={seasonIndex}
              onChange={(e) => setSeasonIndex(Number(e.target.value))}
              className="season-slider-input"
              aria-label="Season in the crop rotation"
            />
            <p className="hint">
              Showing what grows where in <strong>{SEASON_STEPS[seasonIndex].label}</strong> — slide to step through
              the rest of the year's rotation, segment by segment.
            </p>
          </div>
        )}

        <div className="blueprint-stage">
          <div className="blueprint-floating-bar">
            <div className="chip-group chip-group-wrap blueprint-toolbar">
              {TOOLS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={`chip ${tool === t.key ? "chip-active" : ""}`}
                  onClick={() => setTool(t.key)}
                  disabled={busy}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="blueprint-actions">
              {!isAppliedLayout && (
                <button className="btn-float" onClick={handleShuffle} disabled={busy} title="New random layout">
                  {shuffling ? "…" : "🔀"}
                  <span>Shuffle</span>
                </button>
              )}
              <button className="btn-float" onClick={undo} disabled={busy || past.length === 0} title="Undo">
                ↶<span>Undo</span>
              </button>
              <button className="btn-float" onClick={redo} disabled={busy || future.length === 0} title="Redo">
                ↷<span>Redo</span>
              </button>
              <button
                className="btn-float btn-float-primary"
                onClick={handleSaveLayout}
                disabled={busy || saveStatus === "saving" || hasUnsetSegment}
                title={hasUnsetSegment ? "Choose a crop for every segment before saving" : "Save this layout"}
              >
                {saveStatus === "saving" ? "…" : "💾"}
                <span>{saveStatus === "saving" ? "Saving" : "Save"}</span>
              </button>
              {saveStatus === "saved" && <span className="save-status save-status-ok">Saved ✓</span>}
              {saveStatus === "error" && <span className="save-status save-status-error">Failed</span>}
            </div>
            {hasUnsetSegment && (
              <span className="hint blueprint-limit-note">Choose a crop for the new segment to save this layout.</span>
            )}
            {leaves.length >= MAX_LEAVES && (
              <span className="hint blueprint-limit-note">Segment limit reached — remove one to add another.</span>
            )}
          </div>

          {loading && !tree ? (
            <div className="blueprint-loading">
              <p className="hint">Fetching a starting layout…</p>
            </div>
          ) : (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
              className="blueprint-svg"
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label="Plot blueprint"
              onPointerDown={handleStagePointerDown}
              style={{ cursor: isPanning ? (isDragging ? "grabbing" : "grab") : undefined }}
            >
            <g ref={zoomGroupRef} transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
            <polygon points={pointsAttr(outerPolygon)} fill="none" stroke="#000" strokeWidth={2 / zoom} />

            {leaves.map((leaf) => {
              const displayId = displayCropIdForLeaf(leaf);
              const isFallowThisSeason = leaf.cropId != null && displayId == null;
              const crop = isFallowThisSeason
                ? FALLOW_CROP
                : (resolveCrop(displayId) ?? { icon: "❔", name: "Choose a crop", color: "#F0F0F0" });
              const screenPts = leaf.polygon.map(toScreen);
              const bbox = polygonBounds(screenPts);
              const areaShare = (polygonArea(leaf.polygon) / totalLocalArea) * areaSqm;
              const showLabel = bbox.maxX - bbox.minX > 70 && bbox.maxY - bbox.minY > 50;
              const isSelected = leaf.id === selectedLeafId;
              return (
                <g key={leaf.id}>
                  <polygon
                    points={pointsAttr(leaf.polygon)}
                    fill={crop.color}
                    stroke={isSelected ? "#06c167" : "#ffffff"}
                    strokeWidth={(isSelected ? 5 : 3) / zoom}
                    className="blueprint-block"
                    style={{
                      cursor: isPanning
                        ? "grab"
                        : tool === "select"
                          ? "pointer"
                          : tool === "cut-v"
                            ? "ew-resize"
                            : "ns-resize",
                    }}
                    onClick={tool === "select" ? () => setSelectedLeafId(leaf.id) : undefined}
                    onPointerDown={tool === "cut-v" || tool === "cut-h" ? (e) => handleLeafDown(leaf, e) : undefined}
                  />
                  {showLabel && (
                    <foreignObject
                      x={bbox.minX}
                      y={bbox.minY}
                      width={bbox.maxX - bbox.minX}
                      height={bbox.maxY - bbox.minY}
                      pointerEvents="none"
                    >
                      <div className="blueprint-block-label">
                        {leaf.isRecommended && <span className="blueprint-rec-badge">✨ Suggested</span>}
                        <span className="blueprint-block-icon">{crop.icon}</span>
                        <span className="blueprint-block-name">{crop.name}</span>
                        {displayId !== leaf.cropId && (
                          <span className="blueprint-block-rotation-note">{SEASON_STEPS[seasonIndex].label}</span>
                        )}
                        <span className="blueprint-block-area">
                          {formatNumber(convertArea(areaShare, areaUnit))} {areaUnit} ·{" "}
                          {Math.round((polygonArea(leaf.polygon) / totalLocalArea) * 100)}%
                        </span>
                      </div>
                    </foreignObject>
                  )}
                </g>
              );
            })}

            {preview && (
              <line
                x1={toScreen(preview.p1).x}
                y1={toScreen(preview.p1).y}
                x2={toScreen(preview.p2).x}
                y2={toScreen(preview.p2).y}
                stroke="#06c167"
                strokeWidth={3 / zoom}
                strokeDasharray={`${6 / zoom} ${4 / zoom}`}
                pointerEvents="none"
              />
            )}

            {handles.map((split) => {
              const seg = boundarySegment(split.parentPolygon, split.orientation, split.position);
              if (!seg) return null;
              const p1 = toScreen(seg[0]);
              const p2 = toScreen(seg[1]);
              const midX = (p1.x + p2.x) / 2;
              const midY = (p1.y + p2.y) / 2;
              const isV = split.orientation === "v";
              return (
                <g
                  key={split.id}
                  className="blueprint-handle"
                  style={{ cursor: isV ? "col-resize" : "row-resize" }}
                  onPointerDown={(e) => handleDividerDown(split.id, split.orientation, e)}
                >
                  <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="transparent" strokeWidth={14 / zoom} />
                  <rect
                    x={midX - (isV ? 2 : 14) / zoom}
                    y={midY - (isV ? 14 : 2) / zoom}
                    width={(isV ? 4 : 28) / zoom}
                    height={(isV ? 28 : 4) / zoom}
                    rx={2 / zoom}
                    fill="#000"
                  />
                </g>
              );
            })}
            </g>
          </svg>
          )}

          {tree && (
            <button
              className={`blueprint-pan-toggle ${tool === "pan" ? "blueprint-pan-toggle-active" : ""}`}
              onClick={() => setTool(tool === "pan" ? "select" : "pan")}
              aria-label="Pan tool"
              title="Pan / move the canvas"
            >
              🖐
            </button>
          )}

          {tree && (
            <div className="blueprint-zoom-controls">
              <button className="zoom-btn" onClick={() => zoomButton(ZOOM_STEP)} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in">
                +
              </button>
              <span className="zoom-level">{Math.round(zoom * 100)}%</span>
              <button className="zoom-btn" onClick={() => zoomButton(1 / ZOOM_STEP)} disabled={zoom <= MIN_ZOOM} aria-label="Zoom out">
                −
              </button>
              {(zoom !== 1 || pan.x !== 0 || pan.y !== 0) && (
                <button className="zoom-btn zoom-reset" onClick={resetView} aria-label="Reset zoom" title="Reset zoom">
                  ⤾
                </button>
              )}
            </div>
          )}
        </div>

        <div className="blueprint-legend">
          {leaves.map((leaf) => {
            const displayId = displayCropIdForLeaf(leaf);
            const isFallowThisSeason = leaf.cropId != null && displayId == null;
            const crop = isFallowThisSeason
              ? FALLOW_CROP
              : (resolveCrop(displayId) ?? { icon: "❔", name: "Choose a crop", color: "#F0F0F0" });
            const sharePct = Math.round((polygonArea(leaf.polygon) / totalLocalArea) * 100);
            return (
              <button
                key={leaf.id}
                className={`blueprint-legend-item ${leaf.id === selectedLeafId ? "legend-item-active" : ""}`}
                onClick={() => setSelectedLeafId(leaf.id)}
              >
                <span className="legend-swatch" style={{ background: crop.color }} />
                <span className="legend-name">
                  {crop.icon} {crop.name}
                </span>
                <span className="legend-share">{sharePct}%</span>
                <span
                  className="legend-remove"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemove(leaf.id);
                  }}
                  aria-label="Remove segment"
                >
                  ×
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="side-panel">
        <div className="segment-editor">
          <div className="section-label">Segment editor</div>
          {!selectedLeaf ? (
            <p className="hint">Click a segment on the blueprint (or in the list below it) to choose what's planted there.</p>
          ) : (
            <>
              <div className="segment-editor-meta">
                {selectedLeaf.isRecommended && <span className="pill pill-preference">✨ Suggested — not yet reviewed</span>}
                <div className="stat-mini">
                  <span className="stat-mini-label">This segment</span>
                  <span className="stat-mini-value">
                    {formatNumber(convertArea((polygonArea(selectedLeaf.polygon) / totalLocalArea) * areaSqm, areaUnit))}{" "}
                    {areaUnit} · {Math.round((polygonArea(selectedLeaf.polygon) / totalLocalArea) * 100)}% of plot
                  </span>
                </div>
              </div>

              {(() => {
                const step = rotationStepForLeaf(selectedLeaf);
                if (!step) return null;
                return (
                  <p className="hint blueprint-rotation-step">
                    {SEASON_STEPS[seasonIndex].label}: <strong>{step.name}</strong>
                    {step.profitAvg != null && ` — est. profit NPR ${step.profitAvg.toLocaleString("en-IN")}`}
                    {step.adjustment?.type === "legume-followup" && " 🌱 nitrogen-carryover boost from the previous legume"}
                    {step.adjustment?.type === "same-crop-repeat" && " ⚠️ repeats the previous season's crop here — yield penalty applied"}
                    {step.adjustment?.type === "disease-risk-family-repeat" &&
                      " ⚠️ follows a related crop — shared soil-disease risk, yield penalty applied"}
                  </p>
                );
              })()}

              <div className="section-label section-label-inset">What should grow here?</div>
              <div className="crop-picker-grid">
                {[...allEnterprises.map((e) => paletteMap[e.id]), FALLOW_CROP].map((crop) => (
                  <button
                    key={crop.id}
                    type="button"
                    className={`crop-option ${selectedLeaf.cropId === crop.id ? "crop-option-active" : ""}`}
                    onClick={() => handlePickCrop(crop.id)}
                  >
                    <span className="crop-option-icon">{crop.icon}</span>
                    <span className="crop-option-name">{crop.name}</span>
                  </button>
                ))}
              </div>
              <p className="disclaimer">
                Real enterprises from the recommendation engine's dataset. Economics (profit/cost) per segment aren't
                shown here yet.
              </p>

              <button
                className="btn-secondary btn-block"
                onClick={() => handleRemove(selectedLeaf.id)}
                disabled={leaves.length <= 1}
              >
                Remove this segment
              </button>
            </>
          )}
        </div>
      </div>

    </>
  );
}
