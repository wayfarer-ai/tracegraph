/** Generality: the second domain (ticket triage) — real claude -p traces,
 * a categorical × numeric hidden rule (per-priority SLA thresholds). */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadStreamJsonTrace } from "../trace/stream-json.js";
import { didAction, synthesize } from "./index.js";
import { evalGuard } from "./inducer.js";
import { extractFeatures } from "./features.js";
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
    expect(traces.length).toBe(32);
    const byBand = new Map<string, boolean[]>();
    for (const t of traces) {
      const k = t.meta["priority"] as string;
      (byBand.get(k) ?? byBand.set(k, []).get(k)!).push(
        Boolean(t.meta["escalated"]),
      );
    }
    for (const [, labels] of byBand) {
      expect(labels.filter(Boolean).length).toBe(4);
      expect(labels.length).toBe(8);
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

  it("CONVERGENCE: at 4/band the deep rule memorizes but does not generalize…", () => {
    // Training fit is the wrong metric at small samples — depth 7 fits 16
    // traces perfectly. The honest measure is held-out agreement on the
    // denser round-2 inputs: the 4/band-trained guard misses boundary
    // cases it never observed.
    const round1 = traces.filter(
      (t) => Number((t.meta["ticket_id"] as string).slice(4)) <= 3105,
    );
    const round2 = traces.filter(
      (t) => Number((t.meta["ticket_id"] as string).slice(4)) > 3105,
    );
    expect(round1.length).toBe(16);
    expect(round2.length).toBe(16);

    const m = synthesize(round1, {
      name: "triage-4perband",
      guardScope: ["get_ticket"],
      maxDepth: 7,
    });
    expect(m.trainingAgreement).toBe(1); // memorized…
    const gate = m.spec.steps.find((s): s is GateStep => s.kind === "gate")!;
    const actionSet = new Set(["escalate_ticket"]);
    const heldOut = round2.filter(
      (t) =>
        evalGuard(gate.guard, extractFeatures(t, { actionTools: actionSet })) ===
        didAction(t, "escalate_ticket"),
    ).length;
    expect(heldOut).toBeLessThanOrEqual(14); // …but does not generalize
  });

  it("…and fully recovers at 8/band: data density buys rule depth", () => {
    const deep = synthesize(traces, {
      name: "triage-deep-8perband",
      guardScope: ["get_ticket"],
      maxDepth: 7,
    });
    expect(deep.trainingAgreement).toBe(1);
    const gate = deep.spec.steps.find((s): s is GateStep => s.kind === "gate")!;
    const text = guardToString(gate.guard);
    expect(text).toContain('ticket.priority == "urgent"');
    expect(text).toContain("ticket.opened_hours_ago > 72");
  });
});
