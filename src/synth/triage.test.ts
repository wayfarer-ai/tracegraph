/** Generality: the second domain (ticket triage) — real claude -p traces,
 * a categorical × numeric hidden rule (per-priority SLA thresholds). */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadStreamJsonTrace } from "../trace/stream-json.js";
import { synthesize } from "./index.js";
import { checkTraces } from "../check/index.js";
import { guardToString, type CallStep, type GateStep } from "../spec/types.js";

const DIR = join(import.meta.dirname, "..", "..", "examples", "triage", "traces");

function loadTriage() {
  const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as Record<
    string,
    Record<string, unknown>
  >;
  return Object.keys(manifest)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => loadStreamJsonTrace(join(DIR, f), manifest[f] ?? {}));
}

describe("second domain: triage (per-priority SLA rule)", () => {
  const traces = loadTriage();
  const result = synthesize(traces, { name: "triage" });

  it("has real traces on both sides of every priority band", () => {
    expect(traces.length).toBe(16);
    const byBand = new Map<string, boolean[]>();
    for (const t of traces) {
      const k = t.meta["priority"] as string;
      (byBand.get(k) ?? byBand.set(k, []).get(k)!).push(
        Boolean(t.meta["escalated"]),
      );
    }
    for (const [, labels] of byBand) {
      expect(labels.filter(Boolean).length).toBe(2);
      expect(labels.length).toBe(4);
    }
  });

  it("auto-detects the new domain's action with zero configuration", () => {
    expect(result.actionTool).toBe("escalate_ticket");
    expect(result.trainingAgreement).toBe(1);
  });

  it("induces the faithful shallow guard: the field the agent branches on", () => {
    const gate = result.spec.steps.find((s): s is GateStep => s.kind === "gate")!;
    const text = guardToString(gate.guard);
    expect(text).toContain("sla.breached");
    // both encodings of the same predicate are acceptable
    expect(text === "(sla.breached != false)" || text === "(sla.breached == true)").toBe(true);
  });

  it("marks the guard-feeding call as load-bearing (the decision input)", () => {
    const calls = result.spec.steps.filter((s): s is CallStep => s.kind === "call");
    const sla = calls.find((c) => c.tool === "check_sla");
    expect(sla?.loadBearing).toBe(true);
    const distractor = calls.find((c) => c.tool === "get_queue_stats");
    if (distractor) expect(distractor.loadBearing).toBe(false);
  });

  it("every trace is conformant with its own induced spec via check", () => {
    const report = checkTraces(traces, result.spec, [
      { action: "escalate_ticket", requiresPrior: "check_sla" },
    ]);
    expect(report.deviations).toBe(0);
  });

  it("HONEST LIMIT: the deep interaction rule is underdetermined at 4 samples/band", () => {
    // Greedy trees can't gain on priority== splits when every band is 50/50,
    // so per-priority thresholds don't fully recover from 16 traces. This is
    // documented behavior, not a regression: the shallow guard IS the spec.
    const deep = synthesize(traces, {
      name: "triage-deep",
      guardScope: ["get_ticket"],
      maxDepth: 5,
    });
    expect(deep.trainingAgreement).toBeGreaterThanOrEqual(0.8);
    expect(deep.trainingAgreement).toBeLessThan(1);
  });
});
