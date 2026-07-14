# Gate 3 — human sign-off checklist (V, once per gate)

Constitution §9: the rubric's non-decidable half. Machine half lives in
`gate3-rubric.test.ts` (IIFE-position, import order, guard-form policy) +
the byte goldens in this directory.

Read the six goldens (`*.golden.ts`) as a senior engineer reviewing a PR:

- [ ] **Guard legibility** — every `!== false` that remains reads as a deliberate
      Scheme-truthiness guard, not noise; nothing a reviewer would flag as
      "why is this compared to false?" without the Law-T context.
- [ ] **Naming** — params/locals read as intent (`xs`, `example`, `first/second`),
      no `__`-glue leaking into user-facing positions.
- [ ] **Shape** — no ceremony a hand-writer would delete (dead wrappers,
      redundant parens the formatter missed, unused imports).
- [ ] **The async plane** — awaits sit where a human would put them;
      `Promise.all` where iterations are independent.
- [ ] **Verdict** — would you approve this diff if a colleague sent it?

| Gate event | Date | Verdict | Notes |
|---|---|---|---|
| goldenEpoch 1 (Phase-1 exit) | _pending V_ | | |
