# Rulings R1–R9 + key taxonomy (V, 2026-07-09)

Resolved by interview. Each ruling unblocks the gated cells that cite it; the ledger's gate
column now points here.

## R1 — Exit convention: uniform plain-JS, two-tier API
`toJS`/`schemeToJs`/exec egress always fully unwraps — outside the membrane only plain JS
exists, provenance stays in the trace. AND the API splits into two tiers:
- **simple flow**: "run, get JS" — the default exec surface;
- **complex flow**: "run, get reusable state" — raw boxed outputs, lexical scope, provenance
  metadata (session continuation, tooling, law tests).
First iteration: simple wraps complex (simple = complex + final unwrap). The boolean
op-helpers shortcut dies with the uniform exit.

## R2 — Container provenance: grouping fact + private structural facts
The container's own provenance = the collection-level grouping fact (G2 minimal-cone
design). ADDITIONALLY each container kind carries private structural facts:
- arrays/vectors: **length** — PROXIED through length-preserving ops (map/sort thread it),
  PROVENANCED in length-changing ops (filter mints it as a derived fact);
- dicts: **keyset** (postponable).
This enables shortcut evaluation — `(< (length (sort …)) 5)` decidable without provenancing
the sorted data. Implement the NAIVE strategy now but EXPLICITLY (named fields, not
emergent), so the shortcut path is a later optimization, not a redesign.

## R3 — Recognition: instanceof AValue + sub-union stratification (new work item)
Keep the concrete union for type narrowing; recognition = `instanceof AValue` plus the few
explicit non-AValue arms. NEW INVESTIGATION: SchemeValue is too broad — stratify into
lifecycle sub-unions (e.g. EOF cannot sit inside a pair; Values/Keyword have their own
admissibility). Design the sub-union lattice before mechanically fixing isSchemeValue.

## R4 — AHalfBaked: existence review first (new work item)
HalfBaked is a speculative-execution optimization, possibly no longer earning its keep as a
full value primitive. Review its reason-to-exist; IF it stays, `arrival/toJS` on a carrier
becomes a **MaybePromise resolving when the value bakes** — not a marker, not a throw.
The `{__halfBaked__}` marker shape dies either way.

**RESOLVED — VERDICT KILL** (docs/working-proposals/halfbaked-existence-review.md, 2026-07-09):
zero production reachability (the flag was set only by the feature's own tests), and R2/C3's
struct-fact wires supersede it as the principled version of the same idea. `AHalfBaked`
dissolved; the `{__halfBaked__}` marker died with it. The motivating program
(`(if (>= (length (filter pred items)) 2) …)` deciding early) moved into
execution-plan-wireframe.md as an acceptance criterion for struct-fact wires.

## R5 — Cones: both queries + the execution-plan wireframe (major design item)
Both reads are required: "why is this an input" (minimal cone) and "what changes if I adjust
this output" (full/sealing cone) — two queries over one representation. AND the target
architecture: a **generalized execution plan** — the AST statically evaluated into a base
wireframe holding every mux/bifurcation, with static wires COLLAPSED into procedural nodes
(`(+ (* x x) 5)` = ONE provenance edge, not four), real runtime provenance wiring into the
abstract flow. This is the provenance memory optimization that fits CF worker limits.
Aligns with the existing static-lineage G-gates; supersedes the per-op accumulation model.

## R6 — Curly-infix: force-eliminate n-expressions, ban door
`{:key value}` (Clojure dict literal) won the brace grammar. `{a * b}` becomes near-illegal:
**explicitly detected and BANNED** with an educational door (not silently misparsed as a
dict). Neoteric/n-expressions live in the sugarcoat syntax layer ONLY. The ~40-invariant
curly-infix suite shrinks to the ban-door tests + dict-literal grammar; the reader's
curly-infix mode is deleted.

## R7 — letrec lowering: fix at root
Lower letrec to a shape where the binding is in scope for its own initializer (s.letrec
combinator; consider `function name() {}` declaration style for the circularity). ALSO:
check how letrec lowers in the inhuman/mercury compiler pipeline — same bug class may exist
there. Drops-only law holds absolutely; no advisory-false-positive carve-out.

## R8 — Boolean provenance: conditional mint
Provenance-free operands → shared flyweight (hot paths stay allocation-free); stamped
operands → fresh ABool carrying the union. Today's op-helpers shortcut becomes principled:
a verdict derived from lineage carries it, a verdict derived from constants doesn't.

## R9 — Container toJS: deep unwrap via lazy ref-tracking proxies
Deep unwrap everywhere — but through **lazy-materializing recursive proxies** with a
ref-tracker (multi-referenced values stay singletons). No full materialization at egress;
the proxy lenses in depth on demand. Future bonus: deep field access can preserve provenance
reach-back (non-primitive reads re-enter the boxed world). Cost: one proxy + on-demand
generation instead of a full copy.

AMENDED (egress-membrane-exit rework, 2026-07-12 —
`docs/working-proposals/arrival-egress-membrane-exit.md`): proxy identity is per
PROJECTION, not one global slot. Bare (serialization `arrival/toJS`) = (box) forever;
membrane (`arrival/toJSMembrane`, rosetta/exec crossings — options honored at every
depth, nested callables become host fns) = (box, mode, exporting RegionScope); gated
(tier-state) = (gate, box). Singleton/aliasing law holds WITHIN a slot; cross-slot
identity was never coherent once projection depends on options/scope.

## Key taxonomy — PRINCIPLES P7 corollary, migrate now
Three roles, one mechanism each:
- **algebra instruction keys** → strings (`arrival/...`) — every static interpreter consumes
  instruction names as data (P0's N-interpreter argument);
- **capability brands** → module-local symbols, never Symbol.for (forgeability = escape);
- **metadata slots** → Symbol.for (enumeration-invisible; survives dual module instances).
Migrations to ride the next batch: `CLASS` → `"arrival/class"`; F3 gains the forgery-guard
law row ("a borrowed object's own `arrival/*`-named data key is DATA, never protocol").

## Next-session lead (sequenced)
1. Bug batch + conservation repair (isSchemeValue completeness, append P5 door,
   parseNameDoc colon fix, canonicalize collisions, flat-stamp union for append/cdr, DR4)
   — flips ~30 it.fails.
2. Chibi parity triage (72× let*-hygiene gap first).
3. Reverse-membrane pilot (cxr → ANativeProcedure).
New design items spawned by the rulings: two-tier exec API, sub-union lattice, HalfBaked
review, execution-plan wireframe, infix ban door, letrec lowering + mercury check.
