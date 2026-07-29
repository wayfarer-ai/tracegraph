---
name: Bug report
about: Something behaved wrongly
labels: bug
---

**What happened**

**What you expected**

**Repro**
- tracegraph version (`tracegraph --version`):
- verb + full command:
- OS / node version:

**Trace evidence (the thing that actually helps)**
If the bug involves synthesis, check, or gate behavior, attach a minimal
trace file (ATIF `.json` or stream `.jsonl`) that reproduces it — redact
values freely, structure is what matters. Bugs with traces get fixed
dramatically faster; most of our test suite is traces users would call
"weird".
