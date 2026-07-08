# Post-migration ledger — downstream breakage parked during the core rework

*Rule (V, 2026-07-09): downstream packages are already partially broken from prior API
reworks. Anything deeply wrong discovered in a downstream package or its tests during the
[`REWORK-DAG.md`](REWORK-DAG.md) execution gets a row HERE and work continues — it never
blocks a core commit. This phase runs after node Z.*

Row format: package · what's broken · which rework node exposed it · suspected depth
(import-fix / test-rot / design-mismatch).

| Package | Breakage | Exposed by | Depth |
|---|---|---|---|
| `arrival-provenance` | becomes a re-export shim at C0; consumers still importing analysis internals need repointing | C0 (planned) | import-fix |
| *(append as discovered)* | | | |
