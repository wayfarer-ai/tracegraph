/** `tracegraph diff` — compare two specs: structure, guards, and (given
 * sample traces) actual decision agreement.
 *
 * Structural identity is the wrong equality for guards: two different DNFs
 * can decide identically, and a one-number threshold move is more readable
 * as "moved 5.0 -> 0.25" than as remove+add. So the diff reports three
 * layers: call-structure changes, clause-level guard changes with threshold
 * moves collapsed, and — when traces are provided — behavioral agreement
 * on real feature vectors (the sonnet/haiku drift lesson: structure can
 * drift while decisions stay invariant, and vice versa).
 */

import type {
  CallStep,
  GateStep,
  GuardClause,
  GuardExpr,
  TraceGraphSpec,
} from "../spec/types.js";
import { clauseToString } from "../spec/types.js";
import type { Trace } from "../trace/types.js";
import { extractFeatures, type Features } from "../synth/features.js";
import { evalGuard } from "../synth/inducer.js";

export interface ThresholdMove {
  feature: string;
  op: string;
  from: number;
  to: number;
}

export interface GuardDiff {
  gateId: string;
  identical: boolean;
  addedClauses: string[];
  removedClauses: string[];
  thresholdMoves: ThresholdMove[];
}

export interface CallDiff {
  addedTools: string[];
  removedTools: string[];
  argChanges: { tool: string; arg: string; from: unknown; to: unknown }[];
  loadBearingChanges: { tool: string; from: boolean; to: boolean }[];
}

export interface DecisionAgreement {
  n: number;
  agree: number;
  flips: { traceId: string; a: boolean; b: boolean }[];
}

export interface SpecDiff {
  identical: boolean;
  calls: CallDiff;
  gates: GuardDiff[];
  /** Present only when sample traces were provided. */
  decisions?: DecisionAgreement;
}

function allCalls(spec: TraceGraphSpec): CallStep[] {
  const calls: CallStep[] = [];
  const walk = (steps: TraceGraphSpec["steps"]) => {
    for (const s of steps) {
      if (s.kind === "call") calls.push(s);
      else {
        walk(s.then);
        if (s.else) walk(s.else);
      }
    }
  };
  walk(spec.steps);
  return calls;
}

function gates(spec: TraceGraphSpec): GateStep[] {
  return spec.steps.filter((s): s is GateStep => s.kind === "gate");
}

function diffCalls(a: TraceGraphSpec, b: TraceGraphSpec): CallDiff {
  const aCalls = new Map(allCalls(a).map((c) => [c.tool, c]));
  const bCalls = new Map(allCalls(b).map((c) => [c.tool, c]));
  const out: CallDiff = {
    addedTools: [...bCalls.keys()].filter((t) => !aCalls.has(t)),
    removedTools: [...aCalls.keys()].filter((t) => !bCalls.has(t)),
    argChanges: [],
    loadBearingChanges: [],
  };
  const isNoise = (v: unknown): boolean =>
    typeof v === "string" && !v.startsWith("${") && v.length > 48;
  for (const [tool, ac] of aCalls) {
    const bc = bCalls.get(tool);
    if (!bc) continue;
    // Non-load-bearing calls' arg templates are donor-trace incidentals
    // (paths, prose, harness queries) — behavioral diffs only.
    if (ac.loadBearing === false && bc.loadBearing === false) continue;
    for (const arg of new Set([...Object.keys(ac.args), ...Object.keys(bc.args)])) {
      if (JSON.stringify(ac.args[arg]) !== JSON.stringify(bc.args[arg])) {
        if (isNoise(ac.args[arg]) || isNoise(bc.args[arg])) continue;
        out.argChanges.push({ tool, arg, from: ac.args[arg], to: bc.args[arg] });
      }
    }
    const aLoad = ac.loadBearing !== false;
    const bLoad = bc.loadBearing !== false;
    if (aLoad !== bLoad) out.loadBearingChanges.push({ tool, from: aLoad, to: bLoad });
  }
  return out;
}

function flatClauses(g: GuardExpr): GuardClause[] {
  return g.flat();
}

function diffGuard(gateId: string, a: GuardExpr, b: GuardExpr): GuardDiff {
  const aStrs = new Set(flatClauses(a).map(clauseToString));
  const bStrs = new Set(flatClauses(b).map(clauseToString));
  let removed = flatClauses(a).filter((c) => !bStrs.has(clauseToString(c)));
  let added = flatClauses(b).filter((c) => !aStrs.has(clauseToString(c)));

  // Collapse remove+add on the same numeric feature+op into a move.
  const moves: ThresholdMove[] = [];
  for (const r of [...removed]) {
    const partner = added.find(
      (x) =>
        x.feature === r.feature &&
        x.op === r.op &&
        typeof x.value === "number" &&
        typeof r.value === "number",
    );
    if (partner) {
      moves.push({
        feature: r.feature,
        op: r.op,
        from: r.value as number,
        to: partner.value as number,
      });
      removed = removed.filter((x) => x !== r);
      added = added.filter((x) => x !== partner);
    }
  }

  return {
    gateId,
    identical: removed.length === 0 && added.length === 0 && moves.length === 0,
    addedClauses: added.map(clauseToString),
    removedClauses: removed.map(clauseToString),
    thresholdMoves: moves,
  };
}

export function decisionAgreement(
  a: GuardExpr,
  b: GuardExpr,
  samples: { traceId: string; features: Features }[],
): DecisionAgreement {
  const flips: DecisionAgreement["flips"] = [];
  let agree = 0;
  for (const s of samples) {
    const da = evalGuard(a, s.features);
    const db = evalGuard(b, s.features);
    if (da === db) agree += 1;
    else flips.push({ traceId: s.traceId, a: da, b: db });
  }
  return { n: samples.length, agree, flips };
}

export function diffSpecs(
  a: TraceGraphSpec,
  b: TraceGraphSpec,
  sampleTraces?: Trace[],
): SpecDiff {
  const calls = diffCalls(a, b);
  const aGates = gates(a);
  const bGates = gates(b);
  const gateDiffs: GuardDiff[] = [];
  const n = Math.max(aGates.length, bGates.length);
  for (let i = 0; i < n; i++) {
    gateDiffs.push(
      diffGuard(bGates[i]?.id ?? aGates[i]?.id ?? `gate-${i}`, aGates[i]?.guard ?? [], bGates[i]?.guard ?? []),
    );
  }

  const out: SpecDiff = {
    identical:
      calls.addedTools.length === 0 &&
      calls.removedTools.length === 0 &&
      calls.argChanges.length === 0 &&
      calls.loadBearingChanges.length === 0 &&
      gateDiffs.every((g) => g.identical),
    calls,
    gates: gateDiffs,
  };

  if (sampleTraces && sampleTraces.length > 0 && aGates[0] && bGates[0]) {
    out.decisions = decisionAgreement(
      aGates[0].guard,
      bGates[0].guard,
      sampleTraces.map((t) => ({ traceId: t.id, features: extractFeatures(t) })),
    );
  }
  return out;
}

export function renderDiff(d: SpecDiff): string {
  if (d.identical && !d.decisions) return "specs are identical\n";
  const lines: string[] = [];
  for (const t of d.calls.addedTools) lines.push(`+ call added: ${t}`);
  for (const t of d.calls.removedTools) lines.push(`- call removed: ${t}`);
  for (const c of d.calls.argChanges) {
    lines.push(`~ ${c.tool}.${c.arg}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
  }
  for (const c of d.calls.loadBearingChanges) {
    lines.push(`~ ${c.tool}: load-bearing ${c.from} -> ${c.to}`);
  }
  for (const g of d.gates) {
    if (g.identical) continue;
    for (const m of g.thresholdMoves) {
      lines.push(`~ ${g.gateId}: threshold moved ${m.feature} ${m.op} ${m.from} -> ${m.to}`);
    }
    for (const c of g.removedClauses) lines.push(`- ${g.gateId}: clause removed: ${c}`);
    for (const c of g.addedClauses) lines.push(`+ ${g.gateId}: clause added: ${c}`);
  }
  if (d.identical) lines.push("structure: identical");
  if (d.decisions) {
    const pct = ((100 * d.decisions.agree) / d.decisions.n).toFixed(1);
    lines.push(
      `decisions on sample: ${d.decisions.agree}/${d.decisions.n} agree (${pct}%)` +
        (d.decisions.flips.length
          ? ` — flips: ${d.decisions.flips.map((f) => f.traceId).join(", ")}`
          : " — behaviorally equivalent on this sample"),
    );
  }
  return lines.join("\n") + "\n";
}
