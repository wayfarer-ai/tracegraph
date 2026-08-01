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
  /** Records in the spec that traces were episode-split. */
  episodes?: boolean;
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
  const stats = new Map<string, { count: number; meanPos: number; mcp: boolean }>();
  for (const t of traces) {
    const seen = new Set<string>();
    for (const [i, e] of t.events.entries()) {
      if (seen.has(e.tool)) continue;
      seen.add(e.tool);
      const s = stats.get(e.tool) ?? { count: 0, meanPos: 0, mcp: false };
      s.count += 1;
      s.meanPos += t.events.length ? i / t.events.length : 0;
      s.mcp ||= e.rawTool.startsWith("mcp__");
      stats.set(e.tool, s);
    }
  }
  const varying = [...stats.entries()].filter(
    ([, s]) => s.count > 0 && s.count < traces.length,
  );
  // Domain (MCP) tools outrank agent-harness tools (Read, Write, ...):
  // a harness tool appearing sporadically is exploration noise, never the
  // consequential action a guard should gate.
  const pool = varying.some(([, s]) => s.mcp) ? varying.filter(([, s]) => s.mcp) : varying;
  pool.sort((a, b) => b[1].meanPos / b[1].count - a[1].meanPos / a[1].count);
  return pool[0]?.[0];
}

/** Did the action SUCCEED — transport errors and business-level rejections
 * (`ok: false` / `success: false` in the result) both count as not-taken.
 * Rejected attempts matter for check (the agent *tried*), but a guard must
 * be induced from what actually happened. */
export function didAction(trace: Trace, actionTool: string): boolean {
  return trace.events.some((e) => {
    if (e.tool !== actionTool || e.isError) return false;
    if (typeof e.result === "object" && e.result !== null) {
      const r = e.result as Record<string, unknown>;
      if (r["ok"] === false || r["success"] === false || "error" in r) return false;
    }
    return true;
  });
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
  // Guards describe the state the agent ACTED ON, so positive traces
  // contribute features as of the first successful action — the same
  // timing `check` evaluates at. (Full-trace features would let a bad
  // trace's post-action calls launder its missing pre-action state.)
  const succeeded = (e: Trace["events"][number]): boolean => {
    if (e.tool !== actionTool || e.isError) return false;
    if (typeof e.result === "object" && e.result !== null) {
      const r = e.result as Record<string, unknown>;
      if (r["ok"] === false || r["success"] === false || "error" in r) return false;
    }
    return true;
  };
  const rows: LabeledRow[] = traces.map((t) => {
    const label = didAction(t, actionTool);
    let source = t;
    if (label) {
      const idx = t.events.findIndex(succeeded);
      source = { ...t, events: t.events.slice(0, idx) };
    }
    return {
      features: extractFeatures(source, { actionTools: actionSet, tools: opts.guardScope }),
      label,
    };
  });

  const tree = induceGuardTree(rows, opts.maxDepth ?? 3);
  const guard = toGuardExpr(tree);
  const agree = rows.filter((r) => predict(tree, r.features) === r.label).length;

  const spec = assembleSpec(traces, {
    name: opts.name ?? "agent-spec",
    actionTool,
    guard,
    inputKeys: opts.inputKeys,
    agreement: agree / rows.length,
    episodes: opts.episodes,
  });

  return {
    spec,
    actionTool,
    trainingAgreement: agree / rows.length,
    positives: rows.filter((r) => r.label).length,
    negatives: rows.filter((r) => !r.label).length,
  };
}
