/** Claude Code stream-json loader (`claude -p --output-format stream-json`).
 *
 * Reads the event stream directly into the normalized Trace model:
 * assistant messages carry tool_use blocks; user messages carry the
 * matching tool_result blocks (correlated by tool_use_id).
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { canonicalTool, type Trace, type ToolEvent } from "./types.js";

interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  text?: string;
}

interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: ContentBlock[] | string };
}

function parseContent(content: unknown): unknown {
  let text: string | undefined;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter((p): p is ContentBlock => typeof p === "object" && p !== null)
      .map((p) => p.text ?? "")
      .join("\n");
  }
  if (text === undefined) return content ?? undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

export function loadStreamJsonTrace(
  path: string,
  meta: Record<string, unknown> = {},
): Trace {
  const events: ToolEvent[] = [];
  const pending = new Map<string, ToolEvent>();
  let step = 0;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(trimmed) as StreamEvent;
    } catch {
      continue;
    }

    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;

    if (ev.type === "assistant") {
      step += 1;
      for (const block of content) {
        if (block.type === "tool_use" && block.id && block.name) {
          const toolEvent: ToolEvent = {
            tool: canonicalTool(block.name),
            rawTool: block.name,
            args: block.input ?? {},
            step,
          };
          events.push(toolEvent);
          pending.set(block.id, toolEvent);
        }
      }
    } else if (ev.type === "user") {
      for (const block of content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const target = pending.get(block.tool_use_id);
          if (target) {
            target.result = parseContent(block.content);
            if (block.is_error) target.isError = true;
            pending.delete(block.tool_use_id);
          }
        }
      }
    }
  }

  return {
    id: basename(path).replace(/\.jsonl?$/, ""),
    events,
    // stream-json has no timestamps; callers pass runDate via meta.runDate
    runDate: meta["runDate"] instanceof Date ? (meta["runDate"] as Date) : new Date(),
    meta,
  };
}
