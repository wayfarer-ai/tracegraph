/** ATIF (Agent Trajectory Interchange Format) loader.
 *
 * ATIF is emitted by Harbor-integrated agents (claude-code, openhands,
 * terminus-2, ...) and by tracegraph's own capture tooling. We read the
 * subset synthesis needs: steps -> tool_calls + observation results.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { canonicalTool, type Trace, type ToolEvent } from "./types.js";

interface AtifToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, unknown>;
}

interface AtifObservationResult {
  source_call_id?: string | null;
  content?: unknown;
  extra?: Record<string, unknown> | null;
}

interface AtifStep {
  step_id: number;
  timestamp?: string | null;
  source: string;
  tool_calls?: AtifToolCall[] | null;
  observation?: { results?: AtifObservationResult[] | null } | null;
}

interface AtifTrajectory {
  schema_version?: string;
  session_id?: string;
  steps: AtifStep[];
}

function parseContent(content: unknown): unknown {
  if (typeof content !== "string") return content ?? undefined;
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return content;
  try {
    return JSON.parse(trimmed);
  } catch {
    return content;
  }
}

export function loadAtifTrace(
  path: string,
  meta: Record<string, unknown> = {},
): Trace {
  const traj = JSON.parse(readFileSync(path, "utf8")) as AtifTrajectory;
  const events: ToolEvent[] = [];
  let runDate: Date | undefined;

  for (const step of traj.steps ?? []) {
    if (!runDate && step.timestamp) {
      const d = new Date(step.timestamp);
      if (!Number.isNaN(d.getTime())) runDate = d;
    }
    const results = new Map<string, AtifObservationResult>();
    for (const r of step.observation?.results ?? []) {
      if (r.source_call_id) results.set(r.source_call_id, r);
    }
    for (const tc of step.tool_calls ?? []) {
      const r = results.get(tc.tool_call_id);
      events.push({
        tool: canonicalTool(tc.function_name),
        rawTool: tc.function_name,
        args: tc.arguments ?? {},
        result: r ? parseContent(r.content) : undefined,
        isError: Boolean(r?.extra?.["is_error"]),
        step: step.step_id,
      });
    }
  }

  return {
    id: basename(path).replace(/\.json$/, ""),
    events,
    runDate: runDate ?? new Date(),
    meta,
  };
}
