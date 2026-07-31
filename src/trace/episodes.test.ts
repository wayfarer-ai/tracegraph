import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadStreamJsonTrace, splitEpisodes } from "./stream-json.js";

function streamFile(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "tracegraph-ep-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return path;
}

const userText = (text: string) => ({
  type: "user",
  message: { content: [{ type: "text", text }] },
});
const toolUse = (id: string, name: string, input: object) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (id: string, content: string) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
});

describe("episode splitting of interactive sessions", () => {
  it("splits at real user messages, not at tool results", () => {
    const path = streamFile([
      userText("fix the login bug"),
      toolUse("a", "Read", { file_path: "auth.ts" }),
      toolResult("a", "..."),
      toolUse("b", "Edit", { file_path: "auth.ts" }),
      toolResult("b", "ok"),
      userText("now add a test for it"),
      toolUse("c", "Write", { file_path: "auth.test.ts" }),
      toolResult("c", "ok"),
      userText("thanks, also bump the version"),
      toolUse("d", "Edit", { file_path: "package.json" }),
      toolResult("d", "ok"),
    ]);
    const session = loadStreamJsonTrace(path);
    expect(session.events.length).toBe(4);

    const episodes = splitEpisodes(session);
    expect(episodes.length).toBe(3);
    expect(episodes.map((e) => e.events.map((x) => x.tool))).toEqual([
      ["Read", "Edit"],
      ["Write"],
      ["Edit"],
    ]);
    expect(episodes[0]!.id).toContain("#e1");
    expect(episodes[1]!.meta["episodeOf"]).toBe(session.id);
  });

  it("a leading user message opens episode 1 without an empty prefix episode", () => {
    const path = streamFile([
      userText("do the thing"),
      toolUse("a", "Bash", { command: "ls" }),
      toolResult("a", "files"),
    ]);
    const episodes = splitEpisodes(loadStreamJsonTrace(path));
    expect(episodes.length).toBe(1);
    expect(episodes[0]!.events.length).toBe(1);
  });

  it("single-task traces pass through unchanged", () => {
    const path = streamFile([
      toolUse("a", "get_order", { order_id: "X" }),
      toolResult("a", '{"total": 5}'),
    ]);
    const t = loadStreamJsonTrace(path);
    const episodes = splitEpisodes(t);
    expect(episodes.length).toBe(1);
    expect(episodes[0]!.id).toBe(t.id);
  });
});
