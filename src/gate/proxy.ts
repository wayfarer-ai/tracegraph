/** The gate as an MCP proxy.
 *
 * Sits between an agent and its real MCP server: re-exposes the target's
 * tools, judges every call with a SpecGate before forwarding, records
 * results into session state, and appends every decision to a JSONL log.
 *
 * Blocked calls return an is_error tool result explaining the violation —
 * the agent sees a refusal it can react to; the real tool never runs.
 */

import { appendFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { InvariantRule, TraceGraphSpec } from "../spec/types.js";
import { SpecGate, type GateDecision, type GateMode } from "./core.js";

export interface GateProxyOptions {
  spec: TraceGraphSpec;
  rules?: InvariantRule[];
  mode?: GateMode;
  /** JSONL decision log path; omit to keep decisions in memory only. */
  logPath?: string;
  onDecision?: (d: GateDecision) => void;
}

function parseResultContent(result: CallToolResult): unknown {
  const text = (result.content ?? [])
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

export class GateProxy {
  readonly gate: SpecGate;
  readonly server: Server;
  private readonly target: Client;
  private readonly opts: GateProxyOptions;

  constructor(opts: GateProxyOptions) {
    this.opts = opts;
    this.gate = new SpecGate(opts.spec, { mode: opts.mode, rules: opts.rules });
    this.target = new Client({ name: "tracegraph-gate", version: "0.0.1" });
    this.server = new Server(
      { name: "tracegraph-gate", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () =>
      this.target.listTools(),
    );

    this.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const tool = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const decision = this.gate.judge(tool);
      this.emit(decision);

      if (decision.action === "block") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `tracegraph gate blocked ${tool}: ` +
                decision.violations.join("; ") +
                ". The call was not executed.",
            },
          ],
        } satisfies CallToolResult;
      }

      const result = (await this.target.callTool({
        name: tool,
        arguments: args,
      })) as CallToolResult;
      this.gate.record({
        tool,
        args,
        result: parseResultContent(result),
        isError: Boolean(result.isError),
      });
      return result;
    });
  }

  private emit(d: GateDecision): void {
    this.opts.onDecision?.(d);
    if (this.opts.logPath) {
      appendFileSync(this.opts.logPath, JSON.stringify(d) + "\n");
    }
  }

  /** Connect the upstream (agent-facing) and downstream (target) transports. */
  async connect(agentSide: Transport, targetSide: Transport): Promise<void> {
    await this.target.connect(targetSide);
    await this.server.connect(agentSide);
  }

  async close(): Promise<void> {
    await this.server.close();
    await this.target.close();
  }
}
