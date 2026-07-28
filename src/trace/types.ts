/** Normalized trace model — the common shape all loaders emit. */

export interface ToolEvent {
  /** Canonical tool name with agent namespacing stripped
   * (e.g. `mcp__refund-tools__get_order` -> `get_order`). */
  tool: string;
  /** Raw (namespaced) name as the agent emitted it. */
  rawTool: string;
  args: Record<string, unknown>;
  /** Parsed JSON result when the content was parseable, else undefined. */
  result?: unknown;
  isError?: boolean;
  step: number;
}

export interface Trace {
  id: string;
  events: ToolEvent[];
  /** Wall-clock date of the run — needed for date-derived features. */
  runDate: Date;
  /** Arbitrary metadata carried alongside (ground truth, task name...).
   * Never used by induction; available to evaluation tooling. */
  meta: Record<string, unknown>;
}

/** Strip agent-specific namespacing from a tool name. */
export function canonicalTool(name: string): string {
  const mcp = name.match(/^mcp__.+__(.+)$/);
  if (mcp?.[1]) return mcp[1];
  return name;
}
