# ctx audits (2026-07-11) — superseded by on-value `.location`

Outcome: source span lives on `.location`, an immutable constructor-only channel on the `AValue`
base (re-stamp via `withLocation()`, mirroring `withProvenance`). The proposed `PARSE_CTX` run-context
species never shipped; the supersession is pinned by `src/reader/__tests__/parse-ctx.law.test.ts`.
Three audits fed the rework:

- **Constant-ctx audit** — of ~253 `CONSTANT_CTX` use sites, ~78% were provenance-dropping bugs or
  threading gaps, rooted in a syntactic trap: dispatch delivers live ctx via `this: CallCtx`, but
  arrow-function impls structurally cannot read `this`. Proposed a 7-wave rework whose Wave 6 minted
  a third RunContext species `PARSE_CTX` to give reader leaf literals source identity.
- **Parse-ctx consumer map** — mapped 23 reader sites over the span channel (typed `getLocation()` +
  raw `Symbol.for("__location__")`, one backing slot) and planned a 4-phase mirror-then-cutover
  migration of the span fact onto `PARSE_CTX`.
- **Effects redundancy audit** — orthogonal: ruled `arrival-effects` forward-cone invalidation and
  `defineDataEffectRosettas` dead, the rest not redundant. Untouched by the supersession; its
  deletions and the `discovery-run.ts` re-fire question stand on their own.

Why the ruling made the parse-ctx plan moot: span is not a run context — it is plain per-value data
with no run facets to assert. Once span became on-value data with one channel from the start,
`PARSE_CTX` had nothing to carry, the mirror-agreement law had nothing to verify, and the phased
reader cutover dissolved. The ruling out-delivered the proposal: all leaf and container literals are
located (including quote-family inner cells the mirror design left undefined).

Survived from the audits: the diagnosis "two channels for one fact is the disease" (resolved by
picking neither channel); the span-blind-leaf finding, now law (a) of the test; the symbol carve-out
(ASymbol flyweight `===` is load-bearing, so symbols carry no location). The broader `CONSTANT_CTX`
cleanup landed only partially and remains open.

Distilled 2026-08-02 from 3 working docs; see git history.
