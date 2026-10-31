// Runs 3 real prompts (one per crop, using the actual question templates)
// against the local Ollama model and reports real tokens/sec + latency, so
// the full-run time estimate is measured on this machine, not guessed.
import { execSync } from "child_process";

const OLLAMA_URL = "http://localhost:11434/api/generate";
const MODEL = process.env.KD_MODEL ?? "qwen2.5:7b-instruct";

const samplePrompts = [
  `You are an agricultural expert on Nepal farming systems.
For Rice (Paddy) grown in the terai zone of Nepal during the kharif season, list 2-4 real, agronomically documented companion crops or plants commonly intercropped or planted alongside it.
For each one give: the companion's common name, then a one-sentence mechanism (nitrogen fixing, pest deterrence, shade/canopy complementarity, disease suppression, etc.).
If you are not confident a specific relationship is well-documented for South Asia/Nepal specifically (rather than a general assumption), say so explicitly instead of presenting it as certain.
Respond with ONLY lines in this exact format, nothing else:
- <companion name> | <mechanism, one sentence> | confidence: <high|medium|low>`,
  `You are an agricultural expert on Nepal farming systems.
For Maize (Makai) grown in the hills zone of Nepal during the kharif season, describe the manure/compost/organic soil-amendment practices commonly used.
Include: what is typically applied, approximate timing relative to planting, and approximate quantity if you know a real figure (say "no specific figure known" rather than inventing one).
Flag whether this is Nepal-specific documented practice or a general regional (South Asia) assumption.
Respond in 3-5 sentences, plain text, ending with: confidence: <high|medium|low>`,
  `You are an agricultural expert on Nepal farming systems.
Beyond a single year, what multi-year (2-4 year) crop rotation sequence is commonly recommended agronomically after Potato (Aalu) grown in the terai zone of Nepal (planted in rabi season), to maintain soil health?
Name 2-3 real crops that would typically follow it in sequence, and briefly why (nitrogen needs, pest-cycle break, market rotation).
Respond in 3-5 sentences, plain text, ending with: confidence: <high|medium|low>`,
];

async function main() {
  console.log(`Benchmarking model: ${MODEL}\n`);
  let totalTokens = 0;
  let totalSec = 0;
  let totalLoadMs = 0;

  for (const [i, prompt] of samplePrompts.entries()) {
    const t0 = Date.now();
    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, prompt, stream: false }),
    });
    if (!res.ok) throw new Error(`Ollama request failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const wallMs = Date.now() - t0;
    const evalSec = data.eval_duration / 1e9;
    const loadMs = (data.load_duration ?? 0) / 1e6;
    const tokPerSec = data.eval_count / evalSec;

    totalTokens += data.eval_count;
    totalSec += evalSec;
    totalLoadMs += loadMs;

    console.log(`Prompt ${i + 1}: ${data.eval_count} tokens generated in ${evalSec.toFixed(1)}s (${tokPerSec.toFixed(1)} tok/s), wall time ${(wallMs / 1000).toFixed(1)}s, model-load overhead ${loadMs.toFixed(0)}ms`);
    console.log(`  Response preview: ${data.response.slice(0, 150).replace(/\n/g, " ")}...\n`);
  }

  const avgTokPerSec = totalTokens / totalSec;
  const avgTokensPerResponse = totalTokens / samplePrompts.length;
  console.log(`\n=== Summary ===`);
  console.log(`Average: ${avgTokPerSec.toFixed(1)} tokens/sec, ${avgTokensPerResponse.toFixed(0)} tokens/response`);
  console.log(`Model load overhead (first call only, then stays warm): ${totalLoadMs.toFixed(0)}ms total across calls`);

  const TOTAL_JOBS = 1424; // from the real enterprises.json scenario count (356 scenarios x 4 question types)
  const secPerJob = avgTokensPerResponse / avgTokPerSec;
  const totalSecEstimate = TOTAL_JOBS * secPerJob;
  console.log(`\nEstimated full run: ${TOTAL_JOBS} prompts x ~${secPerJob.toFixed(1)}s/prompt = ${(totalSecEstimate / 3600).toFixed(1)} hours`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
