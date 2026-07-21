# Gate 3 — human sign-off checklist (V, once per gate)

Constitution §9: the rubric's non-decidable half. Machine half lives in
`gate3-rubric.test.ts` (IIFE-position, import order, guard-form policy) +
the byte goldens in this directory.

Read the seven goldens (`*.golden.ts`) as a senior engineer reviewing a PR:

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
| goldenEpoch 1 (Phase-1 exit) | 2026-07-17 | superseded | never signed at epoch 1; three regenerations (E1a names, R5c eta = epoch 2, E2a folding = epoch 3) landed before human review reached it |
| goldenEpoch 3 (E2 exit) | 2026-07-17 | **APPROVED w/ punch-list** | V review: goldens read right, `first-class-car-hof` = the model. Conditional on the six fixes in `../../../../../docs/working-proposals/arrival-mercury/gate3-human-grade-rulings.md` (export default, stdlib-over-runtime, await-elision, multi-list real-op, short-circuit static prevaluation). R-G5 (car) needs no change. |
