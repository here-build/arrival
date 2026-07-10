// SRFI-189 — Maybe & Either (tagged-list values). Scheme-bootstrap capability.
//
// MIGRATED off the text-blob `prelude` (docs/working-proposals/symbol-define-static-
// program-validation.md, wave W4/H2b): every constructor/predicate/accessor/combinator
// is now an individually-declared `symbol.define`, contract-enforced from day one
// (§1.2 rev2 ruling) — no more opaque prelude string, no more assembly-order-luck
// cross-capability references (§2.1's bake FV locality law forces every free name
// into either this capability's OWN symbol set or a DECLARED `deps` edge).
//
// THE SAME LUCK CLASS srfi-235/srfi-43 (W4/H1-H2) found, here for THREE targets at
// once (design doc §2.1's "live catch", §4.1's census): every body below reaches for
// `list`/`car`/`cdr`/`null?` (list construction/access), `pair?`/`eq?` (equality), and
// `error` (the exception-handling `error` procedure) — none of them declared. It
// worked only because `env-roots.ts`'s two-phase bootstrap (NATIVE_PACKS → global_env,
// THEN BASE_PACKS → user_env, in declaration order within each phase) guarantees every
// one of these is already bound by the time this pack's prelude ran — a RUNTIME
// guarantee, not a declared one. The bake FV law (`define-bake.ts`) does not (and, by
// design, should not — a hermetic/roster/glass assembly that doesn't happen to include
// these deps can't silently break) consult that runtime guarantee, so each free name
// gets the exact treatment srfi-235's `compose` and srfi-43's `vector-length` did: a
// real `deps` edge below. `car`/`cdr` are the ONE exception — the resolver-synth `c[ad]
// +r` family (`define-bake.ts`'s `CXR_RE` allowlist, machinery fix `cdc63c70ec`) needs
// no dep at all, bare or nested (`(car (cdr m))`).
//
// `deps: [equality, exceptions, lists]`:
//   - `equality` (r7rs/equality.ts, `pair?`/`eq?`) is a NATIVE_PACKS member — never an
//     entry of the BASE_PACKS array C3 linearizes over, so (per srfi-43's own precedent
//     comment) NO repositioning of base-packs.ts is needed for this edge.
//   - `lists` (r7rs/lists.ts, `list`) IS a BASE_PACKS member, but srfi-235's H1
//     migration already repositioned it near the end of `BASE_PACKS` (a C3 "good
//     head" requirement — a dependency must rank BELOW every dependent naming it) —
//     this pack's edge onto it needs no FURTHER repositioning, it rides the
//     existing fix.
//   - `exceptions` (r7rs/exceptions.ts, `error`) IS a BASE_PACKS member and was NOT
//     previously a `deps` target of anything — it sat with the rest of `allR7rs`, BEFORE
//     `allSrfi` (hence before this pack) in the array, which is exactly the
//     `polyglot`/`lists` conflict shape srfi-235 hit: a dependency ranked ABOVE its
//     dependent in the flat roots array contradicts C3's requirement that a dependency
//     be a "good head" ranked BELOW every capability naming it. Empirically confirmed
//     (`AssembleLinearizationError` on `initBridge()`) before the base-packs.ts fix
//     below; repositioning `exceptions` into the tail block (alongside `lists`/
//     `polyglot`) resolves it, by the identical mechanism.
//   - The `deps` ARRAY ORDER also matters (mirrors base-packs.ts's own header
//     comment on this): `c3Linearize` feeds a pack's declared `deps` order in as a
//     merge input beside the root array's own order — this array is
//     `[equality, exceptions, lists]` to AGREE with base-packs.ts's tail-block
//     order (`exceptions` before `lists`), not `[equality, lists, exceptions]` —
//     the two orderings must agree or C3 has no valid linearization (empirically
//     confirmed: swapping either one alone reproduces `AssembleLinearizationError`).
//
// Faithfulness note: `error`'s scheme-level `error` procedure (not a bare JS throw)
// is used deliberately, not merely because it was there before — `maybe-ref`/
// `either-ref`/`either-swap`'s failure path integrates with `with-exception-handler`'s
// handler-stack machinery (raise pops/dispatches the current handler; a JS-native
// throw would bypass that entirely) — see r7rs/exceptions.ts. A program that wraps
// `(with-exception-handler h (lambda () (maybe-ref (nothing))))` must see its handler
// invoked exactly as it did pre-migration; a real `deps` edge on `exceptions` (and the
// base-packs.ts reposition it forces) is the honest way to keep that, not a shortcut.
//
// Contract choices (§1.2's "REAL contract authored per define, day one"):
//   - Maybe/Either VALUES themselves (the tagged lists `(just x)`/`(nothing)`/
//     `(left x)`/`(right x)` build and every predicate/accessor/combinator reads) are
//     `z.value` — scheme-zod.ts has no dedicated "tagged variant" vocabulary item (the
//     same "no dedicated vocabulary item" reasoning r7rs/exceptions.ts's own
//     `%current-handlers` stack slot documents), and a fixed-heads `z.list([z.symbol,
//     z.value])` would force a symbol-codec round-trip (JS `symbol` ↔ `ASymbol`) onto
//     a purely-internal tag no consumer ever needs decoded — `z.value`'s
//     representation-blind identity is the honest ceiling here, matching every other
//     "no vocabulary item" slot in this codebase.
//   - `maybe->list`/`either->list` are the one place a TIGHTER contract than `z.value`
//     is both correct and free: their body ALWAYS returns a genuine 0-or-1-element
//     proper scheme list (`(list …)` or `'()`) — `z.list(z.value)` (scheme-zod.ts's own
//     `AListAlike` codec) documents that honestly. Contract enforcement is VALIDATE-
//     ONLY (`define-bake.ts`'s `buildDefineProcedure`: `z.decode`'s result is discarded,
//     the original scheme value flows through unchanged) — `z.list`'s codec never
//     actually converts the returned value to a JS array at the call boundary, so this
//     tightening costs nothing but a spine-shape check.
//   - `list->maybe`'s `lst` input is `z.list(z.value)` for the same reason (the body's
//     own `null?`/`car` calls already assume a proper list; only the FIRST element is
//     read, so no fixed-length constraint, just "proper list").
//   - `maybe-ref`/`either-ref`'s optional `failure` procedure is `inputRest: z.lambda`
//     (0-or-1 in practice — the body only ever reads `(car failure)` once — but SRFI-
//     189's own signature is variadic-rest shaped, matching `error`'s own `inputRest`
//     convention in r7rs/exceptions.ts).
//   - Every `f`/callback slot (`maybe-bind`/`maybe-map`/`either-bind`/`either-map`) is
//     `z.lambda` — a real procedure value, contract-enforced (a non-callable `f`
//     rejects before the body runs, unlike the pre-migration prelude which would have
//     thrown a raw scheme apply-error deep inside the call).
import { EnvCapability } from "../../common/capability.js";
import { symbol } from "../../common/symbol.js";
import * as z from "../../common/scheme-zod.js";
import equality from "../r7rs/equality.js";
import exceptions from "../r7rs/exceptions.js";
import lists from "../r7rs/lists.js";

export default new EnvCapability("scheme/srfi-189", {
  // See the file header: `list` (lists), `pair?`/`eq?` (equality), `error`
  // (exceptions) are every cross-capability free name this pack's define bodies
  // reach (`car`/`cdr` are the resolver-synth cxr family — no dep needed). The bake
  // FV law (§2.1) forces each into a real edge; base-packs.ts repositions
  // `exceptions` (this migration) alongside `lists`/`polyglot` (srfi-235's H1 fix)
  // to satisfy C3's "good head" requirement for the two BASE_PACKS-array members.
  // ORDER MATTERS here too (mirrors base-packs.ts's own header): `c3Linearize`
  // feeds a pack's OWN `deps` array order in as a merge input alongside the root
  // array's order — this array must agree with base-packs.ts's tail-block order
  // (`exceptions, lists, polyglot`), i.e. `exceptions` before `lists`, or the two
  // orderings contradict each other and C3 has no valid linearization (empirically
  // confirmed: reversing this array alone reproduces `AssembleLinearizationError`).
  deps: [equality, exceptions, lists],
  symbols: {
    // ── constructors ──────────────────────────────────────────────────────────
    just: symbol.define`just: SRFI-189 — wrap x as a Just (the present/success case of Maybe)`(
      { input: [z.value], output: [z.value] },
      `(lambda (x) (list 'just x))`,
    ),
    nothing: symbol.define`nothing: SRFI-189 — the absent Maybe (Nothing); a 0-argument constructor`(
      { input: [], output: [z.value] },
      `(lambda () (list 'nothing))`,
    ),
    left: symbol.define`left: SRFI-189 — wrap x as a Left (conventionally the failure/error case of Either)`(
      { input: [z.value], output: [z.value] },
      `(lambda (x) (list 'left x))`,
    ),
    right: symbol.define`right: SRFI-189 — wrap x as a Right (conventionally the success case of Either)`(
      { input: [z.value], output: [z.value] },
      `(lambda (x) (list 'right x))`,
    ),

    // ── predicates ────────────────────────────────────────────────────────────
    "just?": symbol.define`just?: #t iff m is a Just`(
      { input: [z.value], output: [z.boolean] },
      `(lambda (m) (and (pair? m) (eq? (car m) 'just)))`,
    ),
    "nothing?": symbol.define`nothing?: #t iff m is Nothing`(
      { input: [z.value], output: [z.boolean] },
      `(lambda (m) (and (pair? m) (eq? (car m) 'nothing)))`,
    ),
    "maybe?": symbol.define`maybe?: #t iff m is a Just or Nothing`(
      { input: [z.value], output: [z.boolean] },
      `(lambda (m) (or (just? m) (nothing? m)))`,
    ),
    "left?": symbol.define`left?: #t iff e is a Left`(
      { input: [z.value], output: [z.boolean] },
      `(lambda (e) (and (pair? e) (eq? (car e) 'left)))`,
    ),
    "right?": symbol.define`right?: #t iff e is a Right`(
      { input: [z.value], output: [z.boolean] },
      `(lambda (e) (and (pair? e) (eq? (car e) 'right)))`,
    ),
    "either?": symbol.define`either?: #t iff e is a Left or Right`(
      { input: [z.value], output: [z.boolean] },
      `(lambda (e) (or (left? e) (right? e)))`,
    ),

    // ── Maybe accessors / combinators ────────────────────────────────────────
    "maybe-ref": symbol.define`maybe-ref: unwrap a Just; on Nothing call the optional failure thunk (default: error)`(
      { input: [z.value], inputRest: z.lambda, output: [z.value] },
      `(lambda (m . failure)
         (cond ((just? m) (car (cdr m)))
               ((pair? failure) ((car failure)))
               (else (error "maybe-ref: Nothing"))))`,
    ),
    "maybe-ref/default": symbol.define`maybe-ref/default: unwrap a Just, or return default on Nothing`(
      { input: [z.value, z.value], output: [z.value] },
      `(lambda (m default) (if (just? m) (car (cdr m)) default))`,
    ),
    "maybe-bind": symbol.define`maybe-bind: monadic bind — apply f to the wrapped value; Nothing short-circuits`(
      { input: [z.value, z.lambda], output: [z.value] },
      `(lambda (m f) (if (just? m) (f (car (cdr m))) m))`,
    ),
    "maybe-map": symbol.define`maybe-map: map f over the wrapped value, preserving Nothing`(
      { input: [z.lambda, z.value], output: [z.value] },
      `(lambda (f m) (if (just? m) (just (f (car (cdr m)))) m))`,
    ),
    "maybe->list": symbol.define`maybe->list: a Just becomes a 1-element list; Nothing becomes '()`(
      { input: [z.value], output: [z.list(z.value)] },
      `(lambda (m) (if (just? m) (list (car (cdr m))) '()))`,
    ),
    "list->maybe": symbol.define`list->maybe: the empty list becomes Nothing; else Just of the first element`(
      { input: [z.list(z.value)], output: [z.value] },
      `(lambda (lst) (if (null? lst) (nothing) (just (car lst))))`,
    ),
    "maybe->either": symbol.define`maybe->either: a Just becomes Right; Nothing becomes Left of no-just`(
      { input: [z.value, z.value], output: [z.value] },
      `(lambda (m no-just) (if (just? m) (right (car (cdr m))) (left no-just)))`,
    ),

    // ── Either accessors / combinators ───────────────────────────────────────
    "either-ref":
      symbol.define`either-ref: unwrap a Right; on Left call the optional failure procedure with the left value (default: error)`(
        { input: [z.value], inputRest: z.lambda, output: [z.value] },
        `(lambda (e . failure)
         (cond ((right? e) (car (cdr e)))
               ((pair? failure) ((car failure) (car (cdr e))))
               (else (error "either-ref: Left"))))`,
      ),
    "either-ref/default": symbol.define`either-ref/default: unwrap a Right, or return default on Left`(
      { input: [z.value, z.value], output: [z.value] },
      `(lambda (e default) (if (right? e) (car (cdr e)) default))`,
    ),
    "either-bind": symbol.define`either-bind: monadic bind — apply f to the Right value; Left short-circuits`(
      { input: [z.value, z.lambda], output: [z.value] },
      `(lambda (e f) (if (right? e) (f (car (cdr e))) e))`,
    ),
    "either-map": symbol.define`either-map: map f over a Right, preserving Left`(
      { input: [z.lambda, z.value], output: [z.value] },
      `(lambda (f e) (if (right? e) (right (f (car (cdr e)))) e))`,
    ),
    "either->list": symbol.define`either->list: a Right becomes a 1-element list; Left becomes '()`(
      { input: [z.value], output: [z.list(z.value)] },
      `(lambda (e) (if (right? e) (list (car (cdr e))) '()))`,
    ),
    "either-swap": symbol.define`either-swap: swap a Left and a Right (errors on a non-Either)`(
      { input: [z.value], output: [z.value] },
      `(lambda (e)
         (cond ((left? e) (right (car (cdr e))))
               ((right? e) (left (car (cdr e))))
               (else (error "either-swap: not an Either"))))`,
    ),
  },
});
