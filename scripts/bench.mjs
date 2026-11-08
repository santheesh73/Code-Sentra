#!/usr/bin/env node
// Performance benchmarks with budgets (Section 3).
//
// Measures the CPU-bound hot paths that dominate a Scan — claim tokenization and source
// parsing — and fails if any median exceeds its committed budget (scripts/bench-budgets.json).
// Hermetic: pure in-process work, embedded tree-sitter WASM, no network, no Docker.
//
// Budgets are regression alarms with generous headroom, not targets. The scaling ratio is
// machine-independent and is the strongest signal: it catches accidental super-linear work
// regardless of how fast or loaded the CI runner is. Run with `pnpm bench`.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { concreteTokens } from "../packages/claims/dist/index.js";
import { parseFile, useEmbeddedWasm } from "../packages/parsers/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(root, "scripts/bench-budgets.json"), "utf8"));
const { warmup, measured } = cfg.iterations;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Median wall time (ms) of `fn` over `measured` runs, after `warmup` untimed runs.
async function timeMedian(fn) {
  for (let i = 0; i < warmup; i++) await fn();
  const samples = [];
  for (let i = 0; i < measured; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

function tsSource(nDecls) {
  return Array.from(
    { length: nDecls },
    (_, i) =>
      `import { f${i} } from "./m${i}";\n` +
      `export function g${i}(a: number, b: string): number {\n` +
      `  const x = a + ${i};\n  return f${i}(x) + b.length;\n}\n` +
      `class C${i} { value = ${i}; method(): number { return this.value * 2; } }\n`,
  ).join("\n");
}

const results = [];
const record = (metric, value, unit) => {
  const budget = cfg.budgets[metric]?.ceiling;
  const pass = budget === undefined ? true : value <= budget;
  results.push({ metric, value, unit, budget, pass });
};

// --- Workload 1: claim tokenization over the real corpus --------------------------------
{
  const corpus = JSON.parse(
    readFileSync(join(root, "packages/claims/test-fixtures/corpus.json"), "utf8"),
  );
  const texts = [...corpus.false, ...corpus.true].map((e) => e.text);
  const pass = () => {
    for (const t of texts) concreteTokens(t);
  };
  record("claims.verify_corpus_pass_ms", await timeMedian(pass), "ms");
}

// --- Workload 2: source parsing (embedded WASM) + scaling guard -------------------------
{
  useEmbeddedWasm();
  const N = 30;
  const srcN = tsSource(N);
  const src2N = tsSource(N * 2);
  // Prime the parser once so WASM init is not charged to the first sample.
  await parseFile("bench.ts", srcN);

  const parseOnce = (src) => parseFile("bench.ts", src);
  const medN = await timeMedian(() => parseOnce(srcN));
  const med2N = await timeMedian(() => parseOnce(src2N));

  record("parsers.per_file_ms", medN, "ms");
  record("parsers.scaling_ratio_2x", med2N / medN, "x");
}

// --- Report -----------------------------------------------------------------------------
process.stdout.write("\nCodeSentra performance budgets\n");
process.stdout.write("────────────────────────────────────────────────────────────\n");
for (const r of results) {
  const val = `${r.value.toFixed(r.unit === "x" ? 2 : 2)}${r.unit}`;
  const cap = r.budget === undefined ? "—" : `${r.budget}${r.unit}`;
  process.stdout.write(
    `${r.pass ? "ok  " : "FAIL"} ${r.metric.padEnd(34)} ${val.padStart(10)}  (budget ${cap})\n`,
  );
}
process.stdout.write("────────────────────────────────────────────────────────────\n");

const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  process.stderr.write(
    `\n${failed.length} budget(s) exceeded:\n${failed
      .map(
        (r) =>
          `  - ${r.metric}: ${r.value.toFixed(2)}${r.unit} > ${r.budget}${r.unit} (${cfg.budgets[r.metric].what})`,
      )
      .join("\n")}\n`,
  );
  process.exit(1);
}
process.stdout.write("all within budget\n");
