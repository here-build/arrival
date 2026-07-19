# Provenance vocabulary v2 — the declared algebra

*Status: ideation captured (V + Fable, 2026-07-09). Companion to
`execution-plan-wireframe.md` (the two-layer/replay thesis this vocabulary serves) and
arrival's PRINCIPLES.md P0/P7/P10. Supersedes the two ad-hoc declaration booleans
(`fanout?: boolean`, `pure?: boolean`) with one small language.*

## The thesis this serves

Two-layer provenance: a static map built first (the wireframe), runtime routes stored
only at provenance-significant boundaries. Pure, local, throwaway computation
(db string → split → max-length → inference arg) is never *stored* as provenance steps —
it is *materialized* on the static level, and walkable step-by-step on demand by replay,
which is sound only because dynamics are eliminated and immutability enforced. Storage
flips to the time-space optimum: connections on a semi-baked graph; the runtime bakes
ports.

For the static layer to be buildable, every symbol must DECLARE its provenance behavior —
the wireframe's evaluator reads the algebra as data (P7: instruction keys / N static
interpreters), never duck-reads markers off bound functions.

## 1. The node vocabulary (today → v2)

| Kind | Today | v2 |
|---|---|---|
| `pipe` | implicit (pure ops) | explicit default: pure transform, input-union forwarding; collapses into segments |
| `fan` | `fanout: true` boolean on native/sequence | declared; carries the element-wise sub-wiring |
| `mux` | classifier-derived from if/cond/when | unchanged (special forms) — but muxes also arise from `decision` callbacks (see §3) |
| `source` | rosetta default (`isRosettaIn` heuristic) | declared; mints fresh point at the port |
| `sink` | **missing** | NEW: terminal edge — consumes tracked value, produces none (print/log/effect-write). A sink is a port with no egress wire |
| `transparent` | **missing** | NEW: membrane-crossing but provenance-inert (dedent). Not every rosetta is provenanced |
| `loop` | **missing** — named-let/do classify `opaque` | NEW: fixpoint — mux + backedge. Cone queries traverse it with widening, not as a black box |
| `opaque` | escape hatch (named-let, unknown ops) | quarantined: every `opaque` is a ledgered gap, elimination-tracked; no new producers |

Structural-fact plane (C1's table, same vocabulary from the container side):
`PROXIED` / `PROVENANCED` / `MINTED` per (groupingFact, lengthFact) — these are not a
separate system; they are what `pipe`/`decision`/constructor mean when the value is a
container.

## 2. Declarations carry the language

Every symbol declaration bears a `provenance` role; the two legacy booleans dissolve
into it.

- **native / sequence / tagless / tagless-guard**: default `pipe` (pure is the default —
  bearing the processing logic, not the storage). `fanout: true` → `fan`.
- **rosetta**: default `source` (most are). Explicit overrides: `transparent` (dedent),
  `sink` (write/log/effect-out), `pipe` (today's `pure: true`).
- **special forms**: mux/loop/binder — owned by the evaluator/classifier, not
  declarations; named-let and do reclassify `loop` (kills their `opaque`).

The role is DATA on the declaration (string key space, P7 taxonomy) — the lineage
classifier, the wireframe builder, and the type lens all read the same field. The
`.fanout`-stamped-on-bound-fn duck-read dies.

## 3. Callback wiring — extracted from the contract

A `z.lambda` arm in a verb's input contract determines the passed procedure's provenance
role from position + return shape; the declaration only overrides where the contract
underdetermines:

| Contract shape | Role | Provenance meaning |
|---|---|---|
| callback returns `z.value`, verb is a fan (map/vector-map) | **element-transformer** | per-element pipe under the fan; element lineage flows through |
| callback returns ordering/boolean used to arrange (sort comparator) | **selector** | touches ORDER only → container facts PROXIED; elements untouched; the comparator's cone feeds the *structural* fact, not element data |
| callback returns boolean choosing membership (filter/remove pred) | **decision** | mux-shaped: survivor set + length become PROVENANCED (union with the decision's cone) |
| callback performs effects (for-each fn, sink-side) | **effect** | sink edge per invocation; region-disciplined (B3) |

Drift alarm (P16): a declared role that contradicts the contract shape (a `transparent`
verb whose contract has a `z.lambda` decision arm; a `sink` with an output wire) throws
at assembly — the door teaches the mismatch.

## 4. What this unlocks (order of work)

1. **Vocabulary lands in `src/values/lineage.ts`** (`sink`/`transparent`/`loop` kinds;
   `opaque` gets the quarantine ledger row).
2. **Declaration field** replaces `fanout`/`pure` booleans (mechanical: two booleans
   currently have exactly two readers each).
3. **Classifier goes declaration-driven** — `isRosettaIn` heuristic dies; named-let/do →
   `loop`.
4. **Contract-extraction pass** for callback roles + the drift alarm.
5. Then the wireframe (W1) builds on a fully-declared algebra — no heuristics in the
   static layer — and the replay redesign (port-mint + eager-as-oracle) has the
   vocabulary to say precisely which ports mint, which sink, which forward.

Open question retained (not decided here): whether `selector`/`decision` cones should be
queryable separately from data cones ("why is this list SORTED this way" vs "where did
element 3 come from") — the wireframe's two-cone design suggests yes, cheaply, since
they're distinct wire colors in the same graph.
