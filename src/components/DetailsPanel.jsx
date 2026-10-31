import { AREA_UNITS, LENGTH_UNITS, convertArea, convertLength, formatNumber } from "../utils/units";
import { ZONES, SOIL_TYPES, WATER_SOURCES, SEASONS } from "../utils/plotOptions";
import SoilInputsReference from "./SoilInputsReference";

const PRIMARY_AREA_UNITS = AREA_UNITS.filter((u) => u.region === "universal");
const REGIONAL_AREA_UNITS = AREA_UNITS.filter((u) => u.region !== "universal");

function ConditionChips({ label, options, value, onChange }) {
  return (
    <div className="chip-field">
      <label>{label}</label>
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
    </div>
  );
}

export default function DetailsPanel({
  computed,
  areaUnit,
  setAreaUnit,
  lengthUnit,
  setLengthUnit,
  manual,
  setManual,
  useManual,
  setUseManual,
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
  onSave,
  hasPlot,
  geoConditions,
  geoLoading,
}) {
  const areaSqm = useManual ? manual.areaSqm : computed?.areaSqm;
  const widthM = useManual ? manual.widthM : computed?.boundingBox?.widthM;
  const heightM = useManual ? manual.heightM : computed?.boundingBox?.heightM;
  const perimeterM = computed?.perimeterM;
  const isRegionalUnit = REGIONAL_AREA_UNITS.some((u) => u.key === areaUnit);

  function handleManualAreaChange(value) {
    const unit = manual.areaUnitKey;
    const numeric = parseFloat(value) || 0;
    const sqm = numeric * (AREA_UNITS.find((u) => u.key === unit)?.sqm ?? 1);
    setManual((m) => ({ ...m, areaInput: value, areaSqm: sqm }));
  }

  function handleManualAreaUnitChange(unitKey) {
    const numeric = parseFloat(manual.areaInput) || 0;
    const sqm = numeric * (AREA_UNITS.find((u) => u.key === unitKey)?.sqm ?? 1);
    setManual((m) => ({ ...m, areaUnitKey: unitKey, areaSqm: sqm }));
  }

  function handleManualLengthChange(field, value) {
    const numeric = parseFloat(value) || 0;
    const meters = numeric * (LENGTH_UNITS.find((u) => u.key === manual.dimUnitKey)?.meters ?? 1);
    setManual((m) => ({
      ...m,
      [`${field}Input`]: value,
      [`${field}M`]: meters,
    }));
  }

  function handleManualDimUnitChange(unitKey) {
    setManual((m) => {
      const factor = LENGTH_UNITS.find((u) => u.key === unitKey)?.meters ?? 1;
      const widthNumeric = parseFloat(m.widthInput) || 0;
      const heightNumeric = parseFloat(m.heightInput) || 0;
      return {
        ...m,
        dimUnitKey: unitKey,
        widthM: widthNumeric * factor,
        heightM: heightNumeric * factor,
      };
    });
  }

  return (
    <div className="details-panel">
      <div className="section-label">Your plot</div>

      <div className="hero-stat">
        <div className="hero-value">{formatNumber(convertArea(areaSqm ?? 0, areaUnit))}</div>
        <div className="hero-unit-row">
          <div className="chip-group">
            {PRIMARY_AREA_UNITS.map((u) => (
              <button
                key={u.key}
                type="button"
                className={`chip ${areaUnit === u.key ? "chip-active" : ""}`}
                onClick={() => setAreaUnit(u.key)}
              >
                {u.short}
              </button>
            ))}
          </div>
          <details className="unit-more" open={isRegionalUnit}>
            <summary>Regional units</summary>
            <select value={isRegionalUnit ? areaUnit : ""} onChange={(e) => setAreaUnit(e.target.value)}>
              <option value="" disabled>
                Choose a regional unit…
              </option>
              {REGIONAL_AREA_UNITS.map((u) => (
                <option key={u.key} value={u.key}>
                  {u.label}
                </option>
              ))}
            </select>
          </details>
        </div>
      </div>

      <div className="stat-row-secondary">
        <div className="stat-mini">
          <span className="stat-mini-label">Length × width{!useManual && " (approx.)"}</span>
          <span className="stat-mini-value">
            {formatNumber(convertLength(heightM ?? 0, lengthUnit))} × {formatNumber(convertLength(widthM ?? 0, lengthUnit))}
          </span>
        </div>
        <div className="chip-group chip-group-sm">
          {LENGTH_UNITS.map((u) => (
            <button
              key={u.key}
              type="button"
              className={`chip chip-sm ${lengthUnit === u.key ? "chip-active" : ""}`}
              onClick={() => setLengthUnit(u.key)}
            >
              {u.key}
            </button>
          ))}
        </div>
      </div>

      {!useManual && perimeterM != null && (
        <div className="stat-mini">
          <span className="stat-mini-label">Perimeter</span>
          <span className="stat-mini-value">{formatNumber(convertLength(perimeterM, lengthUnit))} {lengthUnit}</span>
        </div>
      )}

      {!useManual && !hasPlot && (
        <p className="hint">
          Search your location, then trace your plot with the polygon or rectangle tool (top-left of the map).
        </p>
      )}

      <div className="section-label section-label-inset">Growing conditions</div>
      <p className="hint">Used to filter and rank what can actually grow here.</p>

      {geoLoading && <p className="hint">📍 Looking up elevation and rainfall for this location…</p>}

      {!geoLoading && geoConditions && (geoConditions.elevationM != null || geoConditions.annualRainfallMm != null) && (
        <div className="geo-readout">
          <div className="geo-readout-row">
            {geoConditions.elevationM != null && (
              <span className="hint">⛰ {geoConditions.elevationM.toLocaleString("en-IN")} m elevation</span>
            )}
            {geoConditions.annualRainfallMm != null && (
              <span className="hint">
                🌧 {geoConditions.annualRainfallMm.toLocaleString("en-IN")} mm rain ({geoConditions.rainfallPeriod})
              </span>
            )}
          </div>
          {geoConditions.suggestedZone && (
            <p className="hint">Zone auto-suggested from elevation — check it's right, and adjust below if not.</p>
          )}
        </div>
      )}

      {!geoLoading && geoConditions?.warnings?.length > 0 && (
        <details className="rec-details">
          <summary>Why isn't everything auto-detected?</summary>
          <ul className="plan-component-list">
            {geoConditions.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}

      <SoilInputsReference />

      <ConditionChips label="Zone" options={ZONES} value={zone} onChange={setZone} />
      <ConditionChips label="Soil" options={SOIL_TYPES} value={soilType} onChange={setSoilType} />
      <ConditionChips label="Water source" options={WATER_SOURCES} value={waterSource} onChange={setWaterSource} />
      <ConditionChips label="Season" options={SEASONS} value={season} onChange={setSeason} />

      <div className="budget-field">
        <label htmlFor="plot-budget-input">Budget (optional)</label>
        <div className="budget-input-wrap">
          <span className="budget-prefix">NPR</span>
          <input
            id="plot-budget-input"
            type="number"
            min="0"
            placeholder="Available capital"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
        </div>
      </div>

      <label className="switch-row">
        <span>Enter measurements manually instead</span>
        <span className="switch">
          <input type="checkbox" checked={useManual} onChange={(e) => setUseManual(e.target.checked)} />
          <span className="switch-track" />
        </span>
      </label>

      {useManual && (
        <div className="manual-form">
          <div className="field-row">
            <label>Area</label>
            <input
              type="number"
              min="0"
              value={manual.areaInput}
              onChange={(e) => handleManualAreaChange(e.target.value)}
              placeholder="0"
            />
            <select value={manual.areaUnitKey} onChange={(e) => handleManualAreaUnitChange(e.target.value)}>
              {AREA_UNITS.map((u) => (
                <option key={u.key} value={u.key}>
                  {u.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field-row">
            <label>Length</label>
            <input
              type="number"
              min="0"
              value={manual.heightInput}
              onChange={(e) => handleManualLengthChange("height", e.target.value)}
              placeholder="0"
            />
            <label>Width</label>
            <input
              type="number"
              min="0"
              value={manual.widthInput}
              onChange={(e) => handleManualLengthChange("width", e.target.value)}
              placeholder="0"
            />
            <select value={manual.dimUnitKey} onChange={(e) => handleManualDimUnitChange(e.target.value)}>
              {LENGTH_UNITS.map((u) => (
                <option key={u.key} value={u.key}>
                  {u.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <button className="btn-primary btn-block" onClick={onSave} disabled={!areaSqm}>
        Save Plot
      </button>
    </div>
  );
}
