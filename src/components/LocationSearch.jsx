import { useState } from "react";

// Free-text place search using OpenStreetMap's Nominatim geocoder so users
// can jump the map to their village/town before tracing their plot.
export default function LocationSearch({ onLocate }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  async function search(e) {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(
        query
      )}`;
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
      });
      const data = await res.json();
      setResults(data);
    } catch (err) {
      console.error("Location search failed", err);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  function pick(result) {
    onLocate({ lat: parseFloat(result.lat), lng: parseFloat(result.lon) });
    setResults([]);
    setQuery(result.display_name);
  }

  return (
    <div className="location-search">
      <form onSubmit={search}>
        <input
          type="text"
          placeholder="Search village, town, or address..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" disabled={loading}>
          {loading ? "..." : "Go"}
        </button>
      </form>
      {results.length > 0 && (
        <ul className="location-results">
          {results.map((r) => (
            <li key={r.place_id} onClick={() => pick(r)}>
              {r.display_name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
