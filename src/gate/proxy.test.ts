/** End-to-end gate test: agent-client ↔ GateProxy ↔ real in-process MCP
 * server with the spike's refund backend (deterministic, and deliberately
 * NO eligibility guardrail on issue_refund — the gate is the guardrail).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadAtifTrace } from "../trace/atif.js";
import { synthesize } from "../synth/index.js";
import { GateProxy } from "./proxy.js";
import type { GateMode } from "./core.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures");

function loadSpecFromFixtures() {
  const manifest = JSON.parse(
    readFileSync(join(FIXTURES, "manifest.json"), "utf8"),
  ) as Record<string, Record<string, unknown>>;
  const traces = Object.keys(manifest).map((f) =>
    loadAtifTrace(join(FIXTURES, f), manifest[f] ?? {}),
  );
  return synthesize(traces, { name: "refund" }).spec;
}

interface Backend {
  refunds: { order_id: string; amount: number }[];
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

/** Mirror of the spike's refund-tools server, in-process. */
function makeTarget(orders: Record<string, { shipped_at: string; status: string; total: number }>) {
  const backend: Backend = { refunds: [] };
  const server = new McpServer({ name: "refund-tools", version: "1.0.0" });
  const json = (v: unknown): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(v) }],
  });

  server.registerTool(
    "get_order",
    { inputSchema: { order_id: z.string() } },
    async ({ order_id }) => {
      const o = orders[order_id];
      return json(o ? { id: order_id, ...o } : { error: "not found" });
    },
  );
  server.registerTool(
    "check_refund_policy",
    { inputSchema: { order_id: z.string() } },
    async ({ order_id }) => {
      const o = orders[order_id];
      if (!o) return json({ error: "not found" });
      const age = Math.floor((Date.now() - new Date(o.shipped_at).getTime()) / 86_400_000);
      const eligible = o.status === "delivered" && age > 30;
      return json({ eligible, max_amount: eligible ? o.total : 0, reason: "test" });
    },
  );
  server.registerTool(
    "issue_refund",
    { inputSchema: { order_id: z.string(), amount: z.number() } },
    async ({ order_id, amount }) => {
      // NO eligibility guardrail, exactly like the spike backend.
      backend.refunds.push({ order_id, amount });
      return json({ ok: true, refund_id: `rf_${backend.refunds.length}` });
    },
  );
  return { server, backend };
}

async function setup(mode: GateMode, orders: Parameters<typeof makeTarget>[0]) {
  const { server: target, backend } = makeTarget(orders);
  const [targetClientSide, targetServerSide] = InMemoryTransport.createLinkedPair();
  await target.connect(targetServerSide);

  const proxy = new GateProxy({ spec: loadSpecFromFixtures(), mode });
  const [agentSide, proxyServerSide] = InMemoryTransport.createLinkedPair();
  await proxy.connect(proxyServerSide, targetClientSide);

  const agent = new Client({ name: "test-agent", version: "1.0.0" });
  await agent.connect(agentSide);
  return { agent, proxy, backend };
}

async function call(agent: Client, name: string, args: Record<string, unknown>) {
  return (await agent.callTool({ name, arguments: args })) as CallToolResult;
}

describe("gate proxy end-to-end over real MCP transports", () => {
  const ORDERS = {
    "ORD-OK": { shipped_at: daysAgo(45), status: "delivered", total: 80 },
    "ORD-YOUNG": { shipped_at: daysAgo(20), status: "delivered", total: 80 },
  };

  it("re-exposes the target's tools to the agent", async () => {
    const { agent, proxy } = await setup("block", ORDERS);
    const tools = await agent.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "check_refund_policy",
      "get_order",
      "issue_refund",
    ]);
    await proxy.close();
  });

  it("conformant session flows through untouched, refund executes", async () => {
    const { agent, proxy, backend } = await setup("block", ORDERS);
    await call(agent, "get_order", { order_id: "ORD-OK" });
    await call(agent, "check_refund_policy", { order_id: "ORD-OK" });
    const r = await call(agent, "issue_refund", { order_id: "ORD-OK", amount: 80 });
    expect(r.isError).toBeFalsy();
    expect(backend.refunds).toEqual([{ order_id: "ORD-OK", amount: 80 }]);
    expect(proxy.gate.decisions.every((d) => d.action === "allow")).toBe(true);
    await proxy.close();
  });

  it("block mode: ineligible refund is refused and the real tool NEVER runs", async () => {
    const { agent, proxy, backend } = await setup("block", ORDERS);
    await call(agent, "get_order", { order_id: "ORD-YOUNG" });
    await call(agent, "check_refund_policy", { order_id: "ORD-YOUNG" });
    const r = await call(agent, "issue_refund", { order_id: "ORD-YOUNG", amount: 80 });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("tracegraph gate blocked issue_refund");
    expect(backend.refunds).toEqual([]); // the money never moved
    await proxy.close();
  });

  it("block mode: refund with NO prior lookups at all is refused", async () => {
    const { agent, proxy, backend } = await setup("block", ORDERS);
    const r = await call(agent, "issue_refund", { order_id: "ORD-OK", amount: 80 });
    expect(r.isError).toBe(true);
    expect(backend.refunds).toEqual([]);
    await proxy.close();
  });

  it("shadow mode: same violation observed, but the call goes through", async () => {
    const { agent, proxy, backend } = await setup("shadow", ORDERS);
    await call(agent, "get_order", { order_id: "ORD-YOUNG" });
    await call(agent, "check_refund_policy", { order_id: "ORD-YOUNG" });
    const r = await call(agent, "issue_refund", { order_id: "ORD-YOUNG", amount: 80 });
    expect(r.isError).toBeFalsy();
    expect(backend.refunds.length).toBe(1);
    const flagged = proxy.gate.decisions.filter((d) => d.action === "would-block");
    expect(flagged.map((d) => d.tool)).toEqual(["issue_refund"]);
    await proxy.close();
  });

  it("agent can recover after a block: fetch state, act on an eligible order", async () => {
    const { agent, proxy, backend } = await setup("block", ORDERS);
    await call(agent, "get_order", { order_id: "ORD-YOUNG" });
    await call(agent, "check_refund_policy", { order_id: "ORD-YOUNG" });
    const blocked = await call(agent, "issue_refund", { order_id: "ORD-YOUNG", amount: 80 });
    expect(blocked.isError).toBe(true);
    // The agent adapts: looks up the other order — session state updates —
    // and the gate allows the now-legitimate refund.
    await call(agent, "get_order", { order_id: "ORD-OK" });
    await call(agent, "check_refund_policy", { order_id: "ORD-OK" });
    const ok = await call(agent, "issue_refund", { order_id: "ORD-OK", amount: 80 });
    expect(ok.isError).toBeFalsy();
    expect(backend.refunds).toEqual([{ order_id: "ORD-OK", amount: 80 }]);
    await proxy.close();
  });
});
