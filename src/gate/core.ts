/** The gate's decision core — engine-free, transport-free.
 *
 * A SpecGate holds one session's accumulated state (results that flowed
 * through the proxy) and judges each proposed call BEFORE it is forwarded:
 *
 *   - spec gates: a gated action must satisfy its guard on current state
 *   - invariant rules: requiresPrior (ordering) + requiresGuard (state)
 *
 * `judge` is pure in-memory boolean logic (microseconds); `record` feeds
 * results back in. The MCP proxy is a thin transport around this class,
 * and `check` is the same judgment applied to a recorded stream.
 */

import type { GateStep, InvariantRule, TraceGraphSpec } from "../spec/types.js";
import { guardToString } from "../spec/types.js";
import { FeatureAccumulator } from "../synth/features.js";
import { evalGuard } from "../synth/inducer.js";
import type { ToolEvent } from "../trace/types.js";

export type GateMode = "shadow" | "block";

export interface GateDecision {
  /** allow = conformant; block = stopped (block mode);
   * would-block = deviation observed but forwarded (shadow mode). */
  action: "allow" | "block" | "would-block";
  tool: string;
  violations: string[];
  at: string;
}

export interface SpecGateOptions {
  mode?: GateMode;
  rules?: InvariantRule[];
  /** For date-derived features; defaults to now. */
  runDate?: Date;
}

export class SpecGate {
  private readonly acc: FeatureAccumulator;
  private readonly seenTools = new Set<string>();
  private readonly gates: GateStep[];
  private readonly rules: InvariantRule[];
  readonly mode: GateMode;
  readonly decisions: GateDecision[] = [];

  constructor(spec: TraceGraphSpec, opts: SpecGateOptions = {}) {
    this.mode = opts.mode ?? "shadow";
    this.rules = opts.rules ?? [];
    this.gates = spec.steps.filter((s): s is GateStep => s.kind === "gate");
    this.acc = new FeatureAccumulator(opts.runDate ?? new Date());
  }

  private gatedBy(tool: string): GateStep[] {
    return this.gates.filter((g) =>
      g.then.some((s) => s.kind === "call" && s.tool === tool),
    );
  }

  /** Judge a proposed call against spec + rules on current session state. */
  judge(tool: string): GateDecision {
    const violations: string[] = [];

    for (const gate of this.gatedBy(tool)) {
      if (!evalGuard(gate.guard, this.acc.features)) {
        violations.push(
          `gate guard does not hold: ${guardToString(gate.guard)}`,
        );
      }
    }
    for (const rule of this.rules) {
      if (rule.action !== tool) continue;
      if (rule.requiresPrior && !this.seenTools.has(rule.requiresPrior)) {
        violations.push(`requires prior ${rule.requiresPrior}`);
      }
      if (rule.requiresGuard && !evalGuard(rule.requiresGuard, this.acc.features)) {
        violations.push(
          `rule guard does not hold: ${guardToString(rule.requiresGuard)}` +
            (rule.description ? ` (${rule.description})` : ""),
        );
      }
    }

    const decision: GateDecision = {
      action:
        violations.length === 0
          ? "allow"
          : this.mode === "block"
            ? "block"
            : "would-block",
      tool,
      violations,
      at: new Date().toISOString(),
    };
    this.decisions.push(decision);
    return decision;
  }

  /** Feed a completed call's result back into session state. */
  record(event: Pick<ToolEvent, "tool" | "args" | "result" | "isError">): void {
    this.seenTools.add(event.tool);
    this.acc.add({
      tool: event.tool,
      rawTool: event.tool,
      args: event.args,
      result: event.result,
      isError: event.isError,
      step: this.seenTools.size,
    });
  }
}
