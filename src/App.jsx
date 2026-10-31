import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import PlotMap from "./components/PlotMap";
import LocationSearch from "./components/LocationSearch";
import DetailsPanel from "./components/DetailsPanel";
import RecommendationPanel from "./components/RecommendationPanel";
import PlotBlueprint from "./components/PlotBlueprint";
import { analyzePolygon } from "./utils/geoCalculations";
import { loadJSON, saveJSON } from "./utils/persist";
import "./App.css";

const API_BASE = "http://localhost:4000";
const PLOT_STORAGE_KEY = "gram:plot:v1";

// Defaults match this project's Sunsari/Terai pilot focus, so the
// recommendation-dependent features (Blueprint's "Choose a plan") work out
// of the box — but these are farmer-editable in the Map tab, not fixed.
const DEFAULT_ZONE = "terai";
const DEFAULT_SOIL_TYPE = "alluvial";
const DEFAULT_WATER_SOURCE = "irrigated";

const emptyManual = {
  areaInput: "",
  areaUnitKey: "acre",
  areaSqm: 0,
  widthInput: "",
  heightInput: "",
  dimUnitKey: "m",
  widthM: 0,
  heightM: 0,
};

// Read once at module load (client-only app, no SSR) so every field below
// can lazily seed itself from whatever was last saved in this browser.
const savedPlot = loadJSON(PLOT_STORAGE_KEY, null);

export default function App() {
  const [activeTab, setActiveTab] = useState("map");
  const [flyToLocation, setFlyToLocation] = useState(savedPlot?.flyToLocation ?? null);
  const [polygon, setPolygon] = useState(savedPlot?.polygon ?? null);
  const [areaUnit, setAreaUnit] = useState(savedPlot?.areaUnit ?? "acre");
  const [lengthUnit, setLengthUnit] = useState(savedPlot?.lengthUnit ?? "m");
  const [useManual, setUseManual] = useState(savedPlot?.useManual ?? false);
  const [manual, setManual] = useState(savedPlot?.manual ?? emptyManual);
  const [zone, setZone] = useState(savedPlot?.zone ?? DEFAULT_ZONE);
  const [soilType, setSoilType] = useState(savedPlot?.soilType ?? DEFAULT_SOIL_TYPE);
  const [waterSource, setWaterSource] = useState(savedPlot?.waterSource ?? DEFAULT_WATER_SOURCE);
  const [season, setSeason] = useState(savedPlot?.season ?? "");
  const [budget, setBudget] = useState(savedPlot?.budget ?? "");
  const [savedPlots, setSavedPlots] = useState([]);
  // A field layout picked in the Recommendations tab's Shuffle view, handed
  // off to Blueprint so it can build the real geometric division for it —
  // Blueprint consumes and clears this itself (see onConsumeLayout) once
  // applied, so switching tabs again doesn't reapply it.
  const [pendingLayout, setPendingLayout] = useState(null);

  function handleUseLayout(layout) {
    setPendingLayout(layout);
    setActiveTab("blueprint");
  }

  useEffect(() => {
    saveJSON(PLOT_STORAGE_KEY, {
      flyToLocation,
      polygon,
      areaUnit,
      lengthUnit,
      useManual,
      manual,
      zone,
      soilType,
      waterSource,
      season,
      budget,
    });
  }, [flyToLocation, polygon, areaUnit, lengthUnit, useManual, manual, zone, soilType, waterSource, season, budget]);

  const computed = useMemo(() => analyzePolygon(polygon), [polygon]);
  const currentAreaSqm = useManual ? manual.areaSqm : computed?.areaSqm ?? null;
  const currentBoundingBox = useManual ? { widthM: manual.widthM, heightM: manual.heightM } : computed?.boundingBox ?? null;
  const currentLocation = computed?.centroid ?? flyToLocation ?? null;

  // Real elevation + rainfall for the traced plot's centroid, looked up as
  // soon as a polygon exists -- see geoConditions.js for exactly what is
  // (elevation, rainfall) and isn't (soil type/pH) auto-detected, and why.
  const [geoConditions, setGeoConditions] = useState(null);
  const [geoLoading, setGeoLoading] = useState(false);
  // Guards against auto-overwriting a zone the farmer already chose --
  // skips auto-apply on this component's first successful geo-lookup (which
  // may be for a plot restored from a previous session), applying only on
  // later lookups (a real redraw/new trace). Tried seeding this from
  // whether a plot was actually restored at mount (auto-apply even on a
  // fresh session's very first trace) -- reverted after live testing showed
  // it broke the restore-protection case instead, so a brand-new user's
  // very first trace doesn't auto-suggest a zone; they see the elevation/
  // rainfall readout and can redraw or pick manually. That's a smaller gap
  // than silently overwriting a returning farmer's saved choice.
  const hasRunGeoLookupRef = useRef(false);
  const centroidSignature = computed?.centroid
    ? `${computed.centroid.lat.toFixed(5)},${computed.centroid.lng.toFixed(5)}`
    : null;

  useEffect(() => {
    if (!computed?.centroid) {
      setGeoConditions(null);
      return undefined;
    }
    // Captured, not mutated, here -- React 18 StrictMode double-invokes
    // effects in dev (mount -> cleanup -> mount again, synchronously,
    // before any fetch resolves). Mutating the ref eagerly at the top of
    // the effect made the SECOND (real) invocation see the ref already
    // flipped by the FIRST (cancelled) one, so it no longer looked like the
    // first run and silently auto-applied over a restored zone. The ref is
    // only actually advanced once a non-cancelled response lands below.
    const isFirstRun = !hasRunGeoLookupRef.current;

    let cancelled = false;
    setGeoLoading(true);
    fetch(`${API_BASE}/api/geo-conditions?lat=${computed.centroid.lat}&lng=${computed.centroid.lng}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        hasRunGeoLookupRef.current = true;
        setGeoConditions(data);
        if (data.suggestedZone && !isFirstRun) setZone(data.suggestedZone);
      })
      .catch(() => {
        if (cancelled) return;
        hasRunGeoLookupRef.current = true;
        setGeoConditions(null);
      })
      .finally(() => {
        if (!cancelled) setGeoLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centroidSignature]);

  const handlePolygonChange = useCallback((latLngs) => {
    setPolygon(latLngs);
  }, []);

  function handleSave() {
    const plot = {
      id: Date.now(),
      createdAt: new Date().toISOString(),
      source: useManual ? "manual" : "map",
      polygon: useManual ? null : polygon,
      location: currentLocation,
      areaSqm: useManual ? manual.areaSqm : computed?.areaSqm ?? null,
      boundingBox: useManual
        ? { widthM: manual.widthM, heightM: manual.heightM }
        : computed?.boundingBox ?? null,
      perimeterM: useManual ? null : computed?.perimeterM ?? null,
    };
    setSavedPlots((plots) => [...plots, plot]);

    const blob = new Blob([JSON.stringify(plot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `plot-${plot.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">🌾</span>
          <div className="brand-text">
            <h1>Gram</h1>
            <span className="brand-tagline">Map your land. Know what to grow.</span>
          </div>
        </div>
        <LocationSearch onLocate={setFlyToLocation} />
      </header>

      <div className="tab-bar">
        <button className={`tab-btn ${activeTab === "map" ? "tab-active" : ""}`} onClick={() => setActiveTab("map")}>
          1. Map
        </button>
        <button
          className={`tab-btn ${activeTab === "recommendations" ? "tab-active" : ""}`}
          onClick={() => setActiveTab("recommendations")}
        >
          2. Recommendations
        </button>
        <button
          className={`tab-btn ${activeTab === "blueprint" ? "tab-active" : ""}`}
          onClick={() => setActiveTab("blueprint")}
        >
          3. Blueprint
        </button>
      </div>

      {activeTab === "map" ? (
        <div className="app-body">
          <div className="map-wrap">
            <PlotMap flyToLocation={flyToLocation} onPolygonChange={handlePolygonChange} />
          </div>
          <div className="side-panel">
            <DetailsPanel
              computed={computed}
              areaUnit={areaUnit}
              setAreaUnit={setAreaUnit}
              lengthUnit={lengthUnit}
              setLengthUnit={setLengthUnit}
              manual={manual}
              setManual={setManual}
              useManual={useManual}
              setUseManual={setUseManual}
              zone={zone}
              setZone={setZone}
              soilType={soilType}
              setSoilType={setSoilType}
              waterSource={waterSource}
              setWaterSource={setWaterSource}
              season={season}
              setSeason={setSeason}
              budget={budget}
              setBudget={setBudget}
              onSave={handleSave}
              hasPlot={!!polygon}
              geoConditions={geoConditions}
              geoLoading={geoLoading}
            />
          </div>
        </div>
      ) : activeTab === "recommendations" ? (
        <div className="app-body app-body-single">
          <RecommendationPanel
            areaSqm={currentAreaSqm}
            location={currentLocation}
            zone={zone}
            setZone={setZone}
            soilType={soilType}
            setSoilType={setSoilType}
            waterSource={waterSource}
            setWaterSource={setWaterSource}
            season={season}
            setSeason={setSeason}
            budget={budget}
            setBudget={setBudget}
            onGoToMap={() => setActiveTab("map")}
            onUseLayout={handleUseLayout}
          />
        </div>
      ) : (
        <div className="app-body">
          <PlotBlueprint
            areaSqm={currentAreaSqm}
            boundingBox={currentBoundingBox}
            polygon={useManual ? null : polygon}
            areaUnit={areaUnit}
            zone={zone}
            soilType={soilType}
            waterSource={waterSource}
            season={season}
            budget={budget}
            onGoToMap={() => setActiveTab("map")}
            pendingLayout={pendingLayout}
            onConsumeLayout={() => setPendingLayout(null)}
          />
        </div>
      )}

      {savedPlots.length > 0 && (
        <footer className="saved-list">
          <strong>Saved plots this session:</strong> {savedPlots.length}
        </footer>
      )}
    </div>
  );
}
