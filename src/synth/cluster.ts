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

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
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
      if (jaccard(vocabs[i]!, vocabs[j]!) >= threshold) {
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
      const tools = [...vocabulary(c[0]!)].sort().slice(0, 5).join(", ");
      return `  cluster ${i + 1}: ${c.length} traces (tools: ${tools}${vocabulary(c[0]!).size > 5 ? ", …" : ""})`;
    })
    .join("\n");
}
