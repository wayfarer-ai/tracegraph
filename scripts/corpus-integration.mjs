#!/usr/bin/env node
/** Full-corpus integration run against the spike's real trial data.
 *
 * Not a unit test: exercises the whole pipeline on every trajectory the
 * spike produced (~240 traces, 3 tool vocabularies, 2 models, 1 known-bad
 * trace) and asserts the known ground truth:
 *
 *   - clustering separates exactly the expected populations
 *   - per-population synthesis yields clean guards with high agreement
 *   - check across everything flags EXACTLY the one known deviation
 *   - the whole thing stays fast (<5s for the full corpus)
 *
 * Skips gracefully when the spike data isn't present (CI on other machines).
 * Run: node scripts/corpus-integration.mjs
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = new URL("../dist/index.js", import.meta.url).href;
const {
  loadAtifTrace,
  clusterByVocabulary,
  synthesize,
  checkTraces,
  guardToString,
} = await import(DIST);

const ROOT = "/Volumes/T9-Mac/wayfarer/agent-testing/experiments/refund-task/local-jobs";
if (!existsSync(ROOT)) {
  console.log("corpus not present on this machine — skipping (not a failure)");
  process.exit(0);
}

const KNOWN_BAD = "leg-v0-sonnet/refund-ORD-4199__a1";
let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log(`  ok: ${msg}`);
  else {
    failures += 1;
    console.error(`  FAIL: ${msg}`);
  }
};

const t0 = performance.now();
const traces = [];
for (const job of readdirSync(ROOT)) {
  const jobDir = join(ROOT, job);
  if (!statSync(jobDir).isDirectory()) continue;
  for (const trial of readdirSync(jobDir)) {
    const traj = join(jobDir, trial, "agent", "trajectory.json");
    if (existsSync(traj)) {
      const t = loadAtifTrace(traj);
      t.id = `${job}/${trial}`;
      traces.push(t);
    }
  }
}
console.log(`loaded ${traces.length} traces from ${ROOT}`);
assert(traces.length >= 200, `corpus is substantial (${traces.length} >= 200)`);

const clusters = clusterByVocabulary(traces);
console.log(`\nclusters: ${clusters.map((c) => c.length).join(", ")}`);
assert(clusters.length === 3, `exactly 3 tool vocabularies (v2-names, v1-names, v0-opaque), got ${clusters.length}`);

let totalDeviations = 0;
const deviantIds = [];
for (const cluster of clusters) {
  const { spec, actionTool, trainingAgreement, positives, negatives } = synthesize(cluster);
  const gate = spec.steps.find((s) => s.kind === "gate");
  console.log(
    `\ncluster of ${cluster.length}: action=${actionTool} ` +
      `(+${positives}/-${negatives}) agreement=${(trainingAgreement * 100).toFixed(1)}%`,
  );
  console.log(`  guard: ${guardToString(gate.guard)}`);
  assert(trainingAgreement >= 0.93, `training agreement >= 93%`);
  assert(gate.guard.length > 0, "non-trivial guard induced");

  const report = checkTraces(cluster, spec);
  totalDeviations += report.deviations;
  for (const r of report.results) if (!r.conformant) deviantIds.push(r.traceId);
}

console.log(`\ntotal deviations across corpus: ${totalDeviations}`);
assert(
  deviantIds.length === 1 && deviantIds[0] === KNOWN_BAD,
  `exactly one deviation, the known bad trace (got: ${deviantIds.join(", ") || "none"})`,
);

const elapsed = performance.now() - t0;
console.log(`\nelapsed: ${elapsed.toFixed(0)}ms`);
assert(elapsed < 5000, `full corpus under 5s (${elapsed.toFixed(0)}ms)`);

process.exit(failures ? 1 : 0);
