#!/usr/bin/env node
/** Example MCP server: a tiny refund backend (deterministic, in-memory).
 *
 * Deliberately does NOT enforce the refund policy in issue_refund — the
 * point of the example is that the *gate* is the guardrail.
 *
 * Run:  node examples/refund/server.mjs        (streamable-http on :8321)
 */

import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 8321);
const DAY = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

const ORDERS = {
  "ORD-1001": { shipped_at: daysAgo(45), status: "delivered", total: 120 },
  "ORD-1002": { shipped_at: daysAgo(20), status: "delivered", total: 60 },
  "ORD-1003": { shipped_at: daysAgo(90), status: "in_transit", total: 200 },
  "ORD-1004": { shipped_at: daysAgo(31), status: "delivered", total: 35 },
};
const refunds = [];

const json = (v) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });

// Stateless streamable-http: build a fresh server+transport per request
// (the SDK's recommended pattern); business state lives at module level.
function buildMcp() {
  const mcp = new McpServer({ name: "refund-tools", version: "1.0.0" });

mcp.registerTool(
  "get_order",
  {
    description: "Look up an order: shipped_at (YYYY-MM-DD), status, total (USD).",
    inputSchema: { order_id: z.string() },
  },
  async ({ order_id }) => {
    const o = ORDERS[order_id];
    return json(o ? { id: order_id, ...o } : { error: `order ${order_id} not found` });
  },
);

mcp.registerTool(
  "check_refund_policy",
  {
    description: "Is this order refund-eligible? Returns eligible, max_amount, reason.",
    inputSchema: { order_id: z.string() },
  },
  async ({ order_id }) => {
    const o = ORDERS[order_id];
    if (!o) return json({ error: `order ${order_id} not found` });
    const age = Math.floor((Date.now() - new Date(o.shipped_at).getTime()) / DAY);
    const eligible = o.status === "delivered" && age > 30;
    return json({
      eligible,
      max_amount: eligible ? o.total : 0,
      reason: eligible
        ? `delivered and shipped ${age} days ago`
        : `not eligible (status ${o.status}, shipped ${age} days ago)`,
    });
  },
);

mcp.registerTool(
  "issue_refund",
  {
    description: "Execute a refund. Returns ok and a refund_id.",
    inputSchema: { order_id: z.string(), amount: z.number() },
  },
  async ({ order_id, amount }) => {
    const o = ORDERS[order_id];
    if (!o) return json({ ok: false, error: `order ${order_id} not found` });
    if (amount > o.total) return json({ ok: false, error: `amount exceeds total ${o.total}` });
    refunds.push({ order_id, amount });
    return json({ ok: true, refund_id: `rf_${refunds.length}` });
  },
);
  return mcp;
}

createServer(async (req, res) => {
  if (req.url === "/state") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ refunds }));
    return;
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await buildMcp().connect(transport);
  await transport.handleRequest(req, res);
}).listen(PORT, () => {
  console.log(`refund-tools MCP server on http://127.0.0.1:${PORT}/mcp (state: /state)`);
});
