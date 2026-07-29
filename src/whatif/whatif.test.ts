import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAtifTrace } from "../trace/atif.js";
import { synthesize } from "../synth/index.js";
import { renderWhatIf, setThreshold, whatIf } from "./index.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures");

function loadFixtures() {
  const manifest = JSON.parse(
    readFileSync(join(FIXTURES, "manifest.json"), "utf8"),
  ) as Record<string, Record<string, unknown>>;
  return Object.keys(manifest).map((f) =>
    loadAtifTrace(join(FIXTURES, f), manifest[f] ?? {}),
  );
}

describe("what-if over real corpus traces (deep-scope spec)", () => {
  const traces = loadFixtures();
  const { spec } = synthesize(traces, {
    name: "refund-deep",
    guardScope: ["get_order"],
  });

  it("threshold edit flips exactly the traces inside the moved band", () => {
    const r = whatIf(spec, traces, {
      kind: "set-threshold",
      feature: "order.shipped_at.age_days",
      value: 60.5,
    });
    // Every flip must be a delivered order aged in (30.5, 60.5].
    expect(r.flips.length).toBeGreaterThan(0);
    for (const f of r.flips) {
      const t = traces.find((x) => x.id === f.traceId)!;
      const age = t.meta["age_days"] as number;
      expect(f.from).toBe(true);
      expect(f.to).toBe(false);
      expect(age).toBeGreaterThan(30);
      expect(age).toBeLessThanOrEqual(60);
      expect(t.meta["status"]).toBe("delivered");
    }
    // And every non-flipped positive is beyond the new threshold.
    expect(r.mutatedPositives).toBe(r.baselinePositives - r.flips.length);
  });

  it("force-gate turns every trace positive; flips are exactly the old negatives", () => {
    const r = whatIf(spec, traces, { kind: "force-gate" });
    expect(r.mutatedPositives).toBe(r.n);
    expect(r.flips.length).toBe(r.n - r.baselinePositives);
    for (const f of r.flips) {
      expect(f.from).toBe(false);
      expect(f.to).toBe(true);
    }
  });

  it("feature injection: everything in transit -> nothing refundable", () => {
    const r = whatIf(spec, traces, {
      kind: "set-feature",
      feature: "order.status",
      value: "in_transit",
    });
    expect(r.mutatedPositives).toBe(0);
    for (const f of r.flips) expect(f.from).toBe(true);
  });

  it("rejects a threshold edit on a feature the guard does not use", () => {
    expect(() => setThreshold(spec, "order.nonexistent", 5)).toThrow(
      /no numeric clause/,
    );
  });

  it("renders a readable report with flip attribution", () => {
    const r = whatIf(spec, traces, {
      kind: "set-threshold",
      feature: "order.shipped_at.age_days",
      value: 60.5,
    });
    const text = renderWhatIf(r);
    expect(text).toContain("threshold -> 60.5");
    expect(text).toContain("flips:");
    expect(text).toMatch(/order\.shipped_at\.age_days=\d+/);
  });
});
