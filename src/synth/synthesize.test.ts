import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAtifTrace } from "../trace/atif.js";
import { loadStreamJsonTrace } from "../trace/stream-json.js";
import { detectActionTool, synthesize } from "./index.js";
import { guardToString, type CallStep, type GateStep } from "../spec/types.js";
import { loadSpec, SpecParseError, writeSpec } from "../spec/io.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures");

function loadCorpusFixtures() {
  const manifest = JSON.parse(
    readFileSync(join(FIXTURES, "manifest.json"), "utf8"),
  ) as Record<string, Record<string, unknown>>;
  return Object.keys(manifest).map((f) =>
    loadAtifTrace(join(FIXTURES, f), manifest[f] ?? {}),
  );
}

describe("full synthesis pipeline on real corpus traces", () => {
  const traces = loadCorpusFixtures();
  const result = synthesize(traces, {
    name: "refund-agent",
    inputKeys: { order_id: "orderId" },
  });

  it("auto-detects the consequential action without being told", () => {
    expect(result.actionTool).toBe("issue_refund");
    expect(detectActionTool(traces)).toBe("issue_refund");
  });

  it("defaults to the shallow guard — the field the agent directly branches on", () => {
    const gate = result.spec.steps.find((s): s is GateStep => s.kind === "gate");
    expect(gate).toBeDefined();
    expect(guardToString(gate!.guard)).toBe("(refund_policy.max_amount > 0.25)");
    expect(result.trainingAgreement).toBe(1);
  });

  it("recovers the hidden deep policy when scoped to observation tools", () => {
    const deep = synthesize(traces, {
      name: "refund-agent-deep",
      inputKeys: { order_id: "orderId" },
      guardScope: ["get_order"],
    });
    const gate = deep.spec.steps.find((s): s is GateStep => s.kind === "gate")!;
    const text = guardToString(gate.guard);
    expect(text).toContain("order.shipped_at.age_days > 30.5");
    expect(text).toContain('order.status == "delivered"');
    expect(text).toContain("order.total > 0.25");
    expect(deep.trainingAgreement).toBe(1);
  });

  it("lifts literal args into data-flow references", () => {
    const calls = result.spec.steps.filter((s): s is CallStep => s.kind === "call");
    const order = calls.find((c) => c.tool === "get_order");
    expect(order?.args["order_id"]).toBe("${input.orderId}");

    const gate = result.spec.steps.find((s): s is GateStep => s.kind === "gate")!;
    const refund = gate.then.find(
      (s): s is CallStep => s.kind === "call" && s.tool === "issue_refund",
    );
    expect(refund?.args["amount"]).toBe("${refund_policy.max_amount}");
  });

  it("marks the distractor as not load-bearing", () => {
    const calls = result.spec.steps.filter((s): s is CallStep => s.kind === "call");
    const customer = calls.find((c) => c.tool === "get_customer");
    expect(customer?.loadBearing).toBe(false);
    const order = calls.find((c) => c.tool === "get_order");
    expect(order?.loadBearing).toBe(true);
  });

  it("round-trips through YAML without loss", () => {
    const dir = mkdtempSync(join(tmpdir(), "tracegraph-"));
    const path = join(dir, "spec.yaml");
    writeSpec(path, result.spec);
    const loaded = loadSpec(path);
    expect(loaded).toEqual(JSON.parse(JSON.stringify(result.spec)));
  });

  it("rejects invalid specs with a useful error", () => {
    const dir = mkdtempSync(join(tmpdir(), "tracegraph-"));
    const bad = join(dir, "bad.yaml");
    writeSpec(bad, { ...result.spec, steps: [{ kind: "wat" }] } as never);
    expect(() => loadSpec(bad)).toThrow(SpecParseError);
    expect(() => loadSpec(bad)).toThrow(/unknown kind "wat"/);
  });
});

describe("hard case: semantically opaque tool names (v0 variant)", () => {
  const hard = readdirSync(FIXTURES)
    .filter((f) => f.startsWith("hard-v0"))
    .map((f) => loadAtifTrace(join(FIXTURES, f)));

  it("canonicalizes namespaced opaque names without inventing meaning", () => {
    // Real traces interleave harness tools (ToolSearch, Write) with MCP
    // calls — only assert the shape of the MCP ones.
    const mcpEvents = hard.flatMap((t) => t.events.filter((e) => e.rawTool.startsWith("mcp__")));
    expect(mcpEvents.length).toBeGreaterThan(4);
    for (const e of mcpEvents) {
      expect(e.tool).toMatch(/^t\d$/);
      expect(e.rawTool).toMatch(/^mcp__refund-tools__t\d$/);
    }
  });

  it("preserves the disordered call sequence of the failure trace verbatim", () => {
    const failure = hard.find((t) => t.id.includes("4199"))!;
    const seq = failure.events.map((e) => e.tool);
    // The documented bad run: refund fired mid-exploration, checks continued after.
    const refundIdx = seq.findIndex((t) => t === "t3");
    expect(refundIdx).toBeGreaterThan(-1);
    expect(seq.length).toBeGreaterThan(refundIdx + 1);
  });
});

describe("heterogeneous trace directories (mixed populations)", () => {
  it("separates opaque-variant traces from normal ones by vocabulary", async () => {
    const { clusterByVocabulary } = await import("./cluster.js");
    const normal = loadCorpusFixtures();
    const hard = readdirSync(FIXTURES)
      .filter((f) => f.startsWith("hard-v0"))
      .map((f) => loadAtifTrace(join(FIXTURES, f)));
    const clusters = clusterByVocabulary([...normal, ...hard]);
    expect(clusters.length).toBe(2);
    expect(clusters[0]!.length).toBe(normal.length);
    expect(clusters[1]!.length).toBe(hard.length);
  });

  it("stream traces cluster with ATIF traces of the same task", async () => {
    const { clusterByVocabulary } = await import("./cluster.js");
    const normal = loadCorpusFixtures();
    const stream = loadStreamJsonTrace(join(FIXTURES, "stream-ORD-8273.jsonl"));
    const clusters = clusterByVocabulary([...normal, stream]);
    expect(clusters.length).toBe(1);
  });
});

describe("stream-json loader parity with ATIF", () => {
  it("extracts the same core tool sequence from the raw stream as from ATIF", () => {
    const stream = loadStreamJsonTrace(join(FIXTURES, "stream-ORD-8273.jsonl"));
    const atif = loadAtifTrace(join(FIXTURES, "refund-ORD-8273__1.json"));
    const core = (events: typeof stream.events) =>
      events
        .map((e) => e.tool)
        .filter((t) =>
          ["get_order", "check_refund_policy", "issue_refund", "get_customer"].includes(t),
        );
    expect(core(stream.events)).toEqual(core(atif.events));
  });

  it("parses tool results into structured objects", () => {
    const stream = loadStreamJsonTrace(join(FIXTURES, "stream-ORD-8273.jsonl"));
    const order = stream.events.find((e) => e.tool === "get_order");
    expect(order?.result).toMatchObject({ status: "delivered" });
  });
});
