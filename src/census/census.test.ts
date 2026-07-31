import { describe, expect, it } from "vitest";
import { census, renderCensus } from "./index.js";
import type { Trace } from "../trace/types.js";

function trace(id: string, events: [string, boolean, unknown?][]): Trace {
  return {
    id,
    runDate: new Date("2026-07-31T00:00:00Z"),
    meta: {},
    events: events.map(([tool, isError, result], i) => ({
      tool,
      rawTool: tool,
      args: {},
      result,
      isError,
      step: i + 1,
    })),
  };
}

describe("census", () => {
  const traces = [
    trace("a", [
      ["fetch", false, "ok"],
      ["fetch", true, "HTTP 403: Forbidden\ndetails..."],
      ["fetch", true, "HTTP 403: Forbidden\nother details"],
      ["browser_click", false, "clicked"],
    ]),
    trace("b", [
      ["fetch", true, { error: "timeout after 30s" }],
      ["parse", false, "{}"],
    ]),
    trace("empty", []),
  ];

  it("aggregates counts, error rates, and MCP share per population", () => {
    const r = census(traces);
    expect(r.skippedEmpty).toBe(1);
    const pop = r.populations[0]!;
    const fetch = pop.tools.find((t) => t.tool === "fetch")!;
    expect(fetch.calls).toBe(4);
    expect(fetch.errorRate).toBeCloseTo(0.75);
  });

  it("surfaces the top error messages, first-line truncated and deduped", () => {
    const r = census(traces);
    const fetch = r.populations
      .flatMap((p) => p.tools)
      .find((t) => t.tool === "fetch")!;
    expect(fetch.topErrors[0]).toEqual({ message: "HTTP 403: Forbidden", count: 2 });
    expect(fetch.topErrors[1]!.message).toContain("timeout after 30s");
    const text = renderCensus(r);
    expect(text).toContain("↳ 2× HTTP 403: Forbidden");
  });
});
