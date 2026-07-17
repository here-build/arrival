/**
 * T3a — collapse-kind, the RED SUITE (test-author lane, contract-corrected 2026-07-15).
 *
 * The collapse decision is SPLIT across two functions by WHERE the combinator's
 * identity still lives (see src/extract/collapse.ts's corrected header):
 *
 *   • `buildFan` (arm-containers.ts) HOLDS the raw fn CoreForm — head identity
 *     intact. It ALONE decides "combine": iff the combinator is a bare
 *     closed-list AC head (`+ * string-append cons`) or a lambda whose raw body
 *     is exactly `(ac-head acc element)`. A RAW-COREFORM check against the
 *     closed list — never trusting a `FusedProv`, which has already forgotten
 *     the operator.
 *   • `inferCollapse` (collapse.ts) sees only the EXTRACTED body and decides the
 *     rest: **route vs lowered, NEVER combine.**
 *
 * WHY the split (this suite's original T3a finding, now the contract): `+`, `-`,
 * `*` all classify to `role:"fuse"` and extract to a BIT-IDENTICAL
 * `FusedProv{sources:[acc,element]}` — operator identity is erased before any
 * body-only view exists (verified 2026-07-15). A function of the body alone
 * cannot tell AC `+` from non-AC `-`; returning "combine" for the `+`-shape
 * returns it for the `-`-shape too (same input) and erases a non-associative
 * fold's structure. That is a forge. So "combine" is tested THROUGH buildFan
 * with REAL SOURCE (head present); "route"/"lowered" are tested against
 * `inferCollapse` with hand-built bodies.
 *
 * ── Two test surfaces, two build strategies ─────────────────────────────────
 *
 * COMBINE + adversarial rows → REAL SOURCE through the front pipeline
 * (parseSexprs → desugar → classify → extractProgram), exactly as
 * arm-control.test.ts / extract-corpus.test.ts drive it. `defaultRegistry`
 * (arm-containers.ts) already classifies every head these rows need: `+ - * /`
 * (fuse), `cons` (build/pair), `string-append` (string), `fold` (fan). The
 * assertion reads `FanProv.collapse` off the extracted circuit.
 *
 * `collapseOf(prov)` = the fan's collapse, or `null` when extraction did NOT
 * produce a Fan (today a BARE-head fold — `(fold + 0 v)` — is
 * `opaque("fan/fn-unresolvable")`, since `buildFan.resolveFanFn` can't yet
 * resolve a bare primitive head; T3a-impl grows that path AND the AC check
 * together). `null` is not "combine", so every adversarial "never combine"
 * invariant below is un-breakable across that transition.
 *
 * ROUTE + LOWERED rows → hand-built `StaticProv` fed straight to
 * `inferCollapse`. Sites are the throwaway `SITE`; fixture-corpus.ts's matcher
 * already proves this codebase treats sites as blind, and inferCollapse's
 * signature carries no NodeId-keyed side table. `element` is fixed to exactly
 * what `buildFan` constructs (`{kind:"mux", key:null, source:collection}` —
 * read from arm-containers.ts, not guessed); `acc` is a distinct `InputProv`
 * named "acc" (a fold's acc param binds to the seed's attribution — buildFan's
 * `{prov: init}` — evidence-class for a route body, not a literal).
 */
import { describe, expect, it } from "vitest";

import { classify } from "../../coreform/index.js";
import { desugar } from "../../front/desugar.js";
import { parseSexprs } from "../../front/parse.js";
import { extractProgram } from "../../extract/index.js";
import { AC_HEAD_SET, defaultRegistry } from "../../extract/arm-containers.js";
import { inferCollapse } from "../../extract/collapse.js";
import type {
  ChoiceProv,
  CollapseKind,
  ConstProv,
  FusedProv,
  InputProv,
  MuxProv,
  OpaqueProv,
  StaticProv,
} from "../../model/static-prov.js";
import type { NodeId } from "../../coreform/types.js";
import { FIXTURE_CORPUS, matches } from "./fixture-corpus.js";

// ── real-source driver (the buildFan surface) ────────────────────────────────────

const run = (src: string): StaticProv => extractProgram(classify(desugar(parseSexprs(src))).forms, defaultRegistry);

/** A Fan's collapse, or null when extraction produced something else (opaque,
 *  a non-fan). null is deliberately NOT a CollapseKind so `.not.toBe("combine")`
 *  holds trivially for today's bare-head-opaque state and still holds when
 *  T3a-impl turns these into real Fans. */
const collapseOf = (prov: StaticProv): CollapseKind | null => (prov.kind === "fan" ? prov.collapse : null);

// ── §2c regime 1: "combine" — via buildFan, REAL SOURCE, head present ───────────
//
// The CLOSED enumerated AC list, exactly four members. it.fails until T3a-impl
// teaches buildFan the raw-CoreForm AC check (today a bare AC head in fold
// position is opaque, so collapseOf is null ≠ "combine" and each row fails —
// the expected-fail state). A FIFTH member going green is a closed-list
// violation, never progress.

describe('§2c "combine" — buildFan over real source, the closed AC list (it.fails until T3a-impl)', () => {
  it("(fold + 0 v): bare AC head, seed-const — the paradigm combine case", () => {
    expect(collapseOf(run(`(fold + 0 v)`))).toBe("combine");
  });

  it("(fold * 1 v): bare AC head", () => {
    expect(collapseOf(run(`(fold * 1 v)`))).toBe("combine");
  });

  it('(fold string-append "" v): bare AC head (string monoid)', () => {
    expect(collapseOf(run(`(fold string-append "" v)`))).toBe("combine");
  });

  it("(fold cons '() v): bare AC head (list monoid)", () => {
    expect(collapseOf(run(`(fold cons '() v)`))).toBe("combine");
  });

  it("the AC list has EXACTLY 4 members — a 5th going green is a violation, not progress", () => {
    // Asserts against arm-containers.ts's OWN exported `AC_HEAD_SET`, not a
    // hand-copied duplicate of it: a duplicate can drift silently (adding a
    // 5th member to the real, unexported table used to trip nothing here,
    // since this row only ever compared the copy against itself). Reading
    // the real registry is what makes a 5th member an actual test failure.
    expect(AC_HEAD_SET.size).toBe(4);
    expect(AC_HEAD_SET).toEqual(new Set(["+", "*", "string-append", "cons"]));
  });
});

// ── the adversarial core: bodies a body-only view WOULD forge ────────────────────
//
// The whole reason for the split. These MUST be green now and green FOREVER —
// a red row here at T3a-impl time is a soundness regression, not a stub artifact.

describe('adversarial — non-AC / hidden-const folds must NEVER be "combine" (green now, un-breakable)', () => {
  it("(fold - 0 v): bare `-` — SAME FusedProv body as `+`, distinguished ONLY by the head buildFan sees", () => {
    // The load-bearing row. Today: opaque (bare head unresolvable) ⇒ collapseOf
    // null. Post-impl: buildFan sees the raw `-`, finds it NOT on the closed AC
    // list ⇒ "lowered". Either way NEVER "combine" — which a body-only
    // inferCollapse could not have guaranteed, because `(- acc x)` and `(+ acc
    // x)` extract to the identical FusedProv. This is the fix, asserted.
    expect(collapseOf(run(`(fold - 0 v)`))).not.toBe("combine");
  });

  it('(fold (lambda (acc x) (- acc x)) 0 v): explicit non-AC lambda ⇒ "lowered", never combine', () => {
    // A real Fan today (lambda resolves) with hardwired "lowered". `-` is
    // non-AC, so buildFan's lambda-body AC check (`(ac-head acc element)`)
    // rejects it forever ⇒ stays "lowered". Asserted tightly (toBe), not just
    // ≠combine, because this one has a real Fan to read now.
    expect(collapseOf(run(`(fold (lambda (acc x) (- acc x)) 0 v)`))).toBe("lowered");
  });

  it('longcat forge (fold (lambda (acc x) (if (eq? x "s") "FABRICATED" x)) "" v): "lowered" — the real forge path through buildFan', () => {
    // fixture-corpus row 3, driven end-to-end this time (the corpus asserts the
    // extracted circuit shape; here we assert its collapse specifically). The
    // body is an `if`, not `(ac-head acc element)`, so combine is never even a
    // candidate — the const behind the if stays a visible choice.
    const prov = run(`(fold (lambda (acc x) (if (eq? x "s") "FABRICATED" x)) "" v)`);
    expect(collapseOf(prov)).toBe("lowered");
    expect(collapseOf(prov)).not.toBe("combine");

    // Tie back to the frozen corpus so a drift in either file is caught here.
    const row3 = FIXTURE_CORPUS[2]!;
    expect(row3.name).toBe("hidden-const fold (longcat)");
    if (row3.expected.kind !== "fan") throw new Error("fixture-corpus row 3 changed shape — update this tie-back");
    if (prov.kind === "fan") expect(matches(prov.body, row3.expected.body)).toBe(true);
  });
});

// ── S5: element/acc recognized by IDENTITY, never by shape alone ────────────────
//
// `inferCollapse`'s `isElement` used to recognize the fan's own element
// structurally (`mux` + `key === null`) — but that exact shape is ALSO what
// `dispatchMux`'s generic branch mints for ANY dynamically-keyed projection
// whose key isn't statically known (`max-by`'s registry entry is exactly
// this: its key arg is always the comparator function, never a `Lit`, so
// `staticKeyOf` always returns null). A fold body reading `(max-by keyfn
// other-list)` over some collection OTHER than the fold's own would
// shape-match the fold's own element and mislabel as route-last — the body
// is quietly reading something unrelated, not passing the element through.

describe("S5 — a shape-matching mux from an UNRELATED collection is never mistaken for this fan's own element", () => {
  it("(fold (lambda (acc x) (max-by keyfn other-list)) 0 (list 1 2 3)): body's mux SHAPE-matches (mux, key:null) but its SOURCE is a different collection entirely — must stay lowered, never route", () => {
    const prov = run(
      `(define other-list (list 10 20 30))\n` +
        `(define (keyfn c) c)\n` +
        `(fold (lambda (acc x) (max-by keyfn other-list)) 0 (list 1 2 3))`,
    );
    expect(collapseOf(prov)).toBe("lowered");
  });
});

// ── hand-built leaves for the inferCollapse (route/lowered) surface ──────────────

const SITE = 0 as unknown as NodeId;
const XS: InputProv = { kind: "input", site: SITE, name: "xs" };
const element: MuxProv = { kind: "mux", site: SITE, key: null, source: XS };
const ACC: InputProv = { kind: "input", site: SITE, name: "acc" };
const constNode = (): ConstProv => ({ kind: "const", site: SITE });
const fused = (...sources: readonly StaticProv[]): FusedProv => ({ kind: "fused", site: SITE, sources });

// ── §2c regime 2: "route" — inferCollapse over dnf@Fan bodies ────────────────────
//
// inferCollapse's own domain. it.fails until T3a-impl (the stub is always
// "lowered"); these flip to real "route" then.

describe('§2c "route" — inferCollapse over dnf@Fan bodies (it.fails until T3a-impl)', () => {
  it("(fold max s v) body: choice{guards:[compare(acc,element)], alts:[acc,element]} — both candidates stay gray", () => {
    const body: ChoiceProv = { kind: "choice", site: SITE, guards: [fused(ACC, element)], alts: [ACC, element] };
    expect(inferCollapse(body, element, ACC)).toBe("route");
  });

  it("(fold min s v) body: same dnf@Fan shape — route is direction-blind (min/max share the regime, not a type)", () => {
    const body: ChoiceProv = { kind: "choice", site: SITE, guards: [fused(ACC, element)], alts: [ACC, element] };
    expect(inferCollapse(body, element, ACC)).toBe("route");
  });

  it("(λ (acc x) x): body IS element, acc wholly unreferenced ⇒ route-last", () => {
    expect(inferCollapse(element, element, ACC)).toBe("route");
  });

  it("(λ (acc x) acc): body IS acc, element wholly unreferenced ⇒ route-init", () => {
    expect(inferCollapse(ACC, element, ACC)).toBe("route");
  });

  it("filter-survivor mask: choice{guards:[pred-over-element], alts:[element]} — single alt, no swappable else", () => {
    const body: ChoiceProv = { kind: "choice", site: SITE, guards: [fused(element)], alts: [element] };
    expect(inferCollapse(body, element, ACC)).toBe("route");
  });
});

// ── §2c fail-closed: inferCollapse bodies that stay "lowered" ────────────────────
//
// Green under the stub already, green forever. inferCollapse can only ever make
// "lowered" MORE precise into "route"; "combine" is not in its codomain at all.

describe('§2c fail-closed — inferCollapse ⇒ "lowered" forever (plain it, green under the stub)', () => {
  const LOWERED_ROWS: readonly { readonly name: string; readonly body: StaticProv }[] = [
    {
      name: "longcat body hand-built: choice{guards:[*], alts:[const, *]} — the FATAL forge shape, matches fixture-corpus row 3 body",
      body: { kind: "choice", site: SITE, guards: [fused(element, constNode())], alts: [constNode(), element] },
    },
    {
      name: "(- acc x) body: Fused(acc, element) — inferCollapse SEES the same shape as `+` and MUST NOT combine (it structurally cannot; lowered is right)",
      body: fused(ACC, element),
    },
    {
      name: "const smuggled into the element slot: Fused(acc, const) — no seed exemption reaches here",
      body: fused(ACC, constNode()),
    },
    {
      name: "const riding alongside a legitimate fuse: Fused(acc, element, const) — 3rd source disqualifies",
      body: fused(ACC, element, constNode()),
    },
    {
      name: "const behind a nested choice on a content path: Fused(acc, choice{alts:[const, element]}) — buried, still lowered",
      body: fused(ACC, { kind: "choice", site: SITE, guards: [element], alts: [constNode(), element] } satisfies ChoiceProv),
    },
    {
      name: "opaque-bearing body: Fused(acc, opaque) — unresolvable anywhere forces fail-closed",
      body: fused(ACC, { kind: "opaque", site: SITE, reason: "unknown-head/mystery" } satisfies OpaqueProv),
    },
  ];

  it(`selects exactly ${LOWERED_ROWS.length} fail-closed rows (not accidentally fewer)`, () => {
    expect(LOWERED_ROWS).toHaveLength(6);
  });

  for (const row of LOWERED_ROWS) {
    it(row.name, () => {
      expect(inferCollapse(row.body, element, ACC)).toBe("lowered");
    });
  }

  it("longcat body ties back to fixture-corpus row 3 (drift in either file fails here)", () => {
    const body: ChoiceProv = { kind: "choice", site: SITE, guards: [fused(element, constNode())], alts: [constNode(), element] };
    const row3 = FIXTURE_CORPUS[2]!;
    if (row3.expected.kind !== "fan") throw new Error("fixture-corpus row 3 changed shape — update this tie-back");
    expect(matches(body, row3.expected.body)).toBe(true);
  });
});

// ── the contract pin: inferCollapse can NEVER return "combine" ───────────────────

describe("contract — inferCollapse is route|lowered only (the erasure is WHY)", () => {
  it("the `+`-body Fused(acc, element): inferCollapse returns route-or-lowered, provably never combine", () => {
    // This is the exact FusedProv that `(+ acc x)` AND `(- acc x)` both extract
    // to — operator identity already gone. inferCollapse, seeing only this,
    // cannot tell them apart, so it CANNOT soundly answer "combine" for either
    // (that would forge `-`). The contract makes "combine" not its call at all;
    // this row pins that the answer stays inside {route, lowered}.
    const body: FusedProv = fused(ACC, element);
    const result = inferCollapse(body, element, ACC);
    expect(["route", "lowered"] satisfies readonly CollapseKind[]).toContain(result);
    expect(result).not.toBe("combine");
  });
});
