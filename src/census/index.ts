/** `tracegraph census` — the behavior map for trace populations that
 * aren't spec-shaped (long interactive sessions, mixed corpora).
 *
 * Born from dogfooding: pointing synthesize at real coding sessions
 * rightfully refuses to emit a spec, but "what do these sessions actually
 * do" is still the question. Census answers it: per-population tool
 * counts, MCP vs harness split, and the dominant call sequences.
 */

import type { Trace } from "../trace/types.js";
import { clusterByVocabulary } from "../synth/cluster.js";

export interface PopulationCensus {
  traces: number;
  totalCalls: number;
  meanCallsPerTrace: number;
  mcpShare: number;
  tools: { tool: string; calls: number; traces: number; errorRate: number }[];
  bigrams: { pair: string; count: number }[];
}

export interface CensusReport {
  traces: number;
  skippedEmpty: number;
  populations: PopulationCensus[];
}

function censusOne(traces: Trace[]): PopulationCensus {
  const byTool = new Map<string, { calls: number; traces: Set<string>; errors: number }>();
  const bigrams = new Map<string, number>();
  let total = 0;
  let mcp = 0;

  for (const t of traces) {
    let prev: string | undefined;
    for (const e of t.events) {
      total += 1;
      if (e.rawTool.startsWith("mcp__")) mcp += 1;
      const s = byTool.get(e.tool) ?? { calls: 0, traces: new Set<string>(), errors: 0 };
      s.calls += 1;
      s.traces.add(t.id);
      if (e.isError) s.errors += 1;
      byTool.set(e.tool, s);
      if (prev !== undefined) {
        const key = `${prev} → ${e.tool}`;
        bigrams.set(key, (bigrams.get(key) ?? 0) + 1);
      }
      prev = e.tool;
    }
  }

  return {
    traces: traces.length,
    totalCalls: total,
    meanCallsPerTrace: total / Math.max(1, traces.length),
    mcpShare: total ? mcp / total : 0,
    tools: [...byTool.entries()]
      .map(([tool, s]) => ({
        tool,
        calls: s.calls,
        traces: s.traces.size,
        errorRate: s.calls ? s.errors / s.calls : 0,
      }))
      .sort((a, b) => b.calls - a.calls),
    bigrams: [...bigrams.entries()]
      .map(([pair, count]) => ({ pair, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
  };
}

export function census(all: Trace[]): CensusReport {
  const nonEmpty = all.filter((t) => t.events.length > 0);
  const clusters = clusterByVocabulary(nonEmpty);
  return {
    traces: nonEmpty.length,
    skippedEmpty: all.length - nonEmpty.length,
    populations: clusters.map(censusOne),
  };
}

export function renderCensus(r: CensusReport): string {
  const lines: string[] = [
    `census: ${r.traces} trace(s)` +
      (r.skippedEmpty ? ` (+${r.skippedEmpty} empty skipped)` : ""),
  ];
  for (const [i, p] of r.populations.entries()) {
    lines.push(
      `\npopulation ${i + 1}: ${p.traces} trace(s) · ${p.totalCalls} calls · ` +
        `~${Math.round(p.meanCallsPerTrace)} per trace · ${(p.mcpShare * 100).toFixed(0)}% MCP`,
    );
    for (const t of p.tools.slice(0, 14)) {
      const err = t.errorRate > 0 ? `  (${(t.errorRate * 100).toFixed(0)}% error)` : "";
      lines.push(
        `  ${String(t.calls).padStart(6)}  ${t.tool}  · in ${t.traces}/${p.traces} traces${err}`,
      );
    }
    if (p.bigrams.length) {
      lines.push(`  dominant sequences:`);
      for (const b of p.bigrams.slice(0, 5)) {
        lines.push(`    ${String(b.count).padStart(4)}  ${b.pair}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}
