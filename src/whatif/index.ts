/** `tracegraph whatif` — mutate the spec, replay decisions over recorded
 * traces, diff the outcomes. Deterministic counterfactuals: everything is
 * held fixed except the one thing you change.
 *
 * Mutations are concrete spec operations:
 *   - threshold edit:   what if the age limit were 60 days?
 *   - force gate:       what if the guard didn't exist?
 *   - feature injection: what if every order had been in_transit?
 */

import type { GateStep, GuardExpr, TraceGraphSpec } from "../spec/types.js";
import type { Trace } from "../trace/types.js";
import { extractFeatures, type FeatureValue } from "../synth/features.js";
import { evalGuard } from "../synth/inducer.js";

export interface Mutation {
  kind: "set-threshold" | "force-gate" | "set-feature";
  feature?: string;
  value?: FeatureValue;
}

export interface WhatIfResult {
  mutation: Mutation;
  n: number;
  baselinePositives: number;
  mutatedPositives: number;
  flips: { traceId: string; from: boolean; to: boolean; featureValue?: FeatureValue }[];
}

function gates(spec: TraceGraphSpec): GateStep[] {
  return spec.steps.filter((s): s is GateStep => s.kind === "gate");
}

/** Deep-copy the spec with all guard clauses on `feature` set to `value`. */
export function setThreshold(
  spec: TraceGraphSpec,
  feature: string,
  value: number,
): TraceGraphSpec {
  const copy = structuredClone(spec);
  let touched = 0;
  for (const g of gates(copy)) {
    for (const and of g.guard) {
      for (const clause of and) {
        if (clause.feature === feature && typeof clause.value === "number") {
          clause.value = value;
          touched += 1;
        }
      }
    }
  }
  if (touched === 0) {
    throw new Error(
      `set-threshold: no numeric clause on feature "${feature}" in any gate`,
    );
  }
  return copy;
}

/** Replace every gate guard with the always-true guard (one empty AND group). */
export function forceGates(spec: TraceGraphSpec): TraceGraphSpec {
  const copy = structuredClone(spec);
  for (const g of gates(copy)) g.guard = [[]] as GuardExpr;
  return copy;
}

export function whatIf(
  base: TraceGraphSpec,
  traces: Trace[],
  mutation: Mutation,
): WhatIfResult {
  let mutated = base;
  let override: { feature: string; value: FeatureValue } | undefined;

  switch (mutation.kind) {
    case "set-threshold":
      mutated = setThreshold(base, mutation.feature!, mutation.value as number);
      break;
    case "force-gate":
      mutated = forceGates(base);
      break;
    case "set-feature":
      override = { feature: mutation.feature!, value: mutation.value! };
      break;
  }

  const baseGuard = gates(base)[0]?.guard ?? [];
  const mutGuard = gates(mutated)[0]?.guard ?? [];

  const result: WhatIfResult = {
    mutation,
    n: traces.length,
    baselinePositives: 0,
    mutatedPositives: 0,
    flips: [],
  };

  for (const t of traces) {
    const feats = extractFeatures(t);
    const before = evalGuard(baseGuard, feats);

    const mutFeats = new Map(feats);
    if (override) mutFeats.set(override.feature, override.value);
    const after = evalGuard(mutGuard, mutFeats);

    result.baselinePositives += before ? 1 : 0;
    result.mutatedPositives += after ? 1 : 0;
    if (before !== after) {
      result.flips.push({
        traceId: t.id,
        from: before,
        to: after,
        featureValue: mutation.feature ? feats.get(mutation.feature) : undefined,
      });
    }
  }
  return result;
}

export function renderWhatIf(r: WhatIfResult): string {
  const m = r.mutation;
  const label =
    m.kind === "set-threshold"
      ? `set ${m.feature} threshold -> ${m.value}`
      : m.kind === "force-gate"
        ? "remove the gate guard (force the action branch)"
        : `inject ${m.feature} := ${JSON.stringify(m.value)}`;
  const lines = [
    `what-if: ${label}`,
    `decisions: ${r.baselinePositives}/${r.n} positive -> ${r.mutatedPositives}/${r.n}`,
    `flips: ${r.flips.length}`,
  ];
  for (const f of r.flips.slice(0, 20)) {
    const fv = f.featureValue !== undefined ? ` (${m.feature}=${JSON.stringify(f.featureValue)})` : "";
    lines.push(`  ${f.from ? "+->-" : "--> +"} ${f.traceId}${fv}`);
  }
  if (r.flips.length > 20) lines.push(`  ... and ${r.flips.length - 20} more`);
  return lines.join("\n") + "\n";
}
