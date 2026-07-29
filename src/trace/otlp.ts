/** OpenTelemetry GenAI loader (OTLP/JSON file export).
 *
 * Reads spans following the GenAI semantic conventions (pre-1.0,
 * "Development" stability — mappings here are deliberately tolerant):
 *
 *   - tool executions:  gen_ai.operation.name == "execute_tool"
 *     (fallback: any span carrying gen_ai.tool.name)
 *   - tool name:        gen_ai.tool.name
 *   - arguments:        gen_ai.tool.call.arguments — structured kvlist OR
 *                       JSON string, per the spec's "MAY be recorded as a
 *                       JSON string" clause
 *   - result:           gen_ai.tool.call.result (same duality)
 *   - dialect fallbacks: gen_ai.tool.input / gen_ai.tool.output,
 *                       input.value / output.value (OpenInference-style)
 *   - errors:           span status.code == 2 (STATUS_CODE_ERROR)
 *
 * Sessions: spans group into one Trace per gen_ai.conversation.id when
 * present, else per traceId. Events order by startTimeUnixNano.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { canonicalTool, type Trace, type ToolEvent } from "./types.js";

interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: OtlpKeyValue[] };
}

interface OtlpKeyValue {
  key: string;
  value?: OtlpAnyValue;
}

interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  name?: string;
  startTimeUnixNano?: string | number;
  attributes?: OtlpKeyValue[];
  status?: { code?: number };
}

interface OtlpFile {
  resourceSpans?: {
    scopeSpans?: { spans?: OtlpSpan[] }[];
  }[];
}

function decode(v: OtlpAnyValue | undefined): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(decode);
  if (v.kvlistValue) {
    const out: Record<string, unknown> = {};
    for (const kv of v.kvlistValue.values ?? []) out[kv.key] = decode(kv.value);
    return out;
  }
  return undefined;
}

function attrs(span: OtlpSpan): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const kv of span.attributes ?? []) m.set(kv.key, decode(kv.value));
  return m;
}

/** Structured object, or parsed JSON string, or undefined. */
function structured(v: unknown): Record<string, unknown> | unknown | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    const t = v.trim();
    // Includes JSON-encoded scalars ('"text"') — some exporters stringify
    // everything, so a leading quote means one layer of JSON wrapping.
    if (t.startsWith("{") || t.startsWith("[") || t.startsWith('"')) {
      try {
        return JSON.parse(t);
      } catch {
        return v;
      }
    }
    return v;
  }
  return v;
}

const ARG_KEYS = ["gen_ai.tool.call.arguments", "gen_ai.tool.input", "input.value"];
const RESULT_KEYS = ["gen_ai.tool.call.result", "gen_ai.tool.output", "output.value"];

export function loadOtlpTraces(path: string): Trace[] {
  const file = JSON.parse(readFileSync(path, "utf8")) as OtlpFile;
  const spans: OtlpSpan[] = [];
  for (const rs of file.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      spans.push(...(ss.spans ?? []));
    }
  }
  if (spans.length === 0 && !file.resourceSpans) {
    throw new Error(
      `${path}: not an OTLP/JSON export (missing "resourceSpans")`,
    );
  }

  const sessions = new Map<string, { span: OtlpSpan; a: Map<string, unknown> }[]>();
  for (const span of spans) {
    const a = attrs(span);
    const op = a.get("gen_ai.operation.name");
    const isTool = op === "execute_tool" || (op === undefined && a.has("gen_ai.tool.name"));
    if (!isTool) continue;
    const session = String(a.get("gen_ai.conversation.id") ?? span.traceId ?? "default");
    (sessions.get(session) ?? sessions.set(session, []).get(session)!).push({ span, a });
  }

  const traces: Trace[] = [];
  for (const [session, items] of sessions) {
    items.sort(
      (x, y) => Number(x.span.startTimeUnixNano ?? 0) - Number(y.span.startTimeUnixNano ?? 0),
    );
    const events: ToolEvent[] = [];
    let runDate: Date | undefined;
    for (const [i, { span, a }] of items.entries()) {
      const rawTool = String(a.get("gen_ai.tool.name") ?? span.name ?? "unknown");
      const argsRaw = ARG_KEYS.map((k) => a.get(k)).find((v) => v !== undefined);
      const resultRaw = RESULT_KEYS.map((k) => a.get(k)).find((v) => v !== undefined);
      const args = structured(argsRaw);
      const start = Number(span.startTimeUnixNano ?? 0);
      if (!runDate && start > 0) runDate = new Date(start / 1e6);
      events.push({
        tool: canonicalTool(rawTool),
        rawTool,
        args:
          typeof args === "object" && args !== null && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {},
        result: structured(resultRaw),
        isError: span.status?.code === 2,
        step: i + 1,
      });
    }
    traces.push({
      id: `${basename(path).replace(/\.json$/, "")}:${session.slice(0, 12)}`,
      events,
      runDate: runDate ?? new Date(),
      meta: { session },
    });
  }
  return traces;
}

/** Cheap content sniff so CLI directory loading can route mixed files. */
export function looksLikeOtlp(path: string): boolean {
  try {
    const head = readFileSync(path, "utf8", ).slice(0, 2000);
    return head.includes('"resourceSpans"');
  } catch {
    return false;
  }
}
