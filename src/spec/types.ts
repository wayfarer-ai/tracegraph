/**
 * The tracegraph spec — the graph your agent actually follows, as data.
 *
 * A spec is induced from traces (never hand-authored in the happy path) and
 * is consumed by `check` (deviation detection), `diff` (behavioral change),
 * and `gate` (runtime enforcement).
 */

/** A single comparison clause inside a guard, e.g. `order.total > 0.25`. */
export interface GuardClause {
  /** Dotted feature path into bound results, e.g. "order.status".
   * A trailing `.age_days` segment derives days-since-date at eval time. */
  feature: string;
  op: ">" | "<=" | "==" | "!=";
  value: string | number | boolean;
}

/** Disjunctive normal form: OR over AND-groups of clauses. */
export type GuardExpr = GuardClause[][];

export interface CallStep {
  kind: "call";
  /** Stable id within the spec. */
  id: string;
  /** Logical tool name (canonical, un-namespaced). */
  tool: string;
  /** MCP server name if known. */
  server?: string;
  /** Argument template; values are literals or `${binding.field}` refs. */
  args: Record<string, unknown>;
  /** Blackboard binding name for the result. */
  as: string;
  /** True when data-flow analysis found no downstream use of the result. */
  loadBearing?: boolean;
}

export interface GateStep {
  kind: "gate";
  id: string;
  /** The induced guard, in DNF. */
  guard: GuardExpr;
  /** Steps executed only when the guard holds. */
  then: SpecStep[];
  /** Steps executed when it does not (usually empty = skip). */
  else?: SpecStep[];
}

export type SpecStep = CallStep | GateStep;

export interface TraceGraphSpec {
  tracegraph: 1;
  name: string;
  /** Task-level inputs lifted from traces, e.g. { orderId: "..." }. */
  inputs: string[];
  steps: SpecStep[];
  /** Provenance: how this spec was induced. */
  induction: {
    traces: number;
    at: string;
    agreement?: number;
    tool?: string;
  };
}

/** Invariant rules checked by `check` and enforced by `gate`. */
export interface InvariantRule {
  /** e.g. "issue_refund" */
  action: string;
  /** Tool that must appear earlier in the same trace. */
  requiresPrior?: string;
  /** Guard that must hold on the blackboard when the action fires. */
  requiresGuard?: GuardExpr;
  description?: string;
}

export function clauseToString(c: GuardClause): string {
  return `${c.feature} ${c.op} ${JSON.stringify(c.value)}`;
}

export function guardToString(g: GuardExpr): string {
  if (g.length === 0) return "false";
  return g
    .map((and) => `(${and.map(clauseToString).join(" AND ")})`)
    .join(" OR ");
}
