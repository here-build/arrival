# Provenance vocabulary — the declared algebra

The settled role vocabulary is normative in [`PROVENANCE.md`](../PROVENANCE.md) §2. This
note keeps the reasoning behind it that the contract compresses: why roles are DECLARED
data rather than heuristics, and the fuller callback-role table whose selector/decision
split PROVENANCE.md folds into `control` and defers.

## Why declared, not duck-read

For the static wireframe to be buildable, every symbol must DECLARE its provenance role —
the wireframe's evaluator reads the algebra as data (P7: instruction keys / N static
interpreters), never duck-reads markers off bound functions. Heuristics and duck-reads are
the rejected encoding: a marker stamped on a bound function is invisible to a static
evaluator, and a heuristic (`isRosettaIn`) silently misclassifies every symbol its guess
misses. Roles as declared data make both failures impossible.

The role is DATA on the declaration (string key space, P7 taxonomy) — the lineage
classifier, the wireframe builder, and the type lens all read the same field. `native /
sequence / tagless` default `pipe`; `rosetta` defaults `source`; special forms
(mux/loop/binder) are owned by the evaluator/classifier, never declarations (named-let and
do classify as `loop`, never `opaque`).

## Callback wiring — extracted from the contract

A `z.lambda` arm in a verb's input contract determines the passed procedure's provenance
role from position + return shape; the declaration only overrides where the contract
underdetermines. PROVENANCE.md §2 collapses `selector` and `decision` into one `control`
role with ONE cone color and DEFERS the split — but the wires stay distinct in the graph,
so splitting later is additive. The pre-collapse mapping, kept for that reason:

| Contract shape | Role | Provenance meaning |
|---|---|---|
| callback returns `z.value`, verb is a fan (map/vector-map) | **element-transformer** | per-element pipe under the fan; element lineage flows through |
| callback returns ordering/boolean used to arrange (sort comparator) | **selector** | touches ORDER only → container facts PROXIED; elements untouched; the comparator's cone feeds the *structural* fact, not element data |
| callback returns boolean choosing membership (filter/remove pred) | **decision** | mux-shaped: survivor set + length become PROVENANCED (union with the decision's cone) |
| callback performs effects (for-each fn, sink-side) | **effect** | sink edge per invocation; region-disciplined |

The structural-fact verbs PROXIED / PROVENANCED / MINTED are not a separate system: they
are what `pipe` / `decision` / constructor mean when the value is a container.

A declared role that contradicts the contract shape (a `transparent` verb whose contract
has a `z.lambda` decision arm; a `sink` with an output wire) throws at assembly — the drift
alarm's door teaches the mismatch (P16).
