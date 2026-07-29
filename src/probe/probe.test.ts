import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAtifTrace } from "../trace/atif.js";
import { synthesize } from "../synth/index.js";
import { probe, renderProbe } from "./index.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures");

function loadFixtures() {
  const manifest = JSON.parse(
    readFileSync(join(FIXTURES, "manifest.json"), "utf8"),
  ) as Record<string, Record<string, unknown>>;
  return Object.keys(manifest).map((f) =>
    loadAtifTrace(join(FIXTURES, f), manifest[f] ?? {}),
  );
}

describe("probe reproduces the spike's active-probing round from real data", () => {
  const all = loadFixtures();
  const preProbe = all.filter((t) => ![0.5, 1.0].includes(t.meta["total"] as number));

  it("pre-probe: flags the wide total gap and proposes probes straddling it", () => {
    const { spec } = synthesize(preProbe, { name: "pre", guardScope: ["get_order"] });
    const r = probe(spec, preProbe);

    const total = r.thresholds.find((t) => t.feature === "order.total")!;
    expect(total.supportBelow).toBe(0);
    expect(total.supportAbove).toBe(80);
    expect(total.gap).toBe(80);
    expect(total.probes.length).toBeGreaterThan(0);
    for (const p of total.probes) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(80);
    }
    // straddling: at least one probe on each side of the threshold
    expect(total.probes.some((p) => p < total.threshold)).toBe(true);
    expect(total.probes.some((p) => p > total.threshold)).toBe(true);
  });

  it("pre-probe: knows the age boundary is already at data resolution", () => {
    const { spec } = synthesize(preProbe, { name: "pre", guardScope: ["get_order"] });
    const r = probe(spec, preProbe);
    const age = r.thresholds.find((t) => t.feature === "order.shipped_at.age_days")!;
    expect(age.supportBelow).toBe(30);
    expect(age.supportAbove).toBe(31);
    expect(age.probes).toEqual([]); // days 30 vs 31: nothing between to test
  });

  it("post-probe: the total gap collapses — convergence is measurable", () => {
    const pre = synthesize(preProbe, { name: "pre", guardScope: ["get_order"] });
    const post = synthesize(all, { name: "post", guardScope: ["get_order"] });
    const gapPre = probe(pre.spec, preProbe).thresholds.find(
      (t) => t.feature === "order.total",
    )!.gap!;
    const gapPost = probe(post.spec, all).thresholds.find(
      (t) => t.feature === "order.total",
    )!.gap!;
    expect(gapPost).toBeLessThan(gapPre / 100); // 80 -> 0.5: >100x tighter
  });

  it("renders actionable guidance", () => {
    const { spec } = synthesize(preProbe, { name: "pre", guardScope: ["get_order"] });
    const text = renderProbe(probe(spec, preProbe));
    expect(text).toContain("run inputs with order.total");
    expect(text).toContain("re-synthesize to sharpen");
    expect(text).toContain("boundary is at data resolution");
  });
});
