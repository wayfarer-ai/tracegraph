#!/usr/bin/env node
/** tracegraph CLI — the graph your agent actually follows. */

import { Command } from "commander";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAtifTrace } from "./trace/atif.js";
import { loadStreamJsonTrace } from "./trace/stream-json.js";
import { splitEpisodes } from "./trace/episodes.js";
import { loadOtlpTraces, looksLikeOtlp } from "./trace/otlp.js";
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

function loadTraces(dir: string, episodes = false): Trace[] {
  let traces: Trace[] = [];
  const root = resolve(dir);
  for (const f of readdirSync(root)) {
    const p = join(root, f);
    if (!statSync(p).isFile()) continue;
    try {
      if (f.endsWith(".jsonl")) traces.push(loadStreamJsonTrace(p));
      else if (f.endsWith(".json") && f !== "manifest.json") {
        if (looksLikeOtlp(p)) traces.push(...loadOtlpTraces(p));
        else traces.push(loadAtifTrace(p));
      }
    } catch (e) {
      process.stderr.write(`warning: skipping ${f}: ${(e as Error).message}\n`);
    }
  }
  if (episodes) {
    traces = traces.flatMap((t) => splitEpisodes(t));
  }
  const empty = traces.filter((t) => t.events.length === 0).length;
  if (empty > 0) {
    process.stderr.write(
      `note: skipped ${empty} trace(s) with no tool calls (plain conversations)\n`,
    );
  }
  return traces.filter((t) => t.events.length > 0);
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
  .option("-e, --episodes", "split interactive sessions into task episodes at user messages")
  .action((dir: string, opts: { out: string; name: string; action?: string; episodes?: boolean }) => {
    let traces = loadTraces(dir, opts.episodes);
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

    // Shape check: a spec is only meaningful over REPEATED runs of one
    // task. Few, huge, weakly-separable traces are almost certainly
    // multi-task interactive sessions — say so instead of shipping noise.
    const meanEvents = traces.reduce((n, t) => n + t.events.length, 0) / traces.length;
    const sessionShaped =
      (traces.length < 5 && meanEvents > 200) || result.trainingAgreement < 0.7;
    if (sessionShaped && !opts.action) {
      const census = new Map<string, number>();
      for (const t of traces) {
        for (const e of t.events) census.set(e.tool, (census.get(e.tool) ?? 0) + 1);
      }
      const top = [...census.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
      process.stdout.write(
        `\nthese traces look like long multi-task sessions ` +
          `(${traces.length} trace(s), ~${Math.round(meanEvents)} tool calls each, ` +
          `guard agreement ${(result.trainingAgreement * 100).toFixed(0)}%).\n` +
          `a spec needs repeated runs of a single task — capture per-task traces ` +
          `(e.g. one \`claude -p ... --output-format stream-json\` file per run).\n\n` +
          `tool census across these sessions:\n` +
          top.map(([t, n]) => `  ${String(n).padStart(5)}  ${t}`).join("\n") +
          `\n\nno spec written. Pass --action <tool> to force synthesis anyway.\n`,
      );
      process.exit(2);
    }

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

program
  .command("probe")
  .description("(experimental) Read the guard's uncertainty and propose the inputs to test next")
  .argument("<spec>", "spec to analyze")
  .requiredOption("-t, --traces <dir>", "the traces the spec was induced from")
  .option("--json <file>", "write full report as JSON")
  .action(async (specPath: string, opts: { traces: string; json?: string }) => {
    const { probe, renderProbe } = await import("./probe/index.js");
    const report = probe(loadSpec(specPath), loadTraces(opts.traces));
    process.stdout.write(renderProbe(report));
    if (opts.json) writeFileSync(opts.json, JSON.stringify(report, null, 2));
  });

program
  .command("census")
  .description("Behavior map for trace populations: tool counts, MCP share, dominant sequences")
  .argument("<traces-dir>", "directory containing trace files")
  .option("-e, --episodes", "split interactive sessions into task episodes at user messages")
  .option("--json <file>", "write full census as JSON")
  .action(async (dir: string, opts: { episodes?: boolean; json?: string }) => {
    const { census, renderCensus } = await import("./census/index.js");
    const traces = loadTraces(dir, opts.episodes);
    if (traces.length === 0) {
      process.stderr.write("no traces found\n");
      process.exit(1);
    }
    const report = census(traces);
    process.stdout.write(renderCensus(report));
    if (opts.json) writeFileSync(opts.json, JSON.stringify(report, null, 2));
  });

program.parseAsync().catch((e: Error) => {
  process.stderr.write(`tracegraph: ${e.message}\n`);
  process.exit(1);
});
