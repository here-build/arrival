# @inhuman.tools/arrival-mercury

The name is the pair it compares: **arrival** (the interpreter) vs **mercury**
(the compiler). This is the differential-oracle harness that proves the two
readings of a program agree — one semantic object, two simultaneous readings,
and this package is where they are reconciled.

Programs are compared as black-box, source-in/value-out outcomes: the
interpreter side runs an `arrival-run` session; the compiled side executes the
mercury run-view via tsx `tsImport`. Neither side sees the other's internals —
agreement is judged on observable results, not implementation echoes.

Owns:

- The `ErrorClass` taxonomy — compiler and interpreter errors classified into
  one shared vocabulary so "both failed" can be distinguished from "disagreed".
- `oracleEqual` — the verdict comparator.
- The three-way corpus check (oracle, expected outcome, program face) the
  tier-1 bug-cell tests consume.

Also carries the new pipeline's front end (`desugar`) and the CoreForm IR it
produces — the copy-as-chunk surface the compiled reading lowers from.

Entry points: `.` (oracle harness + front end), `./circuit`.

## Testing

See [TESTING.md](./TESTING.md) — the suite is an adversarial artifact: the
negative flows (forges refused, fail-closed paths) are the product; positive
flows exist so fail-closed doesn't degenerate into fail-everything.

## License

[FSL-1.1-MIT](./LICENSE.md) — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date.
