/** High-level synthesis: traces in, spec out. */

import type { Trace } from "../trace/types.js";
import type { TraceGraphSpec } from "../spec/types.js";
import { extractFeatures } from "./features.js";
import { induceGuardTree, predict, toGuardExpr, type LabeledRow } from "./inducer.js";
import { assembleSpec } from "./assemble.js";

export interface SynthesizeOptions {
  name?: string;
  /** The consequential action the guard gates. Auto-detected if omitted:
   * the tool that appears in some-but-not-all traces, latest on average. */
  actionTool?: string;
  /** meta key -> input name, e.g. { order_id: "orderId" }. */
  inputKeys?: Record<string, string>;
  /** Restrict guard features to these tools' results. Default: all
   * non-action tools — which usually yields the *shallow* guard (the field
   * the agent directly branches on). Restrict to early observation tools
   * (e.g. ["get_order"]) to recover the *deep* rule behind that field. */
  guardScope?: string[];
  maxDepth?: number;
}

export interface SynthesisResult {
  spec: TraceGraphSpec;
  actionTool: string;
  trainingAgreement: number;
  positives: number;
  negatives: number;
}

export function detectActionTool(traces: Trace[]): string | undefined {
  const stats = new Map<string, { count: number; meanPos: number }>();
  for (const t of traces) {
    const seen = new Set<string>();
    for (const [i, e] of t.events.entries()) {
      if (seen.has(e.tool)) continue;
      seen.add(e.tool);
      const s = stats.get(e.tool) ?? { count: 0, meanPos: 0 };
      s.count += 1;
      s.meanPos += t.events.length ? i / t.events.length : 0;
      stats.set(e.tool, s);
    }
  }
  const candidates = [...stats.entries()]
    .filter(([, s]) => s.count > 0 && s.count < traces.length)
    .sort((a, b) => b[1].meanPos / b[1].count - a[1].meanPos / a[1].count);
  return candidates[0]?.[0];
}

export function didAction(trace: Trace, actionTool: string): boolean {
  return trace.events.some((e) => e.tool === actionTool && !e.isError);
}

export function synthesize(traces: Trace[], opts: SynthesizeOptions = {}): SynthesisResult {
  if (traces.length === 0) throw new Error("synthesize: no traces given");

  const actionTool = opts.actionTool ?? detectActionTool(traces);
  if (!actionTool) {
    throw new Error(
      "synthesize: could not auto-detect an action tool (every tool appears " +
        "in every trace); pass { actionTool } explicitly",
    );
  }

  const actionSet = new Set([actionTool]);
  const rows: LabeledRow[] = traces.map((t) => ({
    features: extractFeatures(t, { actionTools: actionSet, tools: opts.guardScope }),
    label: didAction(t, actionTool),
  }));

  const tree = induceGuardTree(rows, opts.maxDepth ?? 3);
  const guard = toGuardExpr(tree);
  const agree = rows.filter((r) => predict(tree, r.features) === r.label).length;

  const spec = assembleSpec(traces, {
    name: opts.name ?? "agent-spec",
    actionTool,
    guard,
    inputKeys: opts.inputKeys,
    agreement: agree / rows.length,
  });

  return {
    spec,
    actionTool,
    trainingAgreement: agree / rows.length,
    positives: rows.filter((r) => r.label).length,
    negatives: rows.filter((r) => !r.label).length,
  };
}
