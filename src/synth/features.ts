/** Feature extraction: flatten tool results into a feature map per trace.
 *
 * - numeric/boolean/short-string result fields become features keyed
 *   `<binding>.<field>`
 * - ISO date strings additionally derive `<key>.age_days` relative to the
 *   trace's run date
 * - identifier fields (`id`, `*_id`) are excluded: identifiers are
 *   references, not conditions
 */

import type { Trace, ToolEvent } from "../trace/types.js";

export type FeatureValue = number | boolean | string;
export type Features = Map<string, FeatureValue>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** Default binding names for common tool-name shapes; fall back to tool name. */
export function bindingName(tool: string): string {
  const m = tool.match(/^(?:get|check|fetch|lookup)_(.+)$/);
  return m?.[1] ?? tool;
}

export interface FeatureOptions {
  /** Restrict features to these tools (canonical names). */
  tools?: string[];
  /** Tools whose results are actions, never guard inputs. */
  actionTools?: Set<string>;
}

/** Incremental feature accumulation — shared by whole-trace extraction
 * (synthesis) and step-by-step evaluation (check now, gate later, where
 * guards must be judged on exactly the state visible at action time). */
export class FeatureAccumulator {
  readonly features: Features = new Map();

  constructor(
    private readonly runDate: Date,
    private readonly opts: FeatureOptions = {},
  ) {}

  add(e: ToolEvent): void {
    if (e.result === undefined || typeof e.result !== "object" || e.result === null) return;
    if (this.opts.actionTools?.has(e.tool)) return;
    if (this.opts.tools && !this.opts.tools.includes(e.tool)) return;
    const record = e.result as Record<string, unknown>;
    if (e.isError || "error" in record) return; // error payloads are not state
    const prefix = bindingName(e.tool);
    for (const [k, v] of Object.entries(record)) {
      if (k === "id" || k.endsWith("_id")) continue;
      const key = `${prefix}.${k}`;
      // Latest-wins: state is the most recent observation. (Induction is
      // unaffected — it slices events at action time before extraction —
      // and the live gate NEEDS this: an agent that pivots to a different
      // order must be judged on that order's fresh results, not stale ones.)
      if (typeof v === "number" || typeof v === "boolean") {
        this.features.set(key, v);
      } else if (typeof v === "string") {
        if (DATE_RE.test(v)) {
          const d = new Date(`${v}T00:00:00Z`);
          this.features.set(
            `${key}.age_days`,
            Math.floor((this.runDate.getTime() - d.getTime()) / MS_PER_DAY),
          );
        } else if (v.length <= 32) {
          this.features.set(key, v);
        }
      }
    }
  }
}

export function extractFeatures(trace: Trace, opts: FeatureOptions = {}): Features {
  const acc = new FeatureAccumulator(trace.runDate, opts);
  for (const e of trace.events) acc.add(e);
  return acc.features;
}
