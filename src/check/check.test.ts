import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAtifTrace } from "../trace/atif.js";
import { synthesize } from "../synth/index.js";
import { checkTrace, checkTraces } from "./index.js";
import type { InvariantRule } from "../spec/types.js";
import type { Trace } from "../trace/types.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures");
const V0 = join(FIXTURES, "v0");

function loadV0() {
  const manifest = JSON.parse(readFileSync(join(V0, "manifest.json"), "utf8")) as Record<
    string,
    Record<string, unknown>
  >;
  return Object.keys(manifest).map((f) => loadAtifTrace(join(V0, f), manifest[f] ?? {}));
}

/** The documented bad run: sonnet refunded an ineligible order under
 * opaque tool names — ordering held, the decision was wrong. */
const BAD_ID = "refund-ORD-4199__a1";

describe("the killer scenario: spec induced from good runs catches the bad one", () => {
  const all = loadV0();
  const good = all.filter((t) => t.id !== BAD_ID);
  const bad = all.find((t) => t.id === BAD_ID)!;
  // v0 vocabulary: t1=get_order t2=check_refund_policy t3=issue_refund t4=get_customer
  const { spec } = synthesize(good, { name: "refund-v0" });

  it("has real training data on both sides of the decision", () => {
    expect(good.length).toBe(14);
    expect(bad).toBeDefined();
  });

  it("flags exactly the bad trace, and only the bad trace", () => {
    const report = checkTraces(all, spec);
    const nonConformant = report.results.filter((r) => !r.conformant);
    expect(nonConformant.map((r) => r.traceId)).toEqual([BAD_ID]);
    expect(report.conformant).toBe(all.length - 1);
  });

  it("the violation is the guard, anchored at the refund event", () => {
    const result = checkTrace(bad, spec);
    const guardFindings = result.findings.filter((f) => f.kind === "guard-violated");
    expect(guardFindings.length).toBe(1);
    expect(bad.events[guardFindings[0]!.eventIndex!]!.tool).toBe("t3");
  });

  it("an ordering-only rule PASSES the bad trace — the reason scripted checks miss it", () => {
    const orderingRule: InvariantRule[] = [{ action: "t3", requiresPrior: "t2" }];
    const result = checkTrace(bad, spec, orderingRule);
    expect(result.findings.some((f) => f.kind === "missing-prior")).toBe(false);
    // ...while the gate guard still catches the wrong decision:
    expect(result.findings.some((f) => f.kind === "guard-violated")).toBe(true);
  });

  it("a state rule (requires_guard) also catches it, without any induced spec", () => {
    const stateRule: InvariantRule[] = [
      {
        action: "t3",
        requiresGuard: [[{ feature: "t2.eligible", op: "==", value: true }]],
        description: "refund only when policy says eligible",
      },
    ];
    const result = checkTrace(bad, spec, stateRule);
    expect(result.findings.some((f) => f.kind === "rule-guard-violated")).toBe(true);
  });
});

describe("contamination resistance: inducing WITH the bad trace included", () => {
  it("does not absorb the deviation into the guard, and still flags it", () => {
    const all = loadV0();
    const { spec, trainingAgreement } = synthesize(all, { name: "refund-v0-all" });
    const gate = spec.steps.find((s) => s.kind === "gate")!;
    // The bad trace refunded with NO valid policy answer in hand; with
    // action-time features it becomes an inseparable outlier rather than
    // shaping the guard.
    const text = JSON.stringify(gate);
    expect(text).not.toContain("45");
    expect(trainingAgreement).toBeLessThan(1);
    expect(trainingAgreement).toBeGreaterThanOrEqual(14 / 15);

    const report = checkTraces(all, spec);
    const nonConformant = report.results.filter((r) => !r.conformant);
    expect(nonConformant.map((r) => r.traceId)).toEqual([BAD_ID]);
  });
});

describe("gate conformance on the main corpus (self-consistency)", () => {
  const manifest = JSON.parse(
    readFileSync(join(FIXTURES, "manifest.json"), "utf8"),
  ) as Record<string, Record<string, unknown>>;
  const traces = Object.keys(manifest).map((f) =>
    loadAtifTrace(join(FIXTURES, f), manifest[f] ?? {}),
  );
  const { spec } = synthesize(traces, { name: "refund", inputKeys: { order_id: "orderId" } });

  it("every training trace is conformant with its own induced spec", () => {
    const report = checkTraces(traces, spec, [
      { action: "issue_refund", requiresPrior: "check_refund_policy" },
    ]);
    expect(report.deviations).toBe(0);
    expect(report.conformant).toBe(traces.length);
  });
});

describe("missed-action detection", () => {
  it("flags a trace that observed an eligible state but never acted", () => {
    const all = loadV0();
    const good = all.filter((t) => t.id !== BAD_ID);
    const { spec } = synthesize(good, { name: "refund-v0" });

    const donor = good.find((t) => t.events.some((e) => e.tool === "t3"))!;
    const truncated: Trace = {
      ...donor,
      id: "synthetic-missed-action",
      events: donor.events.filter((e) => e.tool !== "t3"),
    };
    const result = checkTrace(truncated, spec);
    expect(result.findings.some((f) => f.kind === "missed-action")).toBe(true);
    expect(result.conformant).toBe(false);
  });
});
