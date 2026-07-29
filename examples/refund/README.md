# Refund example — the full loop, no API key required

Everything here runs offline: the traces are real (captured from live
`claude -p` agents against a deterministic refund backend), the MCP server
is a tiny local Node process, and the "bad agent" reenacts a genuine
captured failure.

```bash
# from the repo root, after: npm install && npm run build

# 1. induce the spec from 16 bundled real traces
node dist/cli.js synthesize examples/refund/traces -o examples/refund/refund.spec.yaml

# 2. check the traces against it — all conformant
node dist/cli.js check examples/refund/traces --spec examples/refund/refund.spec.yaml

# 3. start the refund backend (deliberately NO guardrail in issue_refund)
node examples/refund/server.mjs &

# 4. watch the gate block the reenacted real failure
node examples/refund/bad-agent.mjs

# 5. same thing in shadow mode: forwarded, but logged
MODE=shadow node examples/refund/bad-agent.mjs
cat examples/refund/gate-demo.jsonl
```

To gate a real agent instead, point its MCP config at the proxy — e.g. for
Claude Code:

```json
{
  "mcpServers": {
    "refund-tools": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "tracegraph", "gate",
        "--spec", "examples/refund/refund.spec.yaml",
        "--mode", "block",
        "--target-url", "http://127.0.0.1:8321/mcp"
      ]
    }
  }
}
```

The backend's `GET /state` endpoint shows issued refunds — useful for
verifying that a blocked call really never executed.
