/** `tracegraph check` — judge recorded traces against a spec + invariants.
 *
 * The evaluator walks each trace event-by-event, accumulating exactly the
 * state that was visible at each point (a FeatureAccumulator), and judges:
 *
 *   1. gate conformance — when the gated action fires, did the guard hold
 *      on the state at that moment? (catches wrong decisions even when
 *      every ordering rule passes)
 *   2. missed action — trace ended with a gate satisfied but its action
 *      never taken
 *   3. invariant rules — ordering (`requiresPrior`) and state
 *      (`requiresGuard`) assertions from a hand-authored rules file
 *
 * This module is deliberately engine-free; `gate` reuses the same logic on
 * a live event stream in shadow/block mode.
 */

import type { Trace, ToolEvent } from "../trace/types.js";
import type {
  GateStep,
  InvariantRule,
  TraceGraphSpec,
} from "../spec/types.js";
import { guardToString } from "../spec/types.js";
import { FeatureAccumulator } from "../synth/features.js";
import { evalGuard } from "../synth/inducer.js";

export type FindingLevel = "deviation" | "note";

export interface Finding {
  level: FindingLevel;
  traceId: string;
  kind:
    | "guard-violated"
    | "missed-action"
    | "missing-prior"
    | "rule-guard-violated"
    | "unknown-tool";
  message: string;
  /** Index into trace.events where the finding anchors, if applicable. */
  eventIndex?: number;
}

export interface TraceCheckResult {
  traceId: string;
  findings: Finding[];
  conformant: boolean;
}

export interface CheckReport {
  spec: string;
  traces: number;
  conformant: number;
  deviations: number;
  results: TraceCheckResult[];
}

function gateSteps(spec: TraceGraphSpec): GateStep[] {
  return spec.steps.filter((s): s is GateStep => s.kind === "gate");
}

function specTools(spec: TraceGraphSpec): Set<string> {
  const tools = new Set<string>();
  const walk = (steps: TraceGraphSpec["steps"]) => {
    for (const s of steps) {
      if (s.kind === "call") tools.add(s.tool);
      else {
        walk(s.then);
        if (s.else) walk(s.else);
      }
    }
  };
  walk(spec.steps);
  return tools;
}

function gatedActionTools(gate: GateStep): Set<string> {
  const tools = new Set<string>();
  for (const s of gate.then) if (s.kind === "call") tools.add(s.tool);
  return tools;
}

export function checkTrace(
  trace: Trace,
  spec: TraceGraphSpec,
  rules: InvariantRule[] = [],
): TraceCheckResult {
  const findings: Finding[] = [];
  const gates = gateSteps(spec);
  const known = specTools(spec);
  const acc = new FeatureAccumulator(trace.runDate);
  const seenTools = new Set<string>();
  const actionFired = new Set<string>();

  for (const [i, e] of trace.events.entries()) {
    // 1. gate conformance at the moment of action
    for (const gate of gates) {
      if (gatedActionTools(gate).has(e.tool)) {
        actionFired.add(e.tool);
        if (!evalGuard(gate.guard, acc.features)) {
          findings.push({
            level: "deviation",
            kind: "guard-violated",
            traceId: trace.id,
            eventIndex: i,
            message:
              `${e.tool} fired but the gate guard did not hold: ` +
              guardToString(gate.guard),
          });
        }
      }
    }

    // 3. invariant rules at the moment of action
    for (const rule of rules) {
      if (e.tool !== rule.action) continue;
      if (rule.requiresPrior && !seenTools.has(rule.requiresPrior)) {
        findings.push({
          level: "deviation",
          kind: "missing-prior",
          traceId: trace.id,
          eventIndex: i,
          message: `${e.tool} fired without a prior ${rule.requiresPrior}`,
        });
      }
      if (rule.requiresGuard && !evalGuard(rule.requiresGuard, acc.features)) {
        findings.push({
          level: "deviation",
          kind: "rule-guard-violated",
          traceId: trace.id,
          eventIndex: i,
          message:
            `${e.tool} fired while rule guard did not hold: ` +
            guardToString(rule.requiresGuard) +
            (rule.description ? ` (${rule.description})` : ""),
        });
      }
    }

    // note-level: tools the spec has never seen (harness tools excluded)
    if (!known.has(e.tool) && e.rawTool.startsWith("mcp__")) {
      findings.push({
        level: "note",
        kind: "unknown-tool",
        traceId: trace.id,
        eventIndex: i,
        message: `tool ${e.tool} is not in the spec`,
      });
    }

    seenTools.add(e.tool);
    acc.add(e);
  }

  // 2. missed action: guard holds on final state but action never fired
  for (const gate of gates) {
    for (const action of gatedActionTools(gate)) {
      if (!actionFired.has(action) && evalGuard(gate.guard, acc.features)) {
        findings.push({
          level: "deviation",
          kind: "missed-action",
          traceId: trace.id,
          message:
            `gate guard held (${guardToString(gate.guard)}) ` +
            `but ${action} was never called`,
        });
      }
    }
  }

  return {
    traceId: trace.id,
    findings,
    conformant: !findings.some((f) => f.level === "deviation"),
  };
}

export function checkTraces(
  traces: Trace[],
  spec: TraceGraphSpec,
  rules: InvariantRule[] = [],
): CheckReport {
  const results = traces.map((t) => checkTrace(t, spec, rules));
  return {
    spec: spec.name,
    traces: traces.length,
    conformant: results.filter((r) => r.conformant).length,
    deviations: results
      .flatMap((r) => r.findings)
      .filter((f) => f.level === "deviation").length,
    results,
  };
}
