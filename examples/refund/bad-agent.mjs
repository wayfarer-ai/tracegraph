#!/usr/bin/env node
/** A scripted misbehaving agent — reenacts a REAL failure we captured from
 * a frontier model under confusing tool names: it looks up the order,
 * botches the policy check (passes the customer id), and issues the refund
 * anyway without ever holding a valid policy answer.
 *
 * Run it against the gate to watch the deviation get blocked live, no LLM
 * or API key required:
 *
 *   node examples/refund/server.mjs &
 *   node examples/refund/bad-agent.mjs        # gate spawned automatically
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "..", "dist", "cli.js");
const SPEC = process.env.SPEC ?? join(HERE, "refund.spec.yaml");
const MODE = process.env.MODE ?? "block";

const agent = new Client({ name: "bad-agent", version: "1.0.0" });
await agent.connect(
  new StdioClientTransport({
    command: "node",
    args: [
      CLI, "gate",
      "--spec", SPEC,
      "--mode", MODE,
      "--target-url", "http://127.0.0.1:8321/mcp",
      "--log", join(HERE, "gate-demo.jsonl"),
    ],
  }),
);

const call = async (name, args) => {
  const r = await agent.callTool({ name, arguments: args });
  const text = (r.content ?? []).map((c) => c.text).join("");
  console.log(`${r.isError ? "✗" : "→"} ${name}(${JSON.stringify(args)})`);
  console.log(`   ${text}`);
  return r;
};

console.log("reenacting the captured failure: refund ORD-1002 (NOT eligible)\n");
await call("get_order", { order_id: "ORD-1002" });
// the real captured mistake: customer id passed where the order id belongs
await call("check_refund_policy", { order_id: "CUST-1004" });
const refund = await call("issue_refund", { order_id: "ORD-1002", amount: 60 });

console.log(
  refund.isError
    ? "\nthe gate blocked the refund — the tool never executed."
    : "\nshadow mode: the refund went through, but the deviation was logged.",
);
await agent.close();
