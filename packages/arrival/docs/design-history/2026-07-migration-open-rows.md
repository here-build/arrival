# Post-migration ledger — rows still open (2026-08-02 harvest)

Distilled from `POST-MIGRATION.md` (deleted; see git history). Re-verified against HEAD.

Resolved since the ledger was written (no action):
- `installHeapMeter` imports — both cited sites (`arrival-run/run-program.ts`,
  `inhuman/saas/studio .../run-traced.ts`) now pass `heapBudget` per exec; only comments remain.
- `@inhuman.tools/arrival-lsp-tsgo` module-not-found — `tsgo-lens.worker.ts` no longer
  exists; zero references outside docs.
- `classifierFromEnv(env, SOURCES)` 2-arg call sites — gone; 1-arg form everywhere.

Still open:
- **`arrival-manifold` latent test-rot** (green today, coincidental):
  `__tests__/bind.test.ts` — 13 dead `schemeToJs(...)` unwraps over now-plain `exec` output;
  `replay-cache-{restore,safety}.test.ts` + `session-declaration-persistence.test.ts` —
  `String(await runExpr(...))` assertions pass for small ints only (would diverge for
  rationals/floats/big bigints). A TODO at `replay-cache-restore.test.ts:63` marks it.
  Migrate to `execState` or assert plain values when next touched.

Named future waves (tracked elsewhere, not lost with the ledger):
- reflect/elk EvalTrace consumers hollow under Q20b default-OFF → repo-root
  `docs/working-proposals/arrival-reflection-env-over-provenance.md` and
  `inhuman-elk-over-provenance.md`.
- Core design-gaps (live mux-decision driver, dict per-field stamps, D1 FIFO stand-in,
  pipe-role forward, dormant `argProvenance`) → ledger/RULINGS rows in-package.
