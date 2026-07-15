/**
 * Higher-order / callable-as-value callee resolution — RED-FIRST gate for
 * `arm-control.ts`'s `resolveCallee` (2026-07-15).
 *
 * THE GAP: a function passed as a PARAMETER and then called opaqued. GEPA's
 * `iterate` (`(define (iterate step pool n) (if (zero? n) pool (iterate step
 * (step pool) (- n 1))))`) passes `generation`/`assess` as `step`, then calls
 * `(step pool)` — `step`'s scope binding was `{expr: Ref("generation"),
 * scope}`, a Ref bound to ANOTHER Ref, not directly to a Lambda/DefineFn.
 * `extractApp`'s Ref-callee branch checked only ONE level (`bound.expr.kind
 * === "DefineFn" || "Lambda"`) before falling to `opaque("unknown-callee")` —
 * it never chased a second hop to find the DefineFn `generation` actually is.
 * This hollowed out GEPA's evolutionary loop: everything inside `(step
 * pool)` — the whole `generation`/`mutate`/`reflect` subtree, a SECOND
 * `infer/chat` crossing — vanished behind that one opaque node (see
 * `gepa-heads.test.ts`'s header for the full pre-fix account and its now-
 * flipped `it.fails` row).
 *
 * THE FIX: `resolveCallee` chases a callee Ref through however many
 * ref-to-ref hops it takes to bottom out on a DefineFn/Lambda (beta-reduce
 * it), a free name (dispatch it through the registry, same as today's direct
 * free-Ref path), or anything else (stay opaque — never guess). Sound
 * because refs are immutable in this dialect (no `set!` — the
 * arrival-immutable-no-dynamics law): a name resolving to a name resolving
 * to a DefineFn IS that DefineFn, so chasing it is identical to calling it
 * directly. A repeat hop (a definitional ref cycle) fails closed via a small
 * cycle guard mirroring `extractRef`'s (arm-atoms.ts) own — bounded, never a
 * hang.
 *
 * REGRESSION NOTE: this fix also flips `gepa-heads.test.ts`'s `it.fails` row
 * (the SECOND `infer/chat` crossing is now reachable) and corrects one stale
 * expected `opaque` reason string in `recursion-fan.test.ts`'s "gepa-shaped
 * counting loop" row (its callee `f` is genuinely free/undefined in that
 * repro, so it now resolves via the chase to `unknown-head/f` instead of the
 * pre-fix `unknown-callee` wall it used to hit before the chase existed —
 * neither is a logic regression, both are the fix's own necessary,
 * fixture-confirmed fallout).
 */
import { describe, expect, it } from "vitest";

import { classify } from "../../coreform/index.js";
import { desugar } from "../../front/desugar.js";
import { parseSexprs } from "../../front/parse.js";
import { extractProgram } from "../../extract/index.js";
import { defaultRegistry } from "../../extract/arm-containers.js";
import { dataShaped } from "../../verdict/circuit-verdict.js";
import type { StaticProv } from "../../model/static-prov.js";

const run = (src: string): StaticProv => {
  const { forms } = classify(desugar(parseSexprs(src)));
  return extractProgram(forms, defaultRegistry);
};

/** Walk the WHOLE circuit (every child of every kind, mirroring
 *  `recursion-fan.test.ts`'s own local `walk`) — the adversarial/regression
 *  rows below need "is `unknown-callee` reachable ANYWHERE", not just at the
 *  root, since a resolved callee's body can bury an unrelated opaque deeper
 *  down. Exhaustive over `StaticProv.kind` (tsc's no-default-arm check is the
 *  totality proof, same discipline `extract`'s own dispatcher holds). */
function hasOpaqueReason(prov: StaticProv, reason: string): boolean {
  switch (prov.kind) {
    case "opaque":
      return prov.reason === reason;
    case "input":
    case "const":
      return false;
    case "mint":
      return prov.closed.some((c) => hasOpaqueReason(c, reason));
    case "fused":
      return prov.sources.some((s) => hasOpaqueReason(s, reason));
    case "mux":
      return hasOpaqueReason(prov.source, reason);
    case "build":
      return prov.parts.some((p) => hasOpaqueReason(p.prov, reason));
    case "string":
      return prov.runs.some((r) => hasOpaqueReason(r, reason));
    case "choice":
      return prov.guards.some((g) => hasOpaqueReason(g, reason)) || prov.alts.some((a) => hasOpaqueReason(a, reason));
    case "fan":
      return hasOpaqueReason(prov.collection, reason) || hasOpaqueReason(prov.body, reason);
  }
}

// ── POSITIVE ─────────────────────────────────────────────────────────────────

describe("POSITIVE — a callee-param chases through a ref-to-ref hop, no longer opaque(unknown-callee)", () => {
  it("twice/inc: `f` (bound to Ref(inc)) resolves through the ref chase — root is a fused, not opaque", () => {
    // The exact isolated repro `gepa-heads.test.ts` cites as the pre-fix
    // GENERAL reproduction (no GEPA machinery at all): `twice`'s `f` param is
    // bound to `Ref("inc")`, one hop removed from the DefineFn `inc` actually
    // is. Before the fix this whole program was a single
    // `opaque("unknown-callee")`.
    const prov = run(`(define (twice f x) (f (f x)))\n(define (inc y) (+ y 1))\n(twice inc 5)`);
    expect(prov.kind).not.toBe("opaque");
    expect(prov.kind).toBe("fused");
    // The property THIS fix owns: the callee resolution itself never hits
    // unknown-callee anywhere in the tree. (The inner `(f x)` independently
    // hits the PRE-EXISTING, unrelated `cyclic-binding` guard — `inc`'s own
    // reduction is still "on the stack" while its deferred `y` argument,
    // itself a nested call to `inc`, gets extracted from inside that same
    // reduction frame. That guard is orthogonal to this fix and still sound:
    // opaque is always a correct answer, and betaReduce's own cyclic-binding
    // reason is untouched by this change — see arm-control.test.ts's
    // "recursive fn hits the cycle guard" row for that guard's own direct
    // coverage.)
    expect(hasOpaqueReason(prov, "unknown-callee")).toBe(false);
  });

  it("the GEPA shape: a tail-fold's accumulator update calls its OWN callee-param through the chase — the body is reachable, not opaque(unknown-callee)", () => {
    // `step-it`'s `f` param is bound to `Ref("evaluate")` — one hop removed
    // from the DefineFn `evaluate` — exactly `iterate`'s `step`/`generation`
    // shape in the real GEPA program (see this file's header +
    // gepa-heads.test.ts's now-flipped row for the full-program account).
    const prov = run(
      `(define (evaluate instr) (map (lambda (x) instr) examples))\n` +
        `(define (step-it f pool n) (if (zero? n) pool (step-it f (f pool) (- n 1))))\n` +
        `(define examples (list 1 2))\n` +
        `(step-it evaluate "seed" 2)`,
    );
    expect(prov.kind).not.toBe("opaque");
    // `step-it` is itself a recognized tail-fold (arm-control.ts's
    // `recognizeTailFold`) — its root lifts to a FanProv whose `body` is the
    // accumulator's update expression, `(f pool)`. Before this fix that body
    // was unconditionally `opaque("unknown-callee")` (the exact GEPA gap);
    // now it resolves through the chase and surfaces a nested fan/mux
    // instead (asserted via `hasOpaqueReason`, not a structural pattern —
    // the ASSERTION this row exists to make is "the `(f pool)` call is no
    // longer opaque-unknown-callee", not a specific shape past that).
    expect(prov.kind).toBe("fan");
    expect(hasOpaqueReason(prov, "unknown-callee")).toBe(false);
  });
});

// ── ADVERSARIAL — the rows that MUST hold (a wrong chase is a forge) ───────

describe("ADVERSARIAL — soundness: a wrong chase is a forge, so these MUST stay opaque/terminate", () => {
  it("a computed/dynamic callee reached through the chase (a param bound to a non-Ref, non-DefineFn expr) stays opaque(unknown-callee) — never guessed", () => {
    // `run-it`'s `f` param is bound to `Ref("g")`, but `g` itself is bound to
    // `(make-adder 5)` — an App, not a Ref and not a DefineFn/Lambda. This is
    // the callable-as-value analogue of `((pick-fn) x)`: the chase MUST stop
    // and fail closed rather than guess at what `g` might statically be.
    const prov = run(`(define (make-adder n) (+ n 1))\n(define g (make-adder 5))\n(define (run-it f x) (f x))\n(run-it g (:y e))`);
    expect(prov).toMatchObject({ kind: "opaque", reason: "unknown-callee" });
  });

  it("a ref CYCLE used as a callee (`(define a b)(define b a)`) terminates opaque(unknown-callee), never hangs", () => {
    const prov = run(`(define a b)\n(define b a)\n(a 1)`);
    expect(prov).toMatchObject({ kind: "opaque", reason: "unknown-callee" });
  });

  it("a chased call reaching a fn that hides a const behind an `if` keeps the const VISIBLE after beta-reduction — dataShaped stays false", () => {
    // `run`'s `f` param is bound to `Ref("helper")` — one hop removed from
    // the DefineFn `helper`, whose body hides a literal behind a guard (the
    // named-helper forge's own shape, one hop over: beta-reduction through a
    // chased callee must be IDENTICAL to beta-reduction through a direct
    // one — `betaReduce` itself is unchanged by this fix, so this holds, but
    // it must be ASSERTED, not assumed).
    const prov = run(`(define (helper x) (if (> x 5) "SAFE" x))\n(define (run f y) (f y))\n(run helper (:score e))`);
    expect(prov).toMatchObject({
      kind: "choice",
      guards: [{ kind: "fused" }],
      alts: [{ kind: "const" }, { kind: "mux", key: "score" }],
    });
    // The const is reachable in a CONTENT position (an `if` alt) — dataShaped
    // must fail exactly as it would for a direct (non-chased) call.
    expect(dataShaped(prov)).toBe(false);
  });
});
