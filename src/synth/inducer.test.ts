import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAtifTrace } from "../trace/atif.js";
import { extractFeatures } from "./features.js";
import { evalGuard, induceGuardTree, predict, toGuardExpr } from "./inducer.js";
import { guardToString } from "../spec/types.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures");
const ACTION_TOOLS = new Set(["issue_refund"]);

function loadFixtures() {
  const manifest = JSON.parse(
    readFileSync(join(FIXTURES, "manifest.json"), "utf8"),
  ) as Record<string, { expected_eligible: boolean }>;
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json") && f !== "manifest.json")
    .map((f) => loadAtifTrace(join(FIXTURES, f), manifest[f] ?? {}));
}

function issuedRefund(events: ReturnType<typeof loadAtifTrace>["events"]): boolean {
  return events.some(
    (e) =>
      e.tool === "issue_refund" &&
      typeof e.result === "object" &&
      e.result !== null &&
      (e.result as { ok?: boolean }).ok === true,
  );
}

describe("guard induction on the refund corpus", () => {
  const traces = loadFixtures();
  const rows = traces.map((t) => ({
    features: extractFeatures(t, { actionTools: ACTION_TOOLS, tools: ["get_order"] }),
    label: issuedRefund(t.events),
  }));

  it("loads a meaningful fixture set", () => {
    expect(traces.length).toBe(16);
    expect(rows.filter((r) => r.label).length).toBeGreaterThanOrEqual(6);
    expect(rows.filter((r) => !r.label).length).toBeGreaterThanOrEqual(5);
  });

  it("recovers the hidden refund policy from order fields alone", () => {
    const tree = induceGuardTree(rows);
    const guard = toGuardExpr(tree);
    const text = guardToString(guard);

    expect(text).toContain("order.shipped_at.age_days > 30.5");
    expect(text).toContain('order.status == "delivered"');
    expect(text).toContain("order.total > 0.25");
  });

  it("classifies every training trace correctly (tree and DNF agree)", () => {
    const tree = induceGuardTree(rows);
    const guard = toGuardExpr(tree);
    for (const row of rows) {
      expect(predict(tree, row.features)).toBe(row.label);
      expect(evalGuard(guard, row.features)).toBe(row.label);
    }
  });

  it("derives date features relative to the trace run date", () => {
    const withAge = rows.filter((r) => r.features.has("order.shipped_at.age_days"));
    expect(withAge.length).toBe(rows.length);
  });
});
