# Contributing to tracegraph

Thanks for looking under the hood. Ground rules and orientation:

## Setup

```bash
npm install
npm run build      # tsup → dist/
npm test           # vitest — must stay green
npm run typecheck
```

`npm run test:corpus` runs a 279-trace integration against a research
corpus that only exists on the maintainer's machine — it skips gracefully
elsewhere and in CI. Don't worry about it; the unit fixtures under
`fixtures/` are subsets of the same real data.

## What makes a good PR here

- **Behavioral claims need trace evidence.** This project's history is a
  string of bugs found only by running real, messy traces (rejected
  actions mislabeled, harness tools winning action detection, stale
  session state). If you change loader, induction, or evaluation
  semantics, add a fixture trace that exercises the case — synthetic is
  fine if labeled as such, real is better.
- **The three consumers must stay in agreement.** `synthesize`, `check`,
  and `gate` share evaluation semantics (see docs/SPEC_FORMAT.md
  "Evaluation semantics"). A change to one that isn't reflected in the
  others is a bug even if its own tests pass.
- **Spec format changes are breaking changes.** The YAML format is the
  public contract. Additive fields: minor. Anything else: discuss first.
- Keep the dependency tree thin — this package installs into people's CI.

## Where things live

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map, data
model, and sequences.

## Most-wanted

1. **OpenTelemetry GenAI ingestion** — the pinned issue. A loader from
   OTel GenAI spans to the normalized Trace model opens tracegraph to
   LangGraph/LangChain/OpenAI-SDK users.
2. A second example domain (coding agent, browsing agent) with real traces.
3. Loader for your agent framework of choice — the normalized model is
   deliberately small (see `src/trace/types.ts`).
