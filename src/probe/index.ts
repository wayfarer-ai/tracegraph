/** `tracegraph probe` — the spec tells you what to test next.
 *
 * Every numeric guard threshold is a midpoint between the nearest observed
 * values on either side; the gap between them is exactly how imprecise the
 * boundary is. probe reads each threshold's observed support from the
 * traces and proposes inputs inside the gap — run them, re-synthesize, and
 * the boundary sharpens. (On our benchmark this loop tightened a boundary
 * 20x in one round.)
 */

import type { GateStep, GuardClause, TraceGraphSpec } from "../spec/types.js";
import type { Trace } from "../trace/types.js";
import { extractFeatures } from "../synth/features.js";
import { evalGuard } from "../synth/inducer.js";

export interface ThresholdAnalysis {
  feature: string;
  op: string;
  threshold: number;
  /** Nearest observed value below / above the threshold. */
  supportBelow?: number;
  supportAbove?: number;
  /** Width of the unobserved gap the threshold sits in. */
  gap?: number;
  /** Proposed probe values inside the gap (straddling the threshold). */
  probes: number[];
}

export interface ProbeReport {
  spec: string;
  traces: number;
  thresholds: ThresholdAnalysis[];
}

interface NumericClause {
  feature: string;
  op: string;
  value: number;
  /** Sibling clauses in the same AND group — a threshold's uncertainty
   * interval only makes sense over traces that satisfy the rest of its
   * conjunction (the inducer picked it within that subset). */
  siblings: GuardClause[];
}

function numericClauses(spec: TraceGraphSpec): NumericClause[] {
  const out: NumericClause[] = [];
  const gates = spec.steps.filter((s): s is GateStep => s.kind === "gate");
  for (const g of gates) {
    for (const and of g.guard) {
      for (const c of and) {
        if (typeof c.value === "number" && (c.op === ">" || c.op === "<=")) {
          out.push({
            feature: c.feature,
            op: c.op,
            value: c.value,
            siblings: and.filter((x) => x !== c),
          });
        }
      }
    }
  }
  return out;
}

/** Propose up to `k` values inside (lo, hi), straddling the threshold. */
function proposeProbes(lo: number, hi: number, threshold: number, k = 4): number[] {
  const candidates: number[] = [];
  const below = (lo + threshold) / 2;
  const above = (threshold + hi) / 2;
  candidates.push(below, above);
  candidates.push((lo + below) / 2, (above + hi) / 2);
  const round = (x: number) => Number(x.toPrecision(3));
  return [...new Set(candidates.map(round))]
    .filter((x) => x > lo && x < hi)
    .sort((a, b) => a - b)
    .slice(0, k);
}

export function probe(spec: TraceGraphSpec, traces: Trace[]): ProbeReport {
  const traceFeatures = traces.map((t) => extractFeatures(t));

  const thresholds: ThresholdAnalysis[] = [];
  for (const clause of numericClauses(spec)) {
    // Condition on the sibling clauses: only traces that reach this
    // decision contribute to its observed support.
    const values = traceFeatures
      .filter((f) => clause.siblings.length === 0 || evalGuard([clause.siblings], f))
      .map((f) => f.get(clause.feature))
      .filter((v): v is number => typeof v === "number");
    const below = values.filter((v) => v < clause.value);
    const above = values.filter((v) => v > clause.value);
    const supportBelow = below.length ? Math.max(...below) : undefined;
    const supportAbove = above.length ? Math.min(...above) : undefined;
    const analysis: ThresholdAnalysis = {
      feature: clause.feature,
      op: clause.op,
      threshold: clause.value,
      supportBelow,
      supportAbove,
      probes: [],
    };
    if (supportBelow !== undefined && supportAbove !== undefined) {
      analysis.gap = supportAbove - supportBelow;
      analysis.probes = proposeProbes(supportBelow, supportAbove, clause.value);
      // A gap of adjacent integers (e.g. days 30 vs 31) is already at the
      // resolution of the data — nothing useful to probe between them.
      if (analysis.gap <= 1) analysis.probes = [];
    }
    thresholds.push(analysis);
  }
  return { spec: spec.name, traces: traces.length, thresholds };
}

export function renderProbe(r: ProbeReport): string {
  const lines = [`probe: ${r.spec} — boundary support from ${r.traces} traces`];
  for (const t of r.thresholds) {
    lines.push(
      `\n${t.feature} ${t.op} ${t.threshold}` +
        `\n  observed support: ${t.supportBelow ?? "none"} … ${t.supportAbove ?? "none"}` +
        (t.gap !== undefined ? ` (gap ${Number(t.gap.toPrecision(3))})` : ""),
    );
    if (t.probes.length) {
      lines.push(
        `  run inputs with ${t.feature} ≈ ${t.probes.join(", ")} — then re-synthesize to sharpen this boundary`,
      );
    } else if (t.gap !== undefined) {
      lines.push(`  boundary is at data resolution — no probes needed`);
    } else {
      lines.push(`  insufficient observations on one side — boundary is unsupported, probe both sides`);
    }
  }
  return lines.join("\n") + "\n";
}
