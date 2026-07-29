# tracegraph

**The graph your agent actually follows.**

![tracegraph synthesize](docs/gifs/synthesize.gif)

You wrote a prompt. Maybe you even wrote an orchestration graph. But what
your agent *actually does* — which tools it calls, in what order, gated on
what conditions — exists only as a pile of traces nobody reads. tracegraph
induces that behavior into a **spec**: a reviewable, diffable, enforceable
document that lives in git next to your code.

```
$ tracegraph synthesize ./traces -o refund.spec.yaml

refund — induced from 101 traces
action: issue_refund · 45 took it, 56 did not
training agreement: 100.0%

→ get_order(order_id) as order
→ check_refund_policy(order_id) as refund_policy
→ get_customer(customer_id) as customer  (not load-bearing)
◇ gate: (refund_policy.max_amount > 0.25)
    → issue_refund(order_id, amount) as issue_refund
```

Four verbs, one spec:

| verb | question it answers |
|---|---|
| `synthesize` | *what does my agent actually do?* — traces in, spec out |
| `check` | *did it stay inside the lines?* — CI-ready, exit codes, invariant rules |
| `diff` | *what changed when I swapped the model/prompt?* — structure, thresholds, and decision agreement on real samples |
| `gate` | *block bad actions live* — an MCP proxy that judges every call against the spec before forwarding |

## Why this beats scripted checks

We watched a frontier model, confused by poorly-named tools, pass a
**customer id** where an order id belonged, get an error back from the
policy check, and **issue the refund anyway**. A hand-written trajectory
assertion ("was the policy checked before the refund?") *passed* that run —
a check did precede the refund; its answer was just never valid. The
induced spec caught it, because the spec knows what state the decision
requires, not just what order calls happen in. That trace ships in this
repo as a permanent test — and the gate blocks it live:

```
$ node examples/refund/server.mjs &          # tiny MCP refund backend
$ node examples/refund/bad-agent.mjs         # reenacts the real failure

→ get_order({"order_id":"ORD-1002"})
→ check_refund_policy({"order_id":"CUST-1004"})     ← the real captured mistake
[gate] block issue_refund: gate guard does not hold: (refund_policy.max_amount > 0.25)
✗ issue_refund — blocked. The tool never executed.
```

No LLM or API key needed for any of the above.

![gate blocking the reenacted failure](docs/gifs/gate-demo.gif)

## Quickstart (90 seconds)

```bash
npm install -g tracegraph        # or npx tracegraph ...

# 1. induce a spec from the bundled real traces
tracegraph synthesize examples/refund/traces -o refund.spec.yaml

# 2. check traces against it (add to CI: non-zero exit on deviation)
tracegraph check examples/refund/traces --spec refund.spec.yaml

# 3. see what a model swap changes
tracegraph diff old.spec.yaml new.spec.yaml --traces ./traces

# 4. gate your own agent: point its MCP config at the proxy
tracegraph gate --spec refund.spec.yaml --mode shadow \
  --target-url http://127.0.0.1:8321/mcp
```

Your own traces: point `synthesize` at Claude Code stream-json files
(`claude -p --output-format stream-json`) or ATIF trajectories (Harbor
agents emit these natively). OpenTelemetry GenAI ingestion is the next
loader — follow the pinned issue.

## How it works

The spec is a document, not a program — `synthesize` writes it, the other
verbs read it. Guards are induced decision-tree style from the state
visible *at the moment of action* and evaluated the same way at check and
gate time. Specs live in git; the gate writes an append-only JSONL decision
log. Details, data model, and sequences: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
The spec format itself: [docs/SPEC_FORMAT.md](docs/SPEC_FORMAT.md).

Honest scope: tracegraph specs cover the **behavioral** layer — tools,
ordering, structured conditions. They do not judge whether your model's
*reasoning* was sound, and semantic conditions ("the customer sounds
angry") are future work. For consequential actions — money, deletion,
compliance — the behavioral layer is the one you need guarantees on.

## Status

v0.1 — launch cut. Built on a validated method: on our benchmark corpus,
induced guards agreed with held-out agent behavior at 95%+ and recovered a
hidden backend policy from behavior alone, including a real
behavioral quirk nobody had designed (the agent refuses $0 refunds).
Next up: what-if replay, active probing, OTel ingestion + Python SDK,
self-hostable production gate — follow the pinned issues for sequencing.

Apache-2.0.
