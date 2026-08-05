import { describe, expect, it } from "vitest";
import { explainGuardFailure } from "./explain.js";
import type { Features } from "../synth/features.js";
import type { GuardExpr } from "./types.js";

const feats = (o: Record<string, string | number | boolean>): Features =>
  new Map(Object.entries(o));

describe("guard failure explanations", () => {
  const guard: GuardExpr = [
    [
      { feature: "order.age_days", op: ">", value: 30 },
      { feature: "order.status", op: "==", value: "delivered" },
    ],
  ];

  it("names the failing clause with its actual value", () => {
    const why = explainGuardFailure(guard, feats({ "order.age_days": 12, "order.status": "delivered" }));
    expect(why).toBe("actual: order.age_days=12");
  });

  it("says plainly when a feature was never observed", () => {
    const why = explainGuardFailure(guard, feats({ "order.status": "delivered" }));
    expect(why).toBe("actual: order.age_days was never observed");
  });

  it("lists every failing clause of the closest branch", () => {
    const why = explainGuardFailure(guard, feats({ "order.age_days": 5, "order.status": "in_transit" }));
    expect(why).toContain("order.age_days=5");
    expect(why).toContain('order.status="in_transit"');
  });

  it("reports the nearest-miss branch for a DNF guard", () => {
    const dnf: GuardExpr = [
      [{ feature: "a", op: ">", value: 10 }],
      [
        { feature: "b", op: ">", value: 1 },
        { feature: "c", op: "==", value: true },
      ],
    ];
    // branch 1 fails on one clause, branch 2 on two — report branch 1.
    const why = explainGuardFailure(dnf, feats({ a: 3, b: 0, c: false }));
    expect(why).toBe("actual: a=3");
  });

  it("returns empty when the guard actually holds", () => {
    expect(
      explainGuardFailure(guard, feats({ "order.age_days": 40, "order.status": "delivered" })),
    ).toBe("");
  });
});
