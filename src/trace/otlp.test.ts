import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOtlpTraces, looksLikeOtlp } from "./otlp.js";
import { synthesize } from "../synth/index.js";
import { guardToString, type GateStep } from "../spec/types.js";

/** Build a convention-faithful OTLP/JSON export. The GenAI conventions are
 * pre-1.0, so this fixture deliberately mixes the encodings real exporters
 * produce: structured kvlist args, JSON-string args, OpenInference-style
 * fallback keys, error status, and both session mechanisms. */

type Dialect = "semconv-structured" | "semconv-string" | "openinference";

let nano = BigInt(Date.now()) * 1_000_000n;

function kv(key: string, value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") return { key, value: { doubleValue: value } };
  return {
    key,
    value: {
      kvlistValue: {
        values: Object.entries(value as Record<string, unknown>).map(([k, v]) => kv(k, v)),
      },
    },
  };
}

function toolSpan(opts: {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  session?: string;
  traceId?: string;
  error?: boolean;
  dialect?: Dialect;
}) {
  const dialect = opts.dialect ?? "semconv-string";
  nano += 1_000_000_000n;
  const attributes: Record<string, unknown>[] = [
    kv("gen_ai.operation.name", "execute_tool"),
    kv("gen_ai.tool.name", opts.tool),
  ];
  if (opts.session) attributes.push(kv("gen_ai.conversation.id", opts.session));
  if (dialect === "semconv-structured") {
    attributes.push(kv("gen_ai.tool.call.arguments", opts.args));
    attributes.push(kv("gen_ai.tool.call.result", JSON.stringify(opts.result)));
  } else if (dialect === "semconv-string") {
    attributes.push(kv("gen_ai.tool.call.arguments", JSON.stringify(opts.args)));
    attributes.push(kv("gen_ai.tool.call.result", JSON.stringify(opts.result)));
  } else {
    attributes.push(kv("input.value", JSON.stringify(opts.args)));
    attributes.push(kv("output.value", JSON.stringify(opts.result)));
  }
  return {
    traceId: opts.traceId ?? "t-default",
    spanId: `s${nano}`,
    name: `execute_tool ${opts.tool}`,
    startTimeUnixNano: String(nano),
    attributes,
    status: opts.error ? { code: 2 } : { code: 1 },
  };
}

function refundSession(opts: {
  session: string;
  ageDays: number;
  status: string;
  total: number;
  refunds: boolean;
  dialect?: Dialect;
}) {
  const shipped = new Date(Date.now() - opts.ageDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const order = { id: "ORD-1", shipped_at: shipped, status: opts.status, total: opts.total };
  const eligible = opts.status === "delivered" && opts.ageDays > 30;
  const spans = [
    toolSpan({
      tool: "get_order",
      args: { order_id: "ORD-1" },
      result: order,
      session: opts.session,
      dialect: opts.dialect,
    }),
    toolSpan({
      tool: "check_refund_policy",
      args: { order_id: "ORD-1" },
      result: { eligible, max_amount: eligible ? opts.total : 0 },
      session: opts.session,
      dialect: opts.dialect,
    }),
  ];
  if (opts.refunds) {
    spans.push(
      toolSpan({
        tool: "issue_refund",
        args: { order_id: "ORD-1", amount: opts.total },
        result: { ok: true, refund_id: "rf_1" },
        session: opts.session,
        dialect: opts.dialect,
      }),
    );
  }
  return spans;
}

function writeExport(spans: Record<string, unknown>[]): string {
  const dir = mkdtempSync(join(tmpdir(), "tracegraph-otlp-"));
  const path = join(dir, "export.json");
  writeFileSync(
    path,
    JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] }),
  );
  return path;
}

describe("OTel GenAI loader on convention-faithful exports", () => {
  it("handles the spec's structured/string argument duality and dialect fallbacks", () => {
    const path = writeExport([
      ...refundSession({ session: "a", ageDays: 45, status: "delivered", total: 80, refunds: true, dialect: "semconv-structured" }),
      ...refundSession({ session: "b", ageDays: 20, status: "delivered", total: 80, refunds: false, dialect: "openinference" }),
    ]);
    const traces = loadOtlpTraces(path);
    expect(traces.length).toBe(2);

    const a = traces.find((t) => t.meta["session"] === "a")!;
    expect(a.events.map((e) => e.tool)).toEqual([
      "get_order",
      "check_refund_policy",
      "issue_refund",
    ]);
    expect(a.events[0]!.args).toEqual({ order_id: "ORD-1" });
    expect((a.events[1]!.result as { eligible: boolean }).eligible).toBe(true);

    const b = traces.find((t) => t.meta["session"] === "b")!;
    expect(b.events.length).toBe(2);
    expect((b.events[1]!.result as { eligible: boolean }).eligible).toBe(false);
  });

  it("groups by traceId when no conversation id exists, flags error spans", () => {
    const path = writeExport([
      toolSpan({ tool: "mcp__billing__charge", args: { amount: 5 }, result: { ok: true }, traceId: "t1" }),
      toolSpan({ tool: "lookup", args: { q: "x" }, result: "plain text result", traceId: "t2", error: true }),
    ]);
    const traces = loadOtlpTraces(path);
    expect(traces.length).toBe(2);
    const t1 = traces.find((t) => String(t.meta["session"]).includes("t1"))!;
    expect(t1.events[0]!.tool).toBe("charge"); // mcp namespacing stripped
    const t2 = traces.find((t) => String(t.meta["session"]).includes("t2"))!;
    expect(t2.events[0]!.isError).toBe(true);
    expect(t2.events[0]!.result).toBe("plain text result");
  });

  it("synthesizes the real guard end-to-end from OTel input alone", () => {
    const sessions = [
      { ageDays: 20, refunds: false },
      { ageDays: 25, refunds: false },
      { ageDays: 29, refunds: false },
      { ageDays: 35, refunds: true },
      { ageDays: 45, refunds: true },
      { ageDays: 60, refunds: true },
    ].flatMap((s, i) =>
      refundSession({ session: `s${i}`, status: "delivered", total: 80, ...s }),
    );
    const traces = loadOtlpTraces(writeExport(sessions));
    const { spec, actionTool, trainingAgreement } = synthesize(traces, {
      name: "otel-refund",
      guardScope: ["get_order"],
    });
    expect(actionTool).toBe("issue_refund");
    expect(trainingAgreement).toBe(1);
    const gate = spec.steps.find((s): s is GateStep => s.kind === "gate")!;
    // boundary between observed ages 29 and 35 -> midpoint 32
    expect(guardToString(gate.guard)).toBe("(order.shipped_at.age_days > 32)");
  });

  it("rejects non-OTLP files with a useful error, and sniffs real ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "tracegraph-otlp-"));
    const bad = join(dir, "not-otlp.json");
    writeFileSync(bad, JSON.stringify({ hello: "world" }));
    expect(() => loadOtlpTraces(bad)).toThrow(/resourceSpans/);
    expect(looksLikeOtlp(bad)).toBe(false);
    const good = writeExport([
      toolSpan({ tool: "x", args: {}, result: {} }),
    ]);
    expect(looksLikeOtlp(good)).toBe(true);
  });
});
