/** Guard induction: a small decision-tree learner over trace features.
 *
 * Numeric features get midpoint-threshold splits, categorical/boolean get
 * equality splits. Gini impurity, greedy, bounded depth. Output is the DNF
 * of paths that reach a positive leaf — directly a spec GuardExpr.
 */

import type { Features, FeatureValue } from "./features.js";
import type { GuardClause, GuardExpr } from "../spec/types.js";

export interface LabeledRow {
  features: Features;
  label: boolean;
}

interface Split {
  feature: string;
  op: ">" | "==";
  value: FeatureValue;
}

function testSplit(s: Split, f: Features): boolean | undefined {
  const v = f.get(s.feature);
  if (v === undefined) return undefined;
  if (s.op === ">") return typeof v === "number" && v > (s.value as number);
  return v === s.value;
}

function gini(labels: boolean[]): number {
  if (labels.length === 0) return 0;
  const p = labels.filter(Boolean).length / labels.length;
  return 2 * p * (1 - p);
}

function bestSplit(rows: LabeledRow[]): Split | undefined {
  const keys = new Set<string>();
  for (const r of rows) for (const k of r.features.keys()) keys.add(k);

  const base = gini(rows.map((r) => r.label));
  let best: Split | undefined;
  let bestScore = base - 1e-9;

  for (const key of [...keys].sort()) {
    const values = rows
      .map((r) => r.features.get(key))
      .filter((v): v is FeatureValue => v !== undefined);
    const nums = [...new Set(values.filter((v): v is number => typeof v === "number"))].sort(
      (a, b) => a - b,
    );
    const cats = [...new Set(values.filter((v) => typeof v === "string" || typeof v === "boolean"))];

    const candidates: Split[] = [];
    for (let i = 0; i + 1 < nums.length; i++) {
      candidates.push({ feature: key, op: ">", value: (nums[i]! + nums[i + 1]!) / 2 });
    }
    for (const c of cats) candidates.push({ feature: key, op: "==", value: c });

    for (const s of candidates) {
      const yes = rows.filter((r) => testSplit(s, r.features) === true).map((r) => r.label);
      const no = rows.filter((r) => testSplit(s, r.features) === false).map((r) => r.label);
      if (yes.length === 0 || no.length === 0) continue;
      const score = (yes.length * gini(yes) + no.length * gini(no)) / rows.length;
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
  }
  return best;
}

export interface GuardTree {
  split?: Split;
  yes?: GuardTree;
  no?: GuardTree;
  label: boolean;
}

export function induceGuardTree(rows: LabeledRow[], depth = 3): GuardTree {
  const labels = rows.map((r) => r.label);
  const majority = labels.filter(Boolean).length * 2 >= labels.length;
  if (depth === 0 || new Set(labels).size <= 1) return { label: majority };
  const split = bestSplit(rows);
  if (!split) return { label: majority };
  return {
    split,
    yes: induceGuardTree(rows.filter((r) => testSplit(split, r.features) === true), depth - 1),
    no: induceGuardTree(rows.filter((r) => testSplit(split, r.features) === false), depth - 1),
    label: majority,
  };
}

export function predict(tree: GuardTree, f: Features): boolean {
  if (!tree.split) return tree.label;
  const branch = testSplit(tree.split, f) ? tree.yes : tree.no;
  return branch ? predict(branch, f) : tree.label;
}

function negate(s: Split): GuardClause {
  return s.op === ">"
    ? { feature: s.feature, op: "<=", value: s.value as number }
    : { feature: s.feature, op: "!=", value: s.value };
}

/** DNF of every root-to-leaf path ending in a positive leaf. */
export function toGuardExpr(tree: GuardTree): GuardExpr {
  const paths: GuardClause[][] = [];
  const walk = (node: GuardTree, conds: GuardClause[]) => {
    if (!node.split) {
      if (node.label) paths.push(conds);
      return;
    }
    const clause: GuardClause = {
      feature: node.split.feature,
      op: node.split.op,
      value: node.split.value,
    };
    if (node.yes) walk(node.yes, [...conds, clause]);
    if (node.no) walk(node.no, [...conds, negate(node.split)]);
  };
  walk(tree, []);
  return paths;
}

export function evalGuard(guard: GuardExpr, f: Features): boolean {
  if (guard.length === 0) return false;
  return guard.some((and) =>
    and.every((c) => {
      const v = f.get(c.feature);
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
    }),
  );
}
