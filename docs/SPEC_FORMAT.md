# The tracegraph spec format

Version marker: `tracegraph: 1`. Specs are YAML, designed to live in git
and be reviewed in PRs. Normally *induced* by `synthesize`, but the format
is stable and hand-editable.

## Example

```yaml
tracegraph: 1
name: refund
inputs:
  - order_id
steps:
  - kind: call
    id: call-order
    tool: get_order
    args:
      order_id: ${input.order_id}
    as: order
  - kind: call
    id: call-refund_policy
    tool: check_refund_policy
    args:
      order_id: ${input.order_id}
    as: refund_policy
  - kind: gate
    id: gate-on-guard
    guard:
      - - feature: refund_policy.max_amount
          op: ">"
          value: 0.25
    then:
      - kind: call
        id: call-issue_refund
        tool: issue_refund
        args:
          order_id: ${input.order_id}
          amount: ${refund_policy.max_amount}
        as: issue_refund
induction:
  traces: 101
  at: 2026-07-29T00:00:00Z
  agreement: 1
  tool: tracegraph@0.1.0
```

## Steps

**`call`** — a tool invocation. `tool` is the canonical name
(agent-specific namespacing like `mcp__server__name` is stripped by the
loaders). `args` is a template: values are literals, `${input.<name>}`
(task inputs, auto-detected as args whose literals vary across traces), or
`${<binding>.<field>}` (data flow from an earlier result). `as` names the
result binding. `loadBearing: false` marks calls whose results feed nothing
downstream — they are part of observed behavior but excluded from
behavioral diffs.

**`gate`** — a guarded branch. `guard` is DNF: an array of AND-groups,
where the whole guard holds if any group does. `then` steps are expected
only when the guard holds. A gated action firing while the guard is false
is a deviation (`check`) or a blockable violation (`gate`).

## Guard clauses

`{ feature, op, value }` with ops `>`, `<=`, `==`, `!=`.

`feature` is a dotted path over result bindings: `refund_policy.max_amount`
reads field `max_amount` of the result bound as `refund_policy`. A trailing
`.age_days` derives days-since-date from an ISO `YYYY-MM-DD` field at
evaluation time (e.g. `order.shipped_at.age_days`).

## Evaluation semantics (identical in synthesize, check, and gate)

1. **Action-time state.** Guards are induced from and evaluated against the
   state visible when the gated action fires — never post-action state.
2. **Latest-wins.** State is the most recent observation of each feature
   (an agent that pivots to a different entity is judged on fresh results).
3. **Errors are not state.** Transport errors and results carrying an
   `error` field contribute nothing to features.
4. **Only successful actions count as taken.** Business-level rejections
   (`ok: false`, `success: false`) are attempts, not behavior.
5. **Identifiers (`id`, `*_id`) never become guard features.**
6. A missing feature makes a clause false — a decision made without the
   required observation is a violation, not a pass.

## Invariant rules file (used by `check` and `gate`)

Hand-authored assertions that don't depend on induction:

```yaml
rules:
  - action: issue_refund
    requires_prior: check_refund_policy
    description: never refund without checking policy
  - action: issue_refund
    requires_guard:
      - - feature: refund_policy.eligible
          op: "=="
          value: true
```

`requires_prior` is an ordering assertion. `requires_guard` is a state
assertion in the same DNF clause form as spec guards. Note the lesson baked
into this repo's test suite: ordering assertions alone pass runs where the
prior call happened but *failed* — pair them with state assertions, or rely
on the induced gate.

## `induction` provenance

Informational: trace count, timestamp, training agreement, tool version.
Downstream tooling must not depend on it.
