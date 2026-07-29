/** Spec YAML serialization + parsing with validation. */

import { parse, stringify } from "yaml";
import { readFileSync, writeFileSync } from "node:fs";
import type { SpecStep, TraceGraphSpec } from "./types.js";

export function specToYaml(spec: TraceGraphSpec): string {
  return stringify(spec, { lineWidth: 100 });
}

export function writeSpec(path: string, spec: TraceGraphSpec): void {
  writeFileSync(path, specToYaml(spec));
}

export class SpecParseError extends Error {}

function validateSteps(steps: unknown, path: string): asserts steps is SpecStep[] {
  if (!Array.isArray(steps)) {
    throw new SpecParseError(`${path}: "steps" must be an array`);
  }
  for (const [i, s] of steps.entries()) {
    const step = s as Record<string, unknown>;
    if (step["kind"] === "call") {
      for (const field of ["id", "tool", "args", "as"]) {
        if (step[field] === undefined) {
          throw new SpecParseError(`${path}: steps[${i}] (call) missing "${field}"`);
        }
      }
    } else if (step["kind"] === "gate") {
      if (!Array.isArray(step["guard"])) {
        throw new SpecParseError(`${path}: steps[${i}] (gate) missing DNF "guard"`);
      }
      validateSteps(step["then"] ?? [], `${path}.steps[${i}].then`);
      if (step["else"] !== undefined) {
        validateSteps(step["else"], `${path}.steps[${i}].else`);
      }
    } else {
      throw new SpecParseError(
        `${path}: steps[${i}] has unknown kind "${String(step["kind"])}"`,
      );
    }
  }
}

export function loadSpec(path: string): TraceGraphSpec {
  const raw = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (raw?.["tracegraph"] !== 1) {
    throw new SpecParseError(
      `${path}: not a tracegraph spec (missing "tracegraph: 1" version marker)`,
    );
  }
  validateSteps(raw["steps"], path);
  return raw as unknown as TraceGraphSpec;
}
