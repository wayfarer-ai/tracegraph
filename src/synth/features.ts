/** Feature extraction: flatten tool results into a feature map per trace.
 *
 * - numeric/boolean/short-string result fields become features keyed
 *   `<binding>.<field>`
 * - ISO date strings additionally derive `<key>.age_days` relative to the
 *   trace's run date
 * - identifier fields (`id`, `*_id`) are excluded: identifiers are
 *   references, not conditions
 */

import type { Trace } from "../trace/types.js";

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

export function extractFeatures(trace: Trace, opts: FeatureOptions = {}): Features {
  const feats: Features = new Map();
  for (const e of trace.events) {
    if (e.result === undefined || typeof e.result !== "object" || e.result === null) continue;
    if (opts.actionTools?.has(e.tool)) continue;
    if (opts.tools && !opts.tools.includes(e.tool)) continue;
    const prefix = bindingName(e.tool);
    for (const [k, v] of Object.entries(e.result as Record<string, unknown>)) {
      if (k === "id" || k.endsWith("_id")) continue;
      const key = `${prefix}.${k}`;
      if (feats.has(key)) continue;
      if (typeof v === "number" || typeof v === "boolean") {
        feats.set(key, v);
      } else if (typeof v === "string") {
        if (DATE_RE.test(v)) {
          const d = new Date(`${v}T00:00:00Z`);
          feats.set(
            `${key}.age_days`,
            Math.floor((trace.runDate.getTime() - d.getTime()) / MS_PER_DAY),
          );
        } else if (v.length <= 32) {
          feats.set(key, v);
        }
      }
    }
  }
  return feats;
}
