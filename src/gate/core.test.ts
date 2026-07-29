import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAtifTrace } from "../trace/atif.js";
import { synthesize } from "../synth/index.js";
import { SpecGate } from "./core.js";
import type { Trace } from "../trace/types.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures");
const V0 = join(FIXTURES, "v0");
const BAD_ID = "refund-ORD-4199__a1";

function loadV0() {
  const manifest = JSON.parse(readFileSync(join(V0, "manifest.json"), "utf8")) as Record<
    string,
    Record<string, unknown>
  >;
  return Object.keys(manifest).map((f) => loadAtifTrace(join(V0, f), manifest[f] ?? {}));
}

/** Replay a recorded trace through a live gate, judging each MCP call
 * before "forwarding" and recording its result after — exactly the proxy's
 * runtime sequence, minus the transport. */
function replayThroughGate(trace: Trace, gate: SpecGate) {
  const perCall: { tool: string; action: string }[] = [];
  for (const e of trace.events) {
    if (!e.rawTool.startsWith("mcp__")) continue;
    const d = gate.judge(e.tool);
    perCall.push({ tool: e.tool, action: d.action });
    if (d.action !== "block") {
      gate.record(e);
    }
  }
  return perCall;
}

describe("SpecGate: the live twin of check", () => {
  const all = loadV0();
  const good = all.filter((t) => t.id !== BAD_ID);
  const bad = all.find((t) => t.id === BAD_ID)!;
  const { spec } = synthesize(good, { name: "refund-v0" });

  it("allows every call of a conformant session", () => {
    const donor = good.find((t) => t.events.some((e) => e.tool === "t3"))!;
    const gate = new SpecGate(spec, { mode: "block", runDate: donor.runDate });
    const calls = replayThroughGate(donor, gate);
    expect(calls.every((c) => c.action === "allow")).toBe(true);
  });

  it("blocks the bad session at exactly the refund call, not before", () => {
    const gate = new SpecGate(spec, { mode: "block", runDate: bad.runDate });
    const calls = replayThroughGate(bad, gate);
    const blocked = calls.filter((c) => c.action === "block");
    expect(blocked).toEqual([{ tool: "t3", action: "block" }]);
    // observation calls before the refund all pass
    const beforeBlock = calls.slice(0, calls.findIndex((c) => c.action === "block"));
    expect(beforeBlock.every((c) => c.action === "allow")).toBe(true);
  });

  it("shadow mode observes the same violation but lets the call through", () => {
    const gate = new SpecGate(spec, { mode: "shadow", runDate: bad.runDate });
    const calls = replayThroughGate(bad, gate);
    expect(calls.some((c) => c.action === "would-block")).toBe(true);
    expect(calls.some((c) => c.action === "block")).toBe(false);
    const flagged = gate.decisions.find((d) => d.action === "would-block")!;
    expect(flagged.tool).toBe("t3");
    expect(flagged.violations[0]).toContain("gate guard does not hold");
  });

  it("enforces ordering rules live (requiresPrior)", () => {
    const gate = new SpecGate(spec, {
      mode: "block",
      rules: [{ action: "t3", requiresPrior: "t2" }],
      runDate: bad.runDate,
    });
    // refund attempted with NO prior calls at all
    const d = gate.judge("t3");
    expect(d.action).toBe("block");
    expect(d.violations.join()).toContain("requires prior t2");
  });

  it("keeps a decision log suitable for the audit trail", () => {
    const gate = new SpecGate(spec, { mode: "shadow", runDate: bad.runDate });
    replayThroughGate(bad, gate);
    expect(gate.decisions.length).toBeGreaterThan(3);
    for (const d of gate.decisions) {
      expect(d.at).toBeTruthy();
      expect(["allow", "would-block"]).toContain(d.action);
    }
  });
});
