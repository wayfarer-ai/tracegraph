/** Explain WHY a guard failed, in terms of the state at that moment.
 *
 * Dogfood gap: "gate guard did not hold: (policy.max_amount > 0.25)" tells
 * you the rule but not the reality. Debugging a deviation means knowing
 * what the value actually was — or that it was never observed at all.
 */

import type { GuardClause, GuardExpr } from "./types.js";
import type { Features, FeatureValue } from "../synth/features.js";

function clauseHolds(c: GuardClause, v: FeatureValue | undefined): boolean {
  if (v === undefined) return false;
  switch (c.op) {
    case ">":
      return typeof v === "number" && v > (c.value as number);
    case "<=":
      return typeof v === "number" && v <= (c.value as number);
    case "==":
      return v === c.value;
    case "!=":
      return v !== c.value;
  }
}

/** Short account of the failing clauses in the AND-group that came
 * closest to holding (fewest failures) — the most useful one to report. */
export function explainGuardFailure(guard: GuardExpr, features: Features): string {
  if (guard.length === 0) return "guard is unsatisfiable (no clauses)";

  let best: { failures: GuardClause[] } | undefined;
  for (const and of guard) {
    const failures = and.filter((c) => !clauseHolds(c, features.get(c.feature)));
    if (!best || failures.length < best.failures.length) best = { failures };
  }
  if (!best || best.failures.length === 0) return "";

  const parts = best.failures.map((c) => {
    const v = features.get(c.feature);
    return v === undefined
      ? `${c.feature} was never observed`
      : `${c.feature}=${JSON.stringify(v)}`;
  });
  return `actual: ${parts.join(", ")}`;
}
