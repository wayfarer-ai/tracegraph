# Triage example — a second domain, a different rule shape

The refund example's hidden rule is a conjunction (`delivered AND age > 30`).
This domain is deliberately harder: **the SLA threshold depends on the
priority** — urgent 4h, high 8h, normal 24h, low 72h — a categorical ×
numeric interaction. The bundled traces are real (`claude -p` sonnet against
this server, one fresh server per trial).

```bash
# induce the spec from the bundled real traces
node ../../dist/cli.js synthesize traces -o triage.spec.yaml

# the shallow guard is the field the agent branches on: sla.breached == true
# the deep rule (per-priority thresholds) needs more induction depth —
# see src/synth tests for the guardScope + maxDepth variant

# run the server yourself and gate a live agent
node server.mjs &
node ../../dist/cli.js gate --spec triage.spec.yaml --mode shadow \
  --target-url http://127.0.0.1:8322/mcp
```

Same design rules as the refund example: `escalate_ticket` performs no
enforcement (the agent's decision is the observable), `get_queue_stats` is a
distractor, and `GET /state` exposes ground truth for verification.
