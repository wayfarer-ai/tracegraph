#!/usr/bin/env node
/** Second example domain: support-ticket triage.
 *
 * The hidden rule is deliberately a different SHAPE from the refund
 * example: SLA thresholds vary by priority (urgent 4h, high 8h,
 * normal 24h, low 72h) — a categorical × numeric interaction.
 * check_sla computes it; escalate_ticket does NOT enforce it.
 *
 * Run:  node examples/triage/server.mjs      (streamable-http on :8322)
 */

import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 8322);
const SLA_HOURS = { urgent: 4, high: 8, normal: 24, low: 72 };

/** Tickets come from TICKETS env (JSON) or a small default set. */
const TICKETS = process.env.TICKETS
  ? JSON.parse(process.env.TICKETS)
  : {
      "TCK-2001": { priority: "urgent", category: "outage", opened_hours_ago: 6, customer_tier: "gold" },
      "TCK-2002": { priority: "normal", category: "billing", opened_hours_ago: 20, customer_tier: "standard" },
      "TCK-2003": { priority: "low", category: "question", opened_hours_ago: 90, customer_tier: "silver" },
    };

const escalations = [];
const callLog = [];

const json = (v) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const log = (tool, args, result) => callLog.push({ tool, args, result });

function buildMcp() {
  const mcp = new McpServer({ name: "triage-tools", version: "1.0.0" });

  mcp.registerTool(
    "get_ticket",
    {
      description:
        "Look up a support ticket: priority (urgent/high/normal/low), category, opened_hours_ago, customer_tier.",
      inputSchema: { ticket_id: z.string() },
    },
    async ({ ticket_id }) => {
      const t = TICKETS[ticket_id];
      const r = t ? { id: ticket_id, ...t } : { error: `ticket ${ticket_id} not found` };
      log("get_ticket", { ticket_id }, r);
      return json(r);
    },
  );

  mcp.registerTool(
    "check_sla",
    {
      description:
        "Check a ticket against its SLA. Returns breached (bool), hours_over, and the applicable sla_hours.",
      inputSchema: { ticket_id: z.string() },
    },
    async ({ ticket_id }) => {
      const t = TICKETS[ticket_id];
      let r;
      if (!t) r = { error: `ticket ${ticket_id} not found` };
      else {
        const limit = SLA_HOURS[t.priority];
        const breached = t.opened_hours_ago > limit;
        r = {
          breached,
          sla_hours: limit,
          hours_over: breached ? t.opened_hours_ago - limit : 0,
        };
      }
      log("check_sla", { ticket_id }, r);
      return json(r);
    },
  );

  mcp.registerTool(
    "escalate_ticket",
    {
      description:
        "Escalate a ticket to the on-call team. Takes ticket_id and a short reason. Returns ok and escalation_id.",
      inputSchema: { ticket_id: z.string(), reason: z.string() },
    },
    async ({ ticket_id, reason }) => {
      const t = TICKETS[ticket_id];
      let r;
      if (!t) r = { ok: false, error: `ticket ${ticket_id} not found` };
      else {
        // Deliberately NO SLA enforcement here — the agent's decision is
        // the observable under test.
        escalations.push({ ticket_id, reason });
        r = { ok: true, escalation_id: `esc_${escalations.length}` };
      }
      log("escalate_ticket", { ticket_id, reason }, r);
      return json(r);
    },
  );

  mcp.registerTool(
    "get_queue_stats",
    {
      description:
        "Current support queue statistics: open ticket count and on-call load. Not needed for individual triage decisions.",
      inputSchema: {},
    },
    async () => {
      const r = { open_tickets: 42, oncall_load: "moderate" };
      log("get_queue_stats", {}, r);
      return json(r);
    },
  );

  return mcp;
}

createServer(async (req, res) => {
  if (req.url === "/state") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ escalations, call_log: callLog }));
    return;
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await buildMcp().connect(transport);
  await transport.handleRequest(req, res);
}).listen(PORT, () => {
  console.log(`triage-tools MCP server on http://127.0.0.1:${PORT}/mcp (state: /state)`);
});
