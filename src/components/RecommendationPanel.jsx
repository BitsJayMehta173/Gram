import { useEffect, useState } from "react";
import { ZONES, SOIL_TYPES, WATER_SOURCES, SEASONS } from "../utils/plotOptions";
import BuildPlanner from "./BuildPlanner";
import GrowingTips from "./GrowingTips";

const API_BASE = "http://localhost:4000";

function ChipSelect({ options, value, onChange }) {
  return (
    <div className="chip-group chip-group-wrap">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`chip ${value === o.key ? "chip-active" : ""}`}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function fmt(n) {
  return `NPR ${n.toLocaleString("en-IN")}`;
}

// Coverage badge color reused from the risk-pill palette (green/amber/red)
// purely as a visual utility here -- "high land-year coverage" maps to the
// same green as "low risk" without implying anything about risk.
function coveragePillClass(score) {
  if (score >= 0.9) return "pill-risk-low";
  if (score >= 0.6) return "pill-risk-medium";
  return "pill-risk-high";
}

// One full-field layout card -- deliberately NOT ranked (no medals, no "best
// plan" framing): every layout here is a genuinely different way to
// structure the same field, browsed rather than picked-for-you, so farmers
// don't all converge on the one recommendation with the biggest number and
// flood the same local market with it. Ordered by how much of the YEAR the
// land stays productive (see fieldLayouts.js), shown as a coverage badge;
// profit/ROI are still shown, just as secondary context, not the headline.
// The full field-formation breakdown (every segment, its share, and what
// grows there across the year) is shown directly on the card, not tucked
// behind a click -- this is a wide grid card now, there's room, and "give
// all the information about the formation of field" was the explicit ask.
function FieldLayoutCard({ layout, index, onUse, anchorSeason, areaAcre, zone }) {
  const cropSegments = layout.segments.filter((seg) => seg.id !== "fallow");
  return (
    <li className={`rec-card plan-card layout-card ${layout.affordable === false ? "unaffordable" : ""}`}>
      <div className="rec-header">
        <span className="rec-rank">#{index + 1}</span>
        <div className="plan-components">
          {layout.components.map((c) => (
            <span key={c.id} className="plan-chip">
              {c.name} <span className="plan-chip-share">{c.shareLabel}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="rec-metrics rec-metrics-secondary">
        <span className={`pill ${coveragePillClass(layout.productivityScore)}`}>
          {Math.round(layout.productivityScore * 100)}% of the year in use
        </span>
        {layout.companionMatches?.some((m) => m.effect === "synergy") && (
          <span className="pill pill-risk-low">🤝 Companion boost</span>
        )}
        {layout.roiPercent != null && <span className="pill pill-roi">ROI {layout.roiPercent}%</span>}
      </div>
      {layout.affordable === false && (
        <p className="rec-warning">
          💰 Costs {fmt(layout.budgetShortfall)} more than your stated budget — shown anyway so you can decide for
          yourself (save up, adjust the budget, or use Build mode to size it down).
        </p>
      )}
      <p className="rec-explanation">{layout.description}</p>
      {layout.livestockNote && <p className="hint">{layout.livestockNote}</p>}
      <div className="rec-profit">
        <span className="rec-profit-label">Est. full-year profit</span>
        <span className="rec-profit-value">{fmt(layout.totalProfitAvg)}</span>
      </div>

      <div className="field-formation">
        <div className="section-label section-label-inset">Field formation — segment by segment</div>
        <ul className="segment-list">
          {layout.segments.map((seg) => (
            <li key={seg.id} className="segment-row">
              <div className="segment-row-head">
                <strong>{seg.name}</strong>
                <span className="pill pill-muted">{seg.shareLabel}</span>
              </div>
              {seg.rotation.perennial ? (
                <p className="hint segment-timeline">🌳 {seg.rotation.note}</p>
              ) : (
                <p className="hint segment-timeline">📅 {seg.rotation.explanation}</p>
              )}
              {seg.monthlyGrid && (
                <div className="monthly-grid">
                  {seg.monthlyGrid.map((g) => (
                    <div
                      key={g.month}
                      className={`month-cell ${
                        g.cropId === null ? "month-cell-fallow" : g.cropId === seg.id ? "month-cell-active" : "month-cell-other"
                      }`}
                      title={`${g.month}: ${g.cropName}${g.stage ? ` (${g.stage.replaceAll("_", " ")})` : ""}`}
                    >
                      {g.month[0]}
                    </div>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      {layout.companionMatches?.length > 0 && (
        <details className="rec-details">
          <summary>Companion planting effects in this layout</summary>
          <ul className="plan-component-list">
            {layout.companionMatches.map((m, idx) => (
              <li key={idx}>
                {m.effect === "synergy" ? "🤝" : "⚠️"} <strong>{m.cropNames.join(" + ")}</strong>: {m.mechanism}
              </li>
            ))}
          </ul>
        </details>
      )}

      {layout.aiCompanionMatches?.length > 0 && (
        <details className="rec-details">
          <summary>🌱 AI-suggested companion pairings in this layout (unverified)</summary>
          <ul className="plan-component-list">
            {layout.aiCompanionMatches.map((m, idx) => (
              <li key={idx}>
                🌱 <strong>{m.cropNames.join(" + ")}</strong>: {m.detail}{" "}
                <span className="hint">
                  ({m.confidence} confidence, {m.sources.length} model{m.sources.length === 1 ? "" : "s"} — not
                  cross-validated, not counted toward this layout's profit)
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {cropSegments.length > 0 && (
        <details className="rec-details growing-tips-group">
          <summary>🌱 AI growing tips for this layout's crops (unverified)</summary>
          <div className="growing-tips-group-body">
            {cropSegments.map((seg) => (
              <GrowingTips key={seg.id} cropId={seg.id} cropName={seg.name} zone={zone} season={anchorSeason} />
            ))}
          </div>
        </details>
      )}

      {layout.leftoverAreaAcre > 0 && (
        <p className="rec-warning rec-fallow">🌱 {layout.leftoverAreaAcre} acre left unassigned this season</p>
      )}
      <button
        type="button"
        className="btn-primary btn-block btn-accent"
        onClick={() => onUse({ ...layout, anchorSeason, areaAcre })}
      >
        📐 Use this layout on my Blueprint
      </button>
    </li>
  );
}

export default function RecommendationPanel({
  areaSqm,
  zone,
  setZone,
  soilType,
  setSoilType,
  waterSource,
  setWaterSource,
  season,
  setSeason,
  budget,
  setBudget,
  onGoToMap,
  onUseLayout,
}) {
  const [mode, setMode] = useState("build"); // "build" | "shuffle"
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showAllLayouts, setShowAllLayouts] = useState(false);
  const LAYOUTS_PREVIEW_COUNT = 10;

  // Shuffle: a browsable set of full-year field layouts, not one ranked
  // "best" plan -- see fieldLayouts.js for why (a ranked #1 plan gets
  // followed by everyone who sees it, flooding whatever it picks).
  async function fetchFieldLayouts() {
    setLoading(true);
    setError(null);
    setShowAllLayouts(false);
    try {
      const res = await fetch(`${API_BASE}/api/field-layouts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          areaSqm,
          soilType,
          waterSource,
          zone,
          season: season || undefined,
          budget: budget ? parseFloat(budget) : undefined,
        }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `Request failed (${res.status})`);
      }
      setResult(await res.json());
    } catch (err) {
      setError(err.message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  // Only the shuffle view needs a fetch on load/change -- build mode fetches
  // its own data lazily once you switch to it (see BuildPlanner).
  useEffect(() => {
    if (areaSqm > 0 && mode === "shuffle") fetchFieldLayouts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaSqm, mode]);

  function handleSubmit(e) {
    e.preventDefault();
    if (mode === "shuffle") fetchFieldLayouts();
  }

  return (
    <div className="recommendation-panel">
      <div className="section-label">Get recommendations</div>
      {!areaSqm ? (
        <div className="blueprint-empty">
          <p className="hint">Trace or enter your plot in the Map tab first — recommendations scale with your area.</p>
          <button className="btn-primary" onClick={onGoToMap}>
            Go to Map
          </button>
        </div>
      ) : (
        <>
          <form onSubmit={handleSubmit} className="recommendation-form">
            <div className="chip-field">
              <label>Zone</label>
              <ChipSelect options={ZONES} value={zone} onChange={setZone} />
            </div>
            <div className="chip-field">
              <label>Soil</label>
              <ChipSelect options={SOIL_TYPES} value={soilType} onChange={setSoilType} />
            </div>
            <div className="chip-field">
              <label>Water</label>
              <ChipSelect options={WATER_SOURCES} value={waterSource} onChange={setWaterSource} />
            </div>
            <div className="chip-field">
              <label>Season</label>
              <ChipSelect options={SEASONS} value={season} onChange={setSeason} />
            </div>
            <div className="budget-field">
              <label htmlFor="budget-input">Your budget</label>
              <div className="budget-input-wrap">
                <span className="budget-prefix">NPR</span>
                <input
                  id="budget-input"
                  type="number"
                  min="0"
                  placeholder="Available capital"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                />
              </div>
            </div>
            {mode === "shuffle" && (
              <button type="submit" className="btn-primary btn-block btn-accent" disabled={loading}>
                {loading ? "Scoring…" : result ? "🔄 Show layouts again" : "✨ Show me the field"}
              </button>
            )}
          </form>

          <div className="chip-group mode-toggle">
            <button type="button" className={`chip ${mode === "build" ? "chip-active" : ""}`} onClick={() => setMode("build")}>
              🧩 Build my farm
            </button>
            <button
              type="button"
              className={`chip ${mode === "shuffle" ? "chip-active" : ""}`}
              onClick={() => setMode("shuffle")}
            >
              🔀 Shuffle recommendations
            </button>
          </div>

          {mode === "build" && (
            <BuildPlanner
              areaSqm={areaSqm}
              zone={zone}
              soilType={soilType}
              waterSource={waterSource}
              season={season}
              budget={budget}
              onUseLayout={onUseLayout}
            />
          )}

          {mode === "shuffle" && error && <p className="error">{error}</p>}

          {mode === "shuffle" && result && (
            <div className="recommendation-results">
              <p className="context-line">
                {result.region} · {result.zone} · {result.season} season · {result.areaAcre} acre
              </p>
              <p className="hint">
                {result.layouts.length} different ways to structure this field for the full year — browsed, not
                ranked by profit. Each card shows the full segment-by-segment breakdown, and each has an optional
                🌱 AI growing tips section (companion planting, soil prep, pest management) generated by a local AI
                model and cross-checked against this app's verified data.
              </p>

              {result.layouts.length === 0 && (
                <p className="hint">No viable field layout for this zone/season/soil/water combination yet.</p>
              )}
              <ul className="rec-list">
                {(showAllLayouts ? result.layouts : result.layouts.slice(0, LAYOUTS_PREVIEW_COUNT)).map((layout, i) => (
                  <FieldLayoutCard
                    key={layout.id}
                    layout={layout}
                    index={i}
                    onUse={onUseLayout}
                    anchorSeason={result.season}
                    areaAcre={result.areaAcre}
                    zone={zone}
                  />
                ))}
              </ul>
              {result.layouts.length > LAYOUTS_PREVIEW_COUNT && (
                <button type="button" className="chip chip-sm" onClick={() => setShowAllLayouts((v) => !v)}>
                  {showAllLayouts ? "Show fewer options" : `Show all ${result.layouts.length} options`}
                </button>
              )}

              <p className="disclaimer">{result.disclaimer}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
