/** Invariant rules file loader (invariants.yaml).
 *
 * rules:
 *   - action: issue_refund
 *     requires_prior: check_refund_policy
 *     description: never refund without checking policy
 *   - action: issue_refund
 *     requires_guard:
 *       - - feature: refund_policy.eligible
 *           op: "=="
 *           value: true
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { GuardExpr, InvariantRule } from "../spec/types.js";

export class RulesParseError extends Error {}

const OPS = new Set([">", "<=", "==", "!="]);

function validateGuard(g: unknown, path: string): asserts g is GuardExpr {
  if (!Array.isArray(g)) throw new RulesParseError(`${path}: guard must be an array of clause groups`);
  for (const [i, and] of g.entries()) {
    if (!Array.isArray(and)) throw new RulesParseError(`${path}[${i}]: must be an array of clauses`);
    for (const [j, c] of and.entries()) {
      const clause = c as Record<string, unknown>;
      if (typeof clause["feature"] !== "string" || !OPS.has(clause["op"] as string)) {
        throw new RulesParseError(
          `${path}[${i}][${j}]: clause needs "feature" and op one of > <= == !=`,
        );
      }
    }
  }
}

export function loadRules(path: string): InvariantRule[] {
  const raw = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const rules = raw?.["rules"];
  if (!Array.isArray(rules)) {
    throw new RulesParseError(`${path}: expected a top-level "rules" array`);
  }
  return rules.map((r, i) => {
    const rule = r as Record<string, unknown>;
    if (typeof rule["action"] !== "string") {
      throw new RulesParseError(`${path}: rules[${i}] missing "action"`);
    }
    const out: InvariantRule = { action: rule["action"] };
    if (rule["requires_prior"] !== undefined) {
      if (typeof rule["requires_prior"] !== "string") {
        throw new RulesParseError(`${path}: rules[${i}].requires_prior must be a tool name`);
      }
      out.requiresPrior = rule["requires_prior"];
    }
    if (rule["requires_guard"] !== undefined) {
      validateGuard(rule["requires_guard"], `${path}: rules[${i}].requires_guard`);
      out.requiresGuard = rule["requires_guard"];
    }
    if (typeof rule["description"] === "string") out.description = rule["description"];
    return out;
  });
}
