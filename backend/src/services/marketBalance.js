import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dirname, "../data/recommendationLog.json");

// ---------- Market-balance / diversification layer ----------
// Every other scoring rule in this app answers "what's good for THIS
// farmer" -- this one answers a different question: if many farmers use
// this app and all get pointed at the same "best" crop, that advice
// becomes self-defeating (flooded local supply, crashed price) exactly
// because everyone followed it. This is a real, well-known failure mode of
// single-signal advisory systems (crop advisories, robo-advisors, even
// traffic-routing all have this), and no amount of model sophistication
// fixes it, because it isn't a missing-accuracy problem -- it's a missing
// SIGNAL problem: nothing in this app tracked "how many other farmers in
// this zone were just told to grow this" until now.
//
// Deliberately NOT folded into a crop's displayed cost/profit/revenue --
// those stay real economics only. This only nudges RANKING (see scoring.js
// SCENARIOS), and is surfaced to the user as its own transparent field
// (marketSaturation) so it's never mistaken for a claim about the crop's
// own economics.

// A rolling window, not permanent memory -- farmers plant across a season,
// not all on one day, so "how many recent recommendations pointed here"
// should decay rather than accumulate forever. 45 days approximates a
// typical Nepal sowing window; not real adoption-tracking data (none
// exists yet), a transparent, tunable threshold like every other
// adjustment in this codebase.
const SATURATION_WINDOW_DAYS = 45;
const SATURATION_FLOOR = 0.85; // worst case: a 15% ranking penalty
const SATURATION_COUNT_AT_FLOOR = 20; // recent recommendations before the penalty maxes out

function loadLog() {
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveLog(events) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, JSON.stringify(events, null, 2));
}

function pruneOld(events) {
  const cutoff = Date.now() - SATURATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return events.filter((e) => e.timestamp >= cutoff);
}

// Called once per /api/recommendations request (see routes/recommendations.js),
// after scoring -- records which crop(s) this request's top pick pointed
// to, so later requests in the same zone can be nudged toward something
// else. Read-heavy, write-light: this is the only function that persists.
export function recordRecommendation(zone, cropIds) {
  const events = pruneOld(loadLog());
  const timestamp = Date.now();
  for (const cropId of cropIds) events.push({ zone, cropId, timestamp });
  saveLog(events);
}

function multiplierFromCount(count) {
  const fraction = Math.min(1, count / SATURATION_COUNT_AT_FLOOR);
  return 1 - fraction * (1 - SATURATION_FLOOR);
}

// 1.0 = this crop hasn't been recommended much in this zone recently;
// decays toward SATURATION_FLOOR the more it has been. Fine for a one-off
// check, but NEVER call this in a hot loop -- see buildSaturationLookup.
export function saturationMultiplier(zone, cropId) {
  const events = pruneOld(loadLog());
  const count = events.filter((e) => e.zone === zone && e.cropId === cropId).length;
  return multiplierFromCount(count);
}

// scoring.js's scenario ranking calls the saturation lookup once per crop
// on EVERY plan comparison during sorting -- potentially thousands of
// calls for one request across a large candidate pool. Reading and
// JSON-parsing the log file that many times (saturationMultiplier does,
// per call) turned a single request into a multi-second-to-effectively-
// frozen synchronous block, wedging Node's single-threaded event loop for
// every OTHER concurrent request too. This reads the log exactly ONCE per
// request and returns a cheap in-memory closure for the rest of scoring to
// call as often as it wants -- same numbers, O(1) after the first read
// instead of O(log size) per call.
export function buildSaturationLookup(zone) {
  const events = pruneOld(loadLog());
  const counts = new Map();
  for (const e of events) {
    if (e.zone !== zone) continue;
    counts.set(e.cropId, (counts.get(e.cropId) ?? 0) + 1);
  }
  return (cropId) => multiplierFromCount(counts.get(cropId) ?? 0);
}
