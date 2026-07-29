#!/usr/bin/env node
/** tracegraph CLI — the graph your agent actually follows. */

import { Command } from "commander";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAtifTrace } from "./trace/atif.js";
import { loadStreamJsonTrace } from "./trace/stream-json.js";
import type { Trace } from "./trace/types.js";
import { synthesize } from "./synth/index.js";
import { clusterByVocabulary, describeClusters } from "./synth/cluster.js";
import { loadSpec, writeSpec } from "./spec/io.js";
import { checkTraces } from "./check/index.js";
import { loadRules } from "./check/rules.js";
import { guardToString, type SpecStep } from "./spec/types.js";

const program = new Command();

program
  .name("tracegraph")
  .description("Induce the graph your agent actually follows — then check, diff, and gate against it.")
  .version("0.0.1");

function loadTraces(dir: string): Trace[] {
  const traces: Trace[] = [];
  const root = resolve(dir);
  for (const f of readdirSync(root)) {
    const p = join(root, f);
    if (!statSync(p).isFile()) continue;
    try {
      if (f.endsWith(".jsonl")) traces.push(loadStreamJsonTrace(p));
      else if (f.endsWith(".json") && f !== "manifest.json") traces.push(loadAtifTrace(p));
    } catch (e) {
      process.stderr.write(`warning: skipping ${f}: ${(e as Error).message}\n`);
    }
  }
  return traces;
}

function renderSteps(steps: SpecStep[], indent = ""): string {
  const lines: string[] = [];
  for (const s of steps) {
    if (s.kind === "call") {
      const load = s.loadBearing === false ? "  (not load-bearing)" : "";
      lines.push(`${indent}→ ${s.tool}(${Object.keys(s.args).join(", ")}) as ${s.as}${load}`);
    } else {
      lines.push(`${indent}◇ gate: ${guardToString(s.guard)}`);
      lines.push(renderSteps(s.then, indent + "    "));
      if (s.else?.length) {
        lines.push(`${indent}  else:`);
        lines.push(renderSteps(s.else, indent + "    "));
      }
    }
  }
  return lines.join("\n");
}

program
  .command("synthesize")
  .description("Induce a spec from a directory of traces (ATIF .json or claude stream .jsonl)")
  .argument("<traces-dir>", "directory containing trace files")
  .option("-o, --out <file>", "output spec path", "tracegraph.spec.yaml")
  .option("-n, --name <name>", "spec name", "agent-spec")
  .option("-a, --action <tool>", "the consequential action tool (auto-detected if omitted)")
  .action((dir: string, opts: { out: string; name: string; action?: string }) => {
    let traces = loadTraces(dir);
    if (traces.length === 0) {
      process.stderr.write("no traces found (expected ATIF .json or stream .jsonl files)\n");
      process.exit(1);
    }
    const clusters = clusterByVocabulary(traces);
    if (clusters.length > 1) {
      process.stderr.write(
        `warning: found ${clusters.length} distinct trace populations (different tool vocabularies):\n` +
          describeClusters(clusters) +
          `\nsynthesizing from the largest cluster only — split the directory to synthesize the others\n\n`,
      );
      traces = clusters[0]!;
    }
    const result = synthesize(traces, { name: opts.name, actionTool: opts.action });
    writeSpec(opts.out, result.spec);

    process.stdout.write(
      `\n${result.spec.name} — induced from ${traces.length} traces\n` +
        `action: ${result.actionTool} · ${result.positives} took it, ${result.negatives} did not\n` +
        `training agreement: ${(result.trainingAgreement * 100).toFixed(1)}%\n\n` +
        renderSteps(result.spec.steps) +
        `\n\nspec written to ${opts.out}\n`,
    );
  });

program
  .command("check")
  .description("Check traces against a spec: gate conformance + invariant rules")
  .argument("<traces-dir>", "directory containing trace files")
  .requiredOption("-s, --spec <file>", "spec to check against")
  .option("-r, --rules <file>", "invariants rules file")
  .option("--json <file>", "write full report as JSON")
  .action(
    (dir: string, opts: { spec: string; rules?: string; json?: string }) => {
      const traces = loadTraces(dir);
      if (traces.length === 0) {
        process.stderr.write("no traces found\n");
        process.exit(1);
      }
      const spec = loadSpec(opts.spec);
      const rules = opts.rules ? loadRules(opts.rules) : [];
      const report = checkTraces(traces, spec, rules);

      for (const r of report.results) {
        for (const f of r.findings) {
          const mark = f.level === "deviation" ? "✗" : "·";
          process.stdout.write(`${mark} ${r.traceId}: ${f.message}\n`);
        }
      }
      process.stdout.write(
        `\n${report.conformant}/${report.traces} traces conformant · ` +
          `${report.deviations} deviation(s) · spec: ${report.spec}\n`,
      );
      if (opts.json) {
        writeFileSync(opts.json, JSON.stringify(report, null, 2));
      }
      process.exit(report.deviations > 0 ? 1 : 0);
    },
  );

program
  .command("diff")
  .description("Diff two specs — coming in this release cycle")
  .action(() => {
    process.stderr.write("tracegraph diff: not yet implemented (roadmap: week 1, day 4)\n");
    process.exit(2);
  });

program
  .command("gate")
  .description("Run the local MCP gate proxy — coming in this release cycle")
  .action(() => {
    process.stderr.write("tracegraph gate: not yet implemented (roadmap: week 2)\n");
    process.exit(2);
  });

program.parse();
