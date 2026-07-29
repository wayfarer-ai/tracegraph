/** Spec assembly: traces + induced guard -> TraceGraphSpec.
 *
 * - maps the common prefix of observed behavior to CallSteps with data-flow
 *   lift (literal args that echo earlier result fields become ${refs})
 * - marks calls whose results feed nothing downstream as non-load-bearing
 * - wraps the guarded action in a GateStep carrying the induced guard
 */

import type { Trace, ToolEvent } from "../trace/types.js";
import { bindingName } from "./features.js";
import type { CallStep, GateStep, SpecStep, TraceGraphSpec } from "../spec/types.js";
import type { GuardExpr } from "../spec/types.js";

interface Bound {
  binding: string;
  result: Record<string, unknown>;
}

function liftArgs(
  tool: string,
  args: Record<string, unknown>,
  prior: Bound[],
  inputs: Map<string, unknown>,
  varying: Set<string>,
): Record<string, unknown> {
  const lifted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    let ref: string | undefined;
    for (let i = prior.length - 1; i >= 0 && !ref; i--) {
      const p = prior[i]!;
      for (const [rk, rv] of Object.entries(p.result)) {
        if (rv === v) {
          ref = `\${${p.binding}.${rk}}`;
          break;
        }
      }
    }
    if (!ref) {
      for (const [ik, iv] of inputs) {
        if (iv === v) {
          ref = `\${input.${ik}}`;
          break;
        }
      }
    }
    // Auto-lift: an arg whose literal differs across traces is a task
    // input, not part of the behavior (a spec with "ORD-2381" baked in
    // would be donor-trace trivia).
    if (!ref && varying.has(`${tool}.${k}`)) {
      ref = `\${input.${k}}`;
      inputs.set(k, v);
    }
    lifted[k] = ref ?? v;
  }
  return lifted;
}

/** tool.arg keys whose literal values differ across traces. */
function varyingArgs(traces: Trace[]): Set<string> {
  const seen = new Map<string, Set<string>>();
  for (const t of traces) {
    const first = new Set<string>();
    for (const e of t.events) {
      for (const [k, v] of Object.entries(e.args)) {
        const key = `${e.tool}.${k}`;
        if (first.has(key)) continue;
        first.add(key);
        (seen.get(key) ?? seen.set(key, new Set()).get(key)!).add(JSON.stringify(v));
      }
    }
  }
  return new Set([...seen.entries()].filter(([, v]) => v.size > 1).map(([k]) => k));
}

function uniqueBinding(tool: string, used: Map<string, number>): string {
  const base = bindingName(tool);
  const n = (used.get(base) ?? 0) + 1;
  used.set(base, n);
  return n === 1 ? base : `${base}${n}`;
}

/** A call is load-bearing when its result feeds later lifted args OR the
 * gate guard's features — the guard input is the decision, after all. */
function markLoadBearing(steps: CallStep[], guard: GuardExpr): void {
  const referenced = new Set<string>();
  for (const s of steps) {
    for (const v of Object.values(s.args)) {
      if (typeof v === "string") {
        const m = v.match(/^\$\{([^.}]+)\./);
        if (m?.[1]) referenced.add(m[1]);
      }
    }
  }
  for (const and of guard) {
    for (const clause of and) {
      const binding = clause.feature.split(".")[0];
      if (binding) referenced.add(binding);
    }
  }
  for (const s of steps) {
    s.loadBearing = referenced.has(s.as) || s === steps[steps.length - 1];
  }
}

export interface AssembleOptions {
  name: string;
  /** The action tool the guard gates (e.g. "issue_refund"). */
  actionTool: string;
  guard: GuardExpr;
  /** Named task inputs per trace, e.g. trace.meta.order_id -> "orderId". */
  inputKeys?: Record<string, string>;
  agreement?: number;
}

/** Order tools by how often they precede the action across traces, and
 * keep only tools present in a majority of traces (drops one-off noise). */
function majorityPrefix(traces: Trace[], actionTool: string): string[] {
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  for (const t of traces) {
    const seen = new Set<string>();
    for (const [i, e] of t.events.entries()) {
      if (e.tool === actionTool) break;
      if (seen.has(e.tool)) continue;
      seen.add(e.tool);
      counts.set(e.tool, (counts.get(e.tool) ?? 0) + 1);
      if (!firstSeen.has(e.tool)) firstSeen.set(e.tool, i);
    }
  }
  const majority = Math.ceil(traces.length / 2);
  return [...counts.entries()]
    .filter(([, n]) => n >= majority)
    .sort((a, b) => (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0))
    .map(([tool]) => tool);
}

export function assembleSpec(traces: Trace[], opts: AssembleOptions): TraceGraphSpec {
  const prefixTools = majorityPrefix(traces, opts.actionTool);

  // Donor trace: one that executed the action, else the longest.
  const donor =
    traces.find((t) => t.events.some((e) => e.tool === opts.actionTool)) ??
    traces.reduce((a, b) => (a.events.length >= b.events.length ? a : b));

  const inputs = new Map<string, unknown>();
  for (const [metaKey, inputName] of Object.entries(opts.inputKeys ?? {})) {
    if (donor.meta[metaKey] !== undefined) inputs.set(inputName, donor.meta[metaKey]);
  }
  const varying = varyingArgs(traces);

  const used = new Map<string, number>();
  const prior: Bound[] = [];
  const prefixSteps: CallStep[] = [];
  const donorEvent = (tool: string): ToolEvent | undefined =>
    donor.events.find((e) => e.tool === tool);

  for (const tool of prefixTools) {
    const e = donorEvent(tool);
    if (!e) continue;
    const binding = uniqueBinding(tool, used);
    prefixSteps.push({
      kind: "call",
      id: `call-${binding}`,
      tool,
      args: liftArgs(tool, e.args, prior, inputs, varying),
      as: binding,
    });
    if (typeof e.result === "object" && e.result !== null) {
      prior.push({ binding, result: e.result as Record<string, unknown> });
    }
  }

  const actionEvent = donorEvent(opts.actionTool);
  const actionSteps: CallStep[] = actionEvent
    ? [
        {
          kind: "call",
          id: `call-${uniqueBinding(opts.actionTool, used)}`,
          tool: opts.actionTool,
          args: liftArgs(opts.actionTool, actionEvent.args, prior, inputs, varying),
          as: bindingName(opts.actionTool),
        },
      ]
    : [];

  markLoadBearing([...prefixSteps, ...actionSteps], opts.guard);

  const gate: GateStep = {
    kind: "gate",
    id: "gate-on-guard",
    guard: opts.guard,
    then: actionSteps,
  };

  const steps: SpecStep[] = [...prefixSteps, gate];
  return {
    tracegraph: 1,
    name: opts.name,
    inputs: [...inputs.keys()],
    steps,
    induction: {
      traces: traces.length,
      at: new Date().toISOString(),
      agreement: opts.agreement,
      tool: `tracegraph@0.0.1`,
    },
  };
}
