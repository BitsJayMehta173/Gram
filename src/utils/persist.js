// Thin localStorage wrapper — every call is guarded since storage can throw
// (private browsing, quota, disabled) and a persistence failure should never
// break the app, just silently skip saving/restoring.
export function loadJSON(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore — persistence is a nice-to-have, not load-bearing
  }
}

export function removeKey(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
