import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import enterpriseData from "../data/enterprises.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "../data/savedBlueprints.json");

const router = Router();

// Real enterprise ids (same source of truth as /api/enterprises and the
// scoring engine) plus "fallow" for rested/unallocated land. No ML/scoring
// happens here at all — this just hands back a plausible-looking random
// partition of the plot so the blueprint editor has something to start from
// and to "shuffle" into; using real ids just means the random layout shows
// real crop/livestock names instead of a separate, disconnected mock list.
const CROP_IDS = [...enterpriseData.enterprises.map((e) => e.id), "fallow"];
const ORIENTATIONS = ["v", "h", "mixed"];

// Saved layouts persist to a JSON file on disk so they survive a server
// restart. Still just a flat file, not a real database — fine for this
// prototype's scale, but worth upgrading if this ever needs concurrent
// writers or real query needs.
function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function persistStore(store) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

let store = loadStore();

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomLayout() {
  const segmentCount = randomInt(2, 5);
  const rawShares = Array.from({ length: segmentCount }, () => Math.random() + 0.2);
  const total = rawShares.reduce((s, v) => s + v, 0);

  const usedCrops = new Set();
  const segments = rawShares.map((raw) => {
    let cropId = CROP_IDS[randomInt(0, CROP_IDS.length - 1)];
    // Prefer a crop not already used in this layout, when one's available —
    // keeps small layouts (2-3 segments) from randomly repeating the same crop.
    if (usedCrops.size < CROP_IDS.length) {
      let attempts = 0;
      while (usedCrops.has(cropId) && attempts < 10) {
        cropId = CROP_IDS[randomInt(0, CROP_IDS.length - 1)];
        attempts += 1;
      }
    }
    usedCrops.add(cropId);
    return { cropId, share: Math.round((raw / total) * 1000) / 1000 };
  });

  return { segments, orientation: ORIENTATIONS[randomInt(0, ORIENTATIONS.length - 1)] };
}

router.post("/blueprint/random", (req, res) => {
  res.json({ ...randomLayout(), generatedAt: new Date().toISOString() });
});

router.post("/blueprint/save", (req, res) => {
  const { areaSqm, segments, zone, location } = req.body ?? {};

  if (!Array.isArray(segments) || segments.length === 0) {
    return res.status(400).json({ error: "segments must be a non-empty array" });
  }
  for (const seg of segments) {
    if (typeof seg.cropId !== "string" || !Number.isFinite(seg.share)) {
      return res.status(400).json({ error: "each segment needs a cropId string and a numeric share" });
    }
  }

  const id = `bp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    areaSqm: Number.isFinite(areaSqm) ? areaSqm : null,
    zone: zone ?? null,
    location: location ?? null,
    segments,
    savedAt: new Date().toISOString(),
  };
  store[id] = record;
  persistStore(store);

  res.json({ id, savedAt: record.savedAt });
});

router.get("/blueprint/:id", (req, res) => {
  const record = store[req.params.id];
  if (!record) return res.status(404).json({ error: "No saved blueprint with that id" });
  res.json(record);
});

export default router;
