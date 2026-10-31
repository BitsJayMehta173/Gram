import { useState } from "react";

const API_BASE = "http://localhost:4000";

// Real N-P-K% and cost-per-kg reference data (urea/DAP/MOP plus FYM/compost/
// vermicompost/biogas slurry) -- see soilInputs.json's own disclaimer for why
// this deliberately stops at reference numbers rather than a per-crop dosing
// recommendation. Fetched lazily, same pattern as GrowingTips.jsx.
function InputRow({ input }) {
  const { nPercent, p2o5Percent, k2oPercent } = input.nutrientContent;
  return (
    <li>
      <strong>{input.name}</strong> <span className="hint">({input.type})</span>
      <p className="hint">
        N {nPercent}% · P₂O₅ {p2o5Percent}% · K₂O {k2oPercent}%
        {input.costPerKg != null ? ` · NPR ${input.costPerKg}/kg` : " · not typically purchased (on-farm byproduct)"}
      </p>
    </li>
  );
}

export default function SoilInputsReference() {
  const [data, setData] = useState(undefined); // undefined = not fetched yet, null = fetch failed
  const [loading, setLoading] = useState(false);

  function handleToggle(e) {
    if (!e.target.open || data !== undefined) return;
    setLoading(true);
    fetch(`${API_BASE}/api/soil-inputs`)
      .then((res) => res.json())
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }

  return (
    <details className="rec-details" onToggle={handleToggle}>
      <summary>🧪 Fertilizer & manure reference</summary>
      {loading && <p className="hint">Loading…</p>}
      {data === null && <p className="hint">Couldn't load fertilizer/manure reference data.</p>}
      {data && (
        <div className="growing-tips-body">
          <p className="hint disclaimer">{data.disclaimer}</p>
          <ul className="plan-component-list">
            {data.inputs.map((input) => (
              <InputRow key={input.id} input={input} />
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}
