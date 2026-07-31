/** Trace-population clustering by tool vocabulary.
 *
 * Real trace directories are messy: different agents, different tool-name
 * variants, different tasks. Synthesizing across populations with disjoint
 * vocabularies produces a nonsense spec, so we cluster first (union-find on
 * Jaccard similarity of each trace's MCP tool set) and let the caller
 * synthesize per cluster or pick the largest.
 */

import type { Trace } from "../trace/types.js";

function vocabulary(trace: Trace): Set<string> {
  const mcp = trace.events.filter((e) => e.rawTool.startsWith("mcp__"));
  const source = mcp.length > 0 ? mcp : trace.events;
  return new Set(source.map((e) => e.tool));
}

/** Overlap coefficient: |A∩B| / min(|A|,|B|).
 *
 * Chosen over Jaccard after dogfooding on real interactive coding
 * sessions: each session activates a different MCP-server mix, so full
 * vocabularies diverge wildly while a working core (the shared tools) stays
 * common. Jaccard shatters those into singleton clusters; the overlap
 * coefficient keeps populations together when one's vocabulary is roughly
 * a subset of another's, yet still separates truly disjoint dialects
 * (renamed tools share nothing, so overlap stays 0). */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / Math.min(a.size, b.size);
}

/** Cluster traces by tool-vocabulary overlap; clusters sorted largest first. */
export function clusterByVocabulary(traces: Trace[], threshold = 0.5): Trace[][] {
  const vocabs = traces.map(vocabulary);
  const parent = traces.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };

  for (let i = 0; i < traces.length; i++) {
    for (let j = i + 1; j < traces.length; j++) {
      if (overlap(vocabs[i]!, vocabs[j]!) >= threshold) {
        parent[find(j)] = find(i);
      }
    }
  }

  const groups = new Map<number, Trace[]>();
  for (let i = 0; i < traces.length; i++) {
    const root = find(i);
    const g = groups.get(root) ?? [];
    g.push(traces[i]!);
    groups.set(root, g);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

/** Human-readable cluster summary for warnings. */
export function describeClusters(clusters: Trace[][]): string {
  return clusters
    .map((c, i) => {
      const union = new Set<string>();
      for (const t of c) for (const tool of vocabulary(t)) union.add(tool);
      const tools = [...union].sort().slice(0, 6).join(", ");
      const label = union.size === 0 ? "no tool calls" : `tools: ${tools}${union.size > 6 ? ", …" : ""}`;
      return `  cluster ${i + 1}: ${c.length} traces (${label})`;
    })
    .join("\n");
}
