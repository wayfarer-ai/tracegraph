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
import { diffSpecs, renderDiff } from "./diff/index.js";
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
  .description("Diff two specs: structure, guard clauses, and decision agreement on sample traces")
  .argument("<old-spec>", "baseline spec")
  .argument("<new-spec>", "candidate spec")
  .option("-t, --traces <dir>", "sample traces for decision-agreement analysis")
  .option("--json <file>", "write full diff as JSON")
  .action((oldPath: string, newPath: string, opts: { traces?: string; json?: string }) => {
    const a = loadSpec(oldPath);
    const b = loadSpec(newPath);
    const samples = opts.traces ? loadTraces(opts.traces) : undefined;
    const d = diffSpecs(a, b, samples);
    process.stdout.write(renderDiff(d));
    if (opts.json) writeFileSync(opts.json, JSON.stringify(d, null, 2));
    process.exit(d.identical ? 0 : 1);
  });

program
  .command("gate")
  .description("Run the MCP gate proxy: judge every tool call against a spec before forwarding")
  .requiredOption("-s, --spec <file>", "spec to enforce")
  .option("-r, --rules <file>", "invariants rules file")
  .option("-m, --mode <mode>", "shadow (log only) or block", "shadow")
  .option("--target-url <url>", "target MCP server URL (streamable-http)")
  .option("--target-cmd <cmd...>", "target MCP server command (stdio)")
  .option("--log <file>", "decision log (JSONL)", "tracegraph-gate.jsonl")
  .action(
    async (opts: {
      spec: string;
      rules?: string;
      mode: string;
      targetUrl?: string;
      targetCmd?: string[];
      log: string;
    }) => {
      if (!opts.targetUrl && !opts.targetCmd?.length) {
        process.stderr.write("gate: provide --target-url or --target-cmd\n");
        process.exit(1);
      }
      if (opts.mode !== "shadow" && opts.mode !== "block") {
        process.stderr.write(`gate: unknown mode "${opts.mode}" (shadow|block)\n`);
        process.exit(1);
      }
      const { GateProxy } = await import("./gate/proxy.js");
      const { StdioServerTransport } = await import(
        "@modelcontextprotocol/sdk/server/stdio.js"
      );

      let targetTransport;
      if (opts.targetUrl) {
        const { StreamableHTTPClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        targetTransport = new StreamableHTTPClientTransport(new URL(opts.targetUrl));
      } else {
        const { StdioClientTransport } = await import(
          "@modelcontextprotocol/sdk/client/stdio.js"
        );
        const [command, ...args] = opts.targetCmd!;
        targetTransport = new StdioClientTransport({ command: command!, args });
      }

      const proxy = new GateProxy({
        spec: loadSpec(opts.spec),
        rules: opts.rules ? loadRules(opts.rules) : [],
        mode: opts.mode,
        logPath: opts.log,
        onDecision: (d) => {
          if (d.action !== "allow") {
            process.stderr.write(
              `[gate] ${d.action} ${d.tool}: ${d.violations.join("; ")}\n`,
            );
          }
        },
      });
      // Agent side is stdio: point the agent's MCP config at this command.
      await proxy.connect(new StdioServerTransport(), targetTransport);
      process.stderr.write(
        `[gate] ${opts.mode} mode · spec ${opts.spec} · log ${opts.log}\n`,
      );
    },
  );

program
  .command("whatif")
  .description("(experimental) Mutate a spec and replay decisions over recorded traces")
  .argument("<spec>", "baseline spec")
  .requiredOption("-t, --traces <dir>", "traces to replay decisions over")
  .option("--set-threshold <feature=value>", "move a numeric guard threshold")
  .option("--force-gate", "remove the gate guard entirely")
  .option("--set-feature <feature=value>", "inject a mutated observation everywhere")
  .action(
    async (
      specPath: string,
      opts: {
        traces: string;
        setThreshold?: string;
        forceGate?: boolean;
        setFeature?: string;
      },
    ) => {
      const { whatIf, renderWhatIf } = await import("./whatif/index.js");
      const spec = loadSpec(specPath);
      const traces = loadTraces(opts.traces);

      const parseKV = (s: string): { feature: string; value: string | number | boolean } => {
        const i = s.indexOf("=");
        if (i < 0) throw new Error(`expected feature=value, got "${s}"`);
        const feature = s.slice(0, i);
        const raw = s.slice(i + 1);
        const value =
          raw === "true" ? true : raw === "false" ? false :
          Number.isNaN(Number(raw)) ? raw : Number(raw);
        return { feature, value };
      };

      const mutations = [];
      if (opts.setThreshold) {
        const { feature, value } = parseKV(opts.setThreshold);
        mutations.push({ kind: "set-threshold" as const, feature, value: value as number });
      }
      if (opts.forceGate) mutations.push({ kind: "force-gate" as const });
      if (opts.setFeature) {
        const { feature, value } = parseKV(opts.setFeature);
        mutations.push({ kind: "set-feature" as const, feature, value });
      }
      if (mutations.length === 0) {
        process.stderr.write("whatif: pass at least one mutation flag\n");
        process.exit(1);
      }
      for (const m of mutations) {
        process.stdout.write(renderWhatIf(whatIf(spec, traces, m)) + "\n");
      }
    },
  );

program.parse();
