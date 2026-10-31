import { useEffect, useState } from "react";
import GrowingTips from "./GrowingTips";

const API_BASE = "http://localhost:4000";
const SHARE_STEP = 0.05;

function fmt(n) {
  return `NPR ${n.toLocaleString("en-IN")}`;
}

function riskPillClass(label) {
  if (label === "Low") return "pill-risk-low";
  if (label === "Medium") return "pill-risk-medium";
  return "pill-risk-high";
}

// Plain-language pros/cons, built entirely from numbers the backend already
// computes (agronomic fit reasons, risk label, ROI, companion effects,
// affordability) -- never a new judgment invented for this view. Deliberately
// shows BOTH sides together: a con here doesn't mean "skip this", it means
// "here's the tradeoff" -- the farmer decides, not the app.
function buildProsCons(candidate) {
  const pros = [];
  const cons = [];

  if (candidate.fit.soilExact) pros.push("Well suited to your soil type");
  else cons.push("Only broadly tolerant of your soil type");

  if (candidate.fit.waterExact) pros.push("Well suited to your water source");
  else cons.push("Only broadly tolerant of your water source");

  if (candidate.projected.riskLabel === "Low") pros.push("Low risk (stable price, low water dependence, low capital lock-in)");
  else if (candidate.projected.riskLabel === "High") cons.push("High risk (price swings, water dependence, or capital lock-in)");

  if (candidate.standalone.roiPercent != null) {
    if (candidate.standalone.roiPercent >= 150) pros.push(`Strong estimated return (${candidate.standalone.roiPercent}% ROI)`);
    else if (candidate.standalone.roiPercent < 50) cons.push(`Modest estimated return (${candidate.standalone.roiPercent}% ROI)`);
  }

  if (candidate.newCompanionMatches.some((m) => m.effect === "synergy")) {
    pros.push("Helps a crop you've already placed (see below)");
  }
  if (candidate.newCompanionMatches.some((m) => m.effect === "caution")) {
    cons.push("May compete with a crop you've already placed (see below)");
  }

  if (candidate.projected.affordable === false) cons.push("Would exceed your stated budget at this size");

  return { pros, cons };
}

function UsageBar({ label, used, total, usedLabel, totalLabel }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return (
    <div className="usage-bar-block">
      <div className="usage-bar-labels">
        <span>{label}</span>
        <span>
          {usedLabel} of {totalLabel} used
        </span>
      </div>
      <div className="usage-bar">
        <div className="usage-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// One eligible next move -- name, one profit number, one risk badge, and a
// short pros/cons list. No pipeline breakdown, no jargon -- the detailed
// numbers are still there once something's placed, just not on every
// candidate up front.
function CandidateCard({ candidate, onAdd, disabled, zone, season }) {
  const { pros, cons } = buildProsCons(candidate);
  return (
    <li className={`rec-card build-candidate ${candidate.projected.affordable === false ? "unaffordable" : ""}`}>
      <div className="rec-header">
        <strong className="rec-name">{candidate.name}</strong>
        <span className={`pill ${riskPillClass(candidate.projected.riskLabel)}`}>{candidate.projected.riskLabel} risk</span>
      </div>
      <div className="rec-metrics">
        <div className="rec-profit">
          <span className="rec-profit-label">Est. profit at {candidate.proposal.shareLabel}</span>
          <span className="rec-profit-value">{fmt(candidate.standalone.profitAvg)}</span>
        </div>
        {candidate.standalone.roiPercent != null && <span className="pill pill-roi">ROI {candidate.standalone.roiPercent}%</span>}
      </div>
      <div className="pros-cons">
        {pros.map((p, i) => (
          <div key={`p${i}`} className="pro-line">
            ✅ {p}
          </div>
        ))}
        {cons.map((c, i) => (
          <div key={`c${i}`} className="con-line">
            ⚠️ {c}
          </div>
        ))}
      </div>
      {candidate.newCompanionMatches.length > 0 && (
        <p className="hint">{candidate.newCompanionMatches[0].mechanism}</p>
      )}
      {candidate.category === "crop" && (
        <GrowingTips cropId={candidate.id} cropName={candidate.name} zone={zone} season={season} />
      )}
      <button type="button" className="btn-optimize" onClick={() => onAdd(candidate)} disabled={disabled}>
        ➕ Add {candidate.name}
      </button>
    </li>
  );
}

// One placed piece -- direct +/- controls to grow or shrink it (within
// what's actually left), not a separate "how much" dialog. Livestock steps
// by whole units instead of land share.
function PlacedItem({ item, onAdjustShare, onAdjustUnits, onRemove, disabled, maxShare }) {
  const isCrop = item.share != null;
  return (
    <li className="rec-card placed-item">
      <div className="rec-header">
        <strong className="rec-name">{item.name}</strong>
        <span className="pill pill-muted">{item.shareLabel}</span>
      </div>
      <div className="rec-metrics">
        <span className="hint">Cost {fmt(item.cost)}</span>
        <span className="hint">Profit {fmt(item.profitAvg)}</span>
      </div>
      <div className="stepper-row">
        {isCrop ? (
          <>
            <button type="button" className="stepper-btn" onClick={() => onAdjustShare(item.id, -SHARE_STEP)} disabled={disabled}>
              −
            </button>
            <span className="stepper-value">{Math.round(item.share * 100)}% of land</span>
            <button
              type="button"
              className="stepper-btn"
              onClick={() => onAdjustShare(item.id, SHARE_STEP)}
              disabled={disabled || item.share >= maxShare - 0.001}
            >
              +
            </button>
          </>
        ) : (
          <>
            <button type="button" className="stepper-btn" onClick={() => onAdjustUnits(item.id, -1)} disabled={disabled}>
              −
            </button>
            <span className="stepper-value">{item.shareLabel}</span>
            <button type="button" className="stepper-btn" onClick={() => onAdjustUnits(item.id, 1)} disabled={disabled}>
              +
            </button>
          </>
        )}
        <button type="button" className="chip chip-sm placed-remove" onClick={() => onRemove(item.id)} disabled={disabled}>
          ✕ Remove
        </button>
      </div>
    </li>
  );
}

// Piece-by-piece planner: pick a crop/animal that fits, see plain pros and
// cons, add it, then directly grow or shrink it with +/- controls -- all
// within the farmer's own budget. Every number is the same rule engine as
// the shuffle view, just scored fresh against whatever's already placed.
export default function BuildPlanner({ areaSqm, zone, soilType, waterSource, season, budget, onUseLayout }) {
  const [placed, setPlaced] = useState([]);
  const [move, setMove] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showAll, setShowAll] = useState(false);

  const reqCtx = {
    areaSqm,
    soilType,
    waterSource,
    season: season || undefined,
    budget: budget ? parseFloat(budget) : undefined,
    zone,
  };

  async function fetchMove(nextPlaced) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/next-move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...reqCtx, placed: nextPlaced }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      setMove(await res.json());
    } catch (err) {
      setError(err.message);
      setMove(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (areaSqm > 0) {
      setPlaced([]);
      setShowAll(false);
      fetchMove([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaSqm, zone, soilType, waterSource, season, budget]);

  // New additions default to half of what's proposed (half the land share,
  // or half the affordable unit count for livestock) -- not all of it,
  // crop or animal alike. Easier to grow into more with the +/- controls
  // afterward than to accidentally commit the whole remaining budget (a
  // livestock proposal already sized to fit ALL of it) to the first pick.
  function handleAdd(candidate) {
    const entry =
      candidate.proposal.share != null
        ? { id: candidate.id, share: Math.round(candidate.proposal.share * 0.5 * 1000) / 1000 }
        : { id: candidate.id, units: Math.max(1, Math.round(candidate.proposal.units * 0.5)) };
    const nextPlaced = [...placed, entry];
    setPlaced(nextPlaced);
    setShowAll(false);
    fetchMove(nextPlaced);
  }

  function handleAdjustShare(id, delta) {
    const nextPlaced = placed
      .map((p) => (p.id === id ? { ...p, share: Math.round(Math.max(0, (p.share ?? 0) + delta) * 1000) / 1000 } : p))
      .filter((p) => p.share == null || p.share > 0.001);
    setPlaced(nextPlaced);
    fetchMove(nextPlaced);
  }

  function handleAdjustUnits(id, delta) {
    const nextPlaced = placed
      .map((p) => (p.id === id ? { ...p, units: Math.max(0, (p.units ?? 0) + delta) } : p))
      .filter((p) => p.units == null || p.units > 0);
    setPlaced(nextPlaced);
    fetchMove(nextPlaced);
  }

  function handleRemove(id) {
    const nextPlaced = placed.filter((p) => p.id !== id);
    setPlaced(nextPlaced);
    setShowAll(false);
    fetchMove(nextPlaced);
  }

  function handleStartOver() {
    setPlaced([]);
    setShowAll(false);
    fetchMove([]);
  }

  // Hands this custom-built plan off to Blueprint the same way a Shuffle
  // layout is -- same pendingLayout shape (App's handleUseLayout doesn't
  // care whether it came from Shuffle or Build mode), so the farmer isn't
  // stuck manually re-dividing their plot to match what they just built
  // piece by piece here.
  function handleSendToBlueprint() {
    if (!move?.placed || !onUseLayout) return;
    onUseLayout({
      components: move.placed.components,
      leftoverAreaAcre: move.remainingAreaAcre,
      areaAcre: move.areaAcre,
      anchorSeason: move.season,
      description: "Your custom Build-my-farm plan",
    });
  }

  if (!areaSqm) return null;

  const candidates = move?.candidates ?? [];
  const visibleCandidates = showAll ? candidates : candidates.slice(0, 6);
  const isDone = move && move.remainingAreaAcre <= 0.01 && candidates.length === 0;
  const remainingShareFraction = move ? move.remainingAreaAcre / move.areaAcre : 0;
  const budgetNum = budget ? parseFloat(budget) : null;

  return (
    <div className="build-planner">
      <p className="hint">
        Add one crop or animal at a time, within your own budget. Every genuinely eligible option is shown with plain
        pros and cons — grow or shrink anything you've placed with the +/− controls.
      </p>

      {move && (
        <div className="usage-bars">
          <UsageBar
            label="Land"
            used={move.areaAcre - move.remainingAreaAcre}
            total={move.areaAcre}
            usedLabel={`${Math.round((move.areaAcre - move.remainingAreaAcre) * 100) / 100} acre`}
            totalLabel={`${move.areaAcre} acre`}
          />
          {budgetNum != null && (
            <UsageBar
              label="Budget"
              used={budgetNum - (move.remainingBudget ?? budgetNum)}
              total={budgetNum}
              usedLabel={fmt(budgetNum - (move.remainingBudget ?? budgetNum))}
              totalLabel={fmt(budgetNum)}
            />
          )}
        </div>
      )}

      {placed.length > 0 && (
        <button type="button" className="chip chip-sm" onClick={handleStartOver} disabled={loading}>
          🔄 Start over
        </button>
      )}

      {move?.placed && (
        <div className="build-placed">
          <div className="section-label section-label-inset">Your plan so far</div>
          <ul className="rec-list">
            {move.placed.components.map((c) => (
              <PlacedItem
                key={c.id}
                item={c}
                onAdjustShare={handleAdjustShare}
                onAdjustUnits={handleAdjustUnits}
                onRemove={handleRemove}
                disabled={loading}
                maxShare={(c.share ?? 0) + remainingShareFraction}
              />
            ))}
          </ul>
          <div className="investment-breakdown">
            <div className="breakdown-row breakdown-total">
              <span>Total so far</span>
              <span>
                {fmt(move.placed.totalCost)} invested → {fmt(move.placed.totalProfitAvg)} profit
              </span>
            </div>
          </div>
          {onUseLayout && (
            <button type="button" className="btn-primary btn-block btn-accent" onClick={handleSendToBlueprint}>
              📐 Send this plan to my Blueprint
            </button>
          )}
          <details className="rec-details">
            <summary>Full detail (season timing, month-by-month)</summary>
            <ul className="plan-component-list">
              {move.placed.components.map((c) => (
                <li key={c.id}>
                  <strong>{c.name}</strong> ({c.shareLabel}, {c.riskLabel.toLowerCase()} risk)
                  {c.segmentTimeline && (
                    <p className="hint segment-timeline">
                      {c.segmentTimeline.perennial
                        ? `🌳 ${c.segmentTimeline.note}`
                        : `📅 Rest of year: ${c.segmentTimeline.explanation} Full-year profit: ${fmt(c.segmentTimeline.totalProfit)}.`}
                    </p>
                  )}
                  {c.monthlyGrid && (
                    <div className="monthly-grid">
                      {c.monthlyGrid.map((g) => (
                        <div
                          key={g.month}
                          className={`month-cell ${
                            g.cropId === null ? "month-cell-fallow" : g.cropId === c.id ? "month-cell-active" : "month-cell-other"
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
          </details>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {isDone && (
        <p className="hint build-done">
          🎉 Your plot is fully allocated. Use the +/− controls above or remove a piece if you'd like to change
          anything.
        </p>
      )}

      {!isDone && move && (
        <>
          <div className="section-label section-label-inset">
            {loading ? "Scoring…" : `What can grow here (${candidates.length} option${candidates.length === 1 ? "" : "s"})`}
          </div>
          {!loading && candidates.length === 0 && (
            <p className="hint">Nothing else fits your remaining land/budget for this zone/season/soil/water combination.</p>
          )}
          <ul className="rec-list">
            {visibleCandidates.map((c) => (
              <CandidateCard key={c.id} candidate={c} onAdd={handleAdd} disabled={loading} zone={move.zone} season={move.season} />
            ))}
          </ul>
          {candidates.length > 6 && (
            <button type="button" className="chip chip-sm" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer options" : `Show all ${candidates.length} options`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
