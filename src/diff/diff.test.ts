import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAtifTrace } from "../trace/atif.js";
import { synthesize } from "../synth/index.js";
import { diffSpecs, renderDiff } from "./index.js";
import type { Trace } from "../trace/types.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures");

function loadDir(dir: string): Trace[] {
  const manifest = JSON.parse(
    readFileSync(join(dir, "manifest.json"), "utf8"),
  ) as Record<string, Record<string, unknown>>;
  return Object.keys(manifest).map((f) => loadAtifTrace(join(dir, f), manifest[f] ?? {}));
}

const sonnet = loadDir(FIXTURES);
const haiku = loadDir(join(FIXTURES, "haiku"));

describe("real threshold move: pre-probe vs post-probe corpus", () => {
  // The probe round's whole point: totals {0, 10, ...} induce a boundary at
  // 5; adding probes at {0.5, 1} sharpens it to 0.25. Reproduce from the
  // actual corpus lineage by splitting on the probe totals.
  const preProbe = sonnet.filter((t) => ![0.5, 1.0].includes(t.meta["total"] as number));
  const withProbe = sonnet;
  const a = synthesize(preProbe, { name: "pre-probe", guardScope: ["get_order"] }).spec;
  const b = synthesize(withProbe, { name: "post-probe", guardScope: ["get_order"] }).spec;

  it("reports the sharpening as a threshold move, not remove+add noise", () => {
    const d = diffSpecs(a, b);
    expect(d.identical).toBe(false);
    const gate = d.gates[0]!;
    // from=40, not the full corpus's 5: the fixture subset's nearest
    // observed totals on the eligible side are 0 and 80 — boundary
    // precision equals sample density, exactly as documented.
    expect(gate.thresholdMoves).toEqual([
      { feature: "order.total", op: ">", from: 40, to: 0.25 },
    ]);
    expect(gate.addedClauses).toEqual([]);
    expect(gate.removedClauses).toEqual([]);
  });

  it("quantifies the behavioral effect on real traces", () => {
    const d = diffSpecs(a, b, withProbe);
    expect(d.decisions).toBeDefined();
    // Only the probe-total traces ($0.50, $1) flip decisions.
    const flipTotals = d.decisions!.flips.map((f) => {
      const t = withProbe.find((x) => x.id === f.traceId)!;
      return t.meta["total"];
    });
    expect(new Set(flipTotals)).toEqual(new Set([0.5, 1.0]));
    expect(d.decisions!.agree).toBe(d.decisions!.n - flipTotals.length);
  });
});

describe("cross-model drift: sonnet vs haiku specs from real traces", () => {
  const isProbe = (t: Trace) => [0.5, 1.0].includes(t.meta["total"] as number);
  const sonnetEqualSupport = sonnet.filter((t) => !isProbe(t));

  const inputKey = (t: Trace) =>
    `${t.meta["age_days"]}|${t.meta["status"]}|${t.meta["total"]}`;

  it("certifies decision invariance when both models saw the same input support", () => {
    // Guard thresholds are midpoints of observed values, so an honest
    // model-vs-model comparison must hold the input support fixed:
    // intersect both corpora on (age, status, total).
    const common = new Set(sonnetEqualSupport.map(inputKey));
    const haikuMatched = haiku.filter((t) => common.has(inputKey(t)));
    const sonnetMatched = sonnetEqualSupport.filter((t) =>
      new Set(haikuMatched.map(inputKey)).has(inputKey(t)),
    );
    expect(haikuMatched.length).toBeGreaterThanOrEqual(10);

    const a = synthesize(sonnetMatched, { name: "sonnet", guardScope: ["get_order"] }).spec;
    const b = synthesize(haikuMatched, { name: "haiku", guardScope: ["get_order"] }).spec;
    const d = diffSpecs(a, b, [...sonnetMatched, ...haikuMatched]);
    const gate = d.gates[0]!;
    expect(gate.identical).toBe(true);
    expect(d.decisions!.flips).toEqual([]);
    expect(d.decisions!.agree).toBe(d.decisions!.n);
    expect(renderDiff(d)).toContain("behaviorally equivalent on this sample");
  });

  it("surfaces unequal evidence support as a threshold gap, localized to the unprobed inputs", () => {
    // Sonnet's corpus includes the probe round (totals $0.50/$1); haiku's
    // grid never saw them. The diff must report the resulting threshold
    // difference and pin the behavioral effect to exactly those inputs.
    const a = synthesize(sonnet, { name: "sonnet+probes", guardScope: ["get_order"] }).spec;
    const b = synthesize(haiku, { name: "haiku", guardScope: ["get_order"] }).spec;
    const d = diffSpecs(a, b, [...sonnet, ...haiku]);
    expect(d.gates[0]!.thresholdMoves).toEqual([
      { feature: "order.total", op: ">", from: 0.25, to: 5 },
    ]);
    const flips = d.decisions!.flips.map((f) =>
      [...sonnet, ...haiku].find((t) => t.id === f.traceId),
    );
    expect(flips.length).toBeGreaterThan(0);
    for (const t of flips) expect(isProbe(t!)).toBe(true);
  });
});

describe("degenerate case: wholly different tool vocabularies", () => {
  const a = synthesize(sonnet, { name: "sonnet" }).spec;
  const v0 = loadDir(join(FIXTURES, "v0"));
  const b = synthesize(v0.filter((t) => t.id !== "refund-ORD-4199__a1"), { name: "v0" }).spec;

  it("degrades to a wholesale structure diff without crashing", () => {
    const d = diffSpecs(a, b);
    expect(d.identical).toBe(false);
    expect(d.calls.removedTools).toContain("get_order");
    expect(d.calls.addedTools).toContain("t1");
    expect(renderDiff(d)).toContain("call removed: get_order");
  });
});
