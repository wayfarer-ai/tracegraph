/** CLI integration tests — the behaviors dogfooding taught us, locked in.
 *
 * These run the built `dist/cli.js` as a subprocess, so they cover the
 * paths users actually hit first: trace loading across formats, population
 * clustering, session-shape refusal, episode granularity, and exit codes.
 * Skipped (not failed) when dist/ hasn't been built yet.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "cli.js");
const REFUND = join(ROOT, "examples", "refund", "traces");
const built = existsSync(CLI);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(...args: string[]): RunResult {
  // spawnSync, not execFileSync: warnings on stderr matter even when the
  // command succeeds (execFileSync only surfaces stderr by throwing).
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "tracegraph-cli-"));
}

/** A minimal single-task stream-json trace: look up, check, maybe act. */
function taskTrace(dir: string, name: string, opts: { eligible: boolean; act: boolean }) {
  const lines: object[] = [
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "1", name: "get_item", input: { id: name } }],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "1",
            content: JSON.stringify({ id: name, score: opts.eligible ? 90 : 10 }),
          },
        ],
      },
    },
  ];
  if (opts.act) {
    lines.push({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "2", name: "approve", input: { id: name } }],
      },
    });
    lines.push({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "2", content: JSON.stringify({ ok: true }) },
        ],
      },
    });
  }
  writeFileSync(join(dir, `${name}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
}

describe.skipIf(!built)("CLI: core flow on a synthetic single-task corpus", () => {
  const dir = tmp();
  for (const i of [1, 2, 3]) taskTrace(dir, `hi${i}`, { eligible: true, act: true });
  for (const i of [1, 2, 3]) taskTrace(dir, `lo${i}`, { eligible: false, act: false });
  const spec = join(dir, "spec.yaml");

  it("synthesizes a spec, auto-detecting the action", () => {
    const r = run("synthesize", dir, "--name", "demo", "-o", spec);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("action: approve");
    expect(r.stdout).toContain("gate:");
    expect(existsSync(spec)).toBe(true);
  });

  it("check exits 0 when every trace conforms", () => {
    const r = run("check", dir, "--spec", spec);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("6/6 traces conformant");
  });

  it("check exits 1 and names the deviant trace", () => {
    const bad = tmp();
    taskTrace(bad, "sneaky", { eligible: false, act: true }); // acts despite low score
    const r = run("check", bad, "--spec", spec);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("sneaky");
    expect(r.stdout).toContain("deviation");
  });
});

describe.skipIf(!built)("CLI: dogfood-driven guardrails", () => {
  it("refuses to emit a spec for session-shaped traces, printing a census", () => {
    const dir = tmp();
    // Two long multi-tool traces = interactive sessions, not task runs.
    for (const n of ["s1", "s2"]) {
      const lines: object[] = [];
      for (let i = 0; i < 220; i++) {
        // s2 alone touches Write, so action detection finds a candidate and
        // the SHAPE heuristic is what refuses — not the no-action error.
        const tool = i === 5 && n === "s2" ? "Write" : i % 3 ? "Bash" : "Read";
        lines.push({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: `${i}`, name: tool, input: {} }],
          },
        });
        lines.push({
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: `${i}`, content: "ok" }],
          },
        });
      }
      writeFileSync(join(dir, `${n}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
    }
    const r = run("synthesize", dir, "-o", join(dir, "out.yaml"));
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("long multi-task sessions");
    expect(r.stdout).toContain("tool census");
    expect(existsSync(join(dir, "out.yaml"))).toBe(false);
  });

  it("warns when check granularity does not match how the spec was induced", () => {
    const dir = tmp();
    for (const i of [1, 2, 3]) taskTrace(dir, `hi${i}`, { eligible: true, act: true });
    for (const i of [1, 2, 3]) taskTrace(dir, `lo${i}`, { eligible: false, act: false });
    const spec = join(dir, "s.yaml");
    run("synthesize", dir, "-o", spec);
    const r = run("check", dir, "--spec", spec, "--episodes");
    expect(r.stderr).toContain("induced WITHOUT --episodes");
    expect(r.stderr).toContain("drop the flag");
  });

  it("skips conversation-only traces instead of polluting the corpus", () => {
    const dir = tmp();
    taskTrace(dir, "real", { eligible: true, act: true });
    writeFileSync(
      join(dir, "chat.jsonl"),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
    );
    const r = run("census", dir);
    expect(r.stderr).toContain("skipped 1 trace(s) with no tool calls");
    expect(r.stdout).toContain("census: 1 trace(s)");
  });

  it("warns about mixed tool vocabularies rather than averaging them", () => {
    const dir = tmp();
    for (const i of [1, 2, 3]) taskTrace(dir, `hi${i}`, { eligible: true, act: true });
    for (const i of [1, 2, 3]) taskTrace(dir, `lo${i}`, { eligible: false, act: false });
    // A wholly different dialect in the same directory.
    writeFileSync(
      join(dir, "other.jsonl"),
      [
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "1", name: "zzz_alpha", input: {} }] },
        },
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "1", content: "{}" }] },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );
    const r = run("synthesize", dir, "-o", join(dir, "o.yaml"));
    expect(r.stderr).toContain("distinct trace populations");
  });

  it("reports a clean one-line error for a malformed spec", () => {
    const dir = tmp();
    taskTrace(dir, "t", { eligible: true, act: true });
    const bad = join(dir, "bad.yaml");
    writeFileSync(bad, "not: a spec\n");
    const r = run("check", dir, "--spec", bad);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("tracegraph:");
    expect(r.stderr).not.toContain("at Object."); // no stack trace
  });
});

describe.skipIf(!built)("CLI: bundled example still works end to end", () => {
  it("synthesize → check on examples/refund/traces", () => {
    const dir = tmp();
    const spec = join(dir, "refund.spec.yaml");
    const s = run("synthesize", REFUND, "--name", "refund", "-o", spec);
    expect(s.code).toBe(0);
    const c = run("check", REFUND, "--spec", spec);
    expect(c.code).toBe(0);
    expect(c.stdout).toContain("16/16 traces conformant");
  });

  it("census surfaces per-tool counts for the same corpus", () => {
    const r = run("census", REFUND);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("issue_refund");
    expect(r.stdout).toContain("dominant sequences");
  });
});

describe.skipIf(!built)("CLI: episode splitting through the CLI", () => {
  it("--episodes turns one session into several task traces", () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    const lines: object[] = [];
    for (const task of ["a", "b", "c"]) {
      lines.push({ type: "user", message: { content: [{ type: "text", text: `task ${task}` }] } });
      lines.push({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: task, name: "get_item", input: { id: task } }],
        },
      });
      lines.push({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: task, content: JSON.stringify({ score: 1 }) },
          ],
        },
      });
    }
    writeFileSync(join(dir, "session.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));

    const whole = run("census", dir);
    expect(whole.stdout).toContain("census: 1 trace(s)");
    const split = run("census", dir, "--episodes");
    expect(split.stdout).toContain("census: 3 trace(s)");
  });
});
