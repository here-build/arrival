// emit/residual-lite — a MINIMAL, pure-data residual-BUILDER surface for Contract-side
// emit rules (constitution §4.5's own named direction: "residual TYPES belong in
// arrival core eventually", seeded here by the Phase-2 relocation drill — constitution
// §9 — rather than built in full up front).
//
// WHY THIS EXISTS. Constitution §4.5 forbids arrival core importing the compiler's
// residual constructors (`inhuman/foundations/arrival-mercury/src/residual/types.ts` —
// the OUT package; arrival core must not depend on it, only the reverse). But a
// Contract-carried `emit` rule (quotient/modulo/=, cons/not/null?/pair?/+/-/*//, and
// this wave's map/filter/apply) still needs to BUILD `Bin`/`Lit`/`Method`/`Ref`/`Un`/
// `Call`/`Member`/`ArrayLit`/`Spread`/`Arrow`/`Index` shapes to hand back as its
// residual. This module is that seed: NOT the full ~29-constructor algebra
// (residual-renderer.md / the compiler's residual/types.ts still owns that in full),
// just the expression shapes plus the `Binding` handle the relocated rules actually
// construct — verified by reading phase1.ts's pre-relocation rule bodies before
// growing this file each wave.
//
// STRUCTURAL, NOT NOMINAL. Nothing here is imported BY the compiler, and this module
// never imports the compiler's `R`. The two types are independently declared,
// field-for-field identical (verified against residual/types.ts's own `Base`/`Binding`/
// `BinOp`/`UnOp`/`LitValue`/`Param`/`R` on every field below), so TypeScript's
// structural typing plus `EmitRule`'s bivariant method-parameter check (emit-rule.ts's
// own doc comment) let a rule built from THESE constructors satisfy the compiler's
// real `EmitRule<R>` — and let the compiler's renderer accept the returned object with
// zero adaptation. A future constructor added here that the compiler's `R` doesn't
// structurally recognize is a compile error at the CONSUMING (compiler) site, never a
// silent shape drift. `EmitCtx<R>.runtime(sym): R` is generic over THIS file's own
// `R`, so a rule that MINTS a runtime reference via `ctx.runtime(...)` gets back a
// value already typed `R` by the interface signature alone — no constructor of ours
// is needed for THAT value to flow into e.g. `Call`'s `callee: R` parameter (identity
// assignment, not a shape check). Confirmed by `null?`/`pair?`'s shim arm and by `tsc`
// on this package. **This wave's `apply` rule needs something different — INSPECTING,
// not minting** — see the `RuntimeRef` arm's own doc comment on the `R` union below
// for why that's a genuinely new need this file's growth discipline didn't anticipate
// in words (though it's the same discipline in spirit).
//
// GROWTH DISCIPLINE. Mirrors emit-rule.ts's own scoping note: seed only what a wave's
// rules exercise. Do not add a constructor here speculatively — add it in the wave
// whose rule needs it (the same per-symbol package-deal ethos phase1-symbol-rules.md
// applies to facts/rules/oracle rows). Today's set — `Ref`, `Lit`, `Bin`, `Method`,
// `Un`, `Call`, `Member`, `ArrayLit`, `Spread`, `Arrow`, `Index` + `Binding`/`Param` —
// is exactly what quotient/modulo/='s, cons/not/null?/pair?/+/-/*//'s, and
// map/filter/apply's relocated rules use; nothing more. `RuntimeRef` joins the `R`
// union as a TYPE ARM ONLY (no constructor — see its own doc comment below): the one
// item in this wave's growth that isn't "a shape some rule constructs."
//
// E2b ADDITION (arrival-mercury engine plan §2 E2, second half): `ChunkExpr` joins the
// `R` union, ALSO as a TYPE ARM ONLY, for the same reason `RuntimeRef` did — a Contract
// rule MAY need to return the compiler's hybrid-tree hard chunk (mercury-ir.md;
// `inhuman/foundations/arrival-mercury/src/residual/types.ts`'s own `ChunkExpr`) as its
// residual, but the value would be MINTED by that compiler-package constructor (the
// only one that imports `typescript` to build a real `ts.Node` — `residual/chunk.ts`),
// never by anything in this arrival-core file (module header: "nothing here is ever
// mutated... never a real `typescript` import here"). Structural typing (this file's
// own STRUCTURAL, NOT NOMINAL discipline) is what lets that externally-minted value
// satisfy `EmitRule<R>` here without this file needing to construct one itself.
// Verified safe to consume, not merely type-legal: arrival-mercury's own
// `__tests__/chunk.test.ts` proves a rule-returned `ChunkExpr` round-trips through
// walk/asyncness/render — the walker's slots-are-never-leaves discipline (E2a) already
// covers a RULE-minted chunk exactly like a fold-site-minted one. No Contract rule in
// this wave's set actually returns one (verified against every relocated rule this file
// backs — quotient/modulo/=, cons/not/null?/pair?/+/-/*//, map/filter/apply, the infer
// family), so — this file's own growth discipline — only the type acceptance lands;
// the constructor waits for the wave whose rule needs to mint one. `ChunkStmt` does
// NOT join: `EmitRule.call` only ever returns an EXPRESSION-position residual (emit-
// rule.ts: "Application position... → residual"), so a statement-position chunk has no
// legal way to reach this surface at all.

/** Opaque node-id carrier — mirrors residual/types.ts's own `NodeId = unknown` alias
 *  ("coreform-ir.md's branded pre-order node id... never constructed, never inspected
 *  here"). Nothing in this drill populates it; kept for origin-field shape parity. */
export type NodeId = unknown;

/** Opaque carrier for a verbatim `ts.Node` subtree — mirrors residual/types.ts's own
 *  `OpaqueTsNode = unknown` alias verbatim (E2b, this module's header). Nothing in
 *  THIS file ever constructs one — the compiler package's `residual/chunk.ts` is the
 *  only module that imports `typescript` to build a real value here. */
export type OpaqueTsNode = unknown;

/** A slot identifier — mirrors residual/types.ts's own `SlotId = string` alias
 *  verbatim (E2b, this module's header). */
export type SlotId = string;

interface Base {
  readonly origin?: NodeId;
}

/** Mirrors residual/types.ts's `BinOp` verbatim (the FULL union, not just the
 *  operators any one wave's rules use) — a rule landing in this same file later needs
 *  no widening of this alias. */
export type BinOp =
  | "+" | "-" | "*" | "/" | "%" | "**"
  | "===" | "!==" | "<" | "<=" | ">" | ">="
  | "&&" | "||" | "??"
  | "&" | "|" | "^" | "<<" | ">>" | ">>>"
  | "in" | "instanceof";

/** Mirrors residual/types.ts's `UnOp` verbatim (the FULL union, not just `!`/`-` —
 *  today's `not`/unary-`-` rules — mirroring `BinOp`'s own full-union rationale
 *  above). */
export type UnOp = "!" | "-" | "+" | "~" | "typeof" | "void";

/** Mirrors residual/types.ts's `LitValue` verbatim, field-for-field. */
export type LitValue =
  | { readonly k: "string"; readonly value: string }
  | { readonly k: "number"; readonly value: number }
  | { readonly k: "bigint"; readonly value: bigint }
  | { readonly k: "boolean"; readonly value: boolean }
  | { readonly k: "null" }
  | { readonly k: "undefined" };

/** Mirrors residual/types.ts's `Binding` verbatim — the namer-resolved identifier
 *  handle `Ref(binding)` wraps. Merges with the constructor function of the same name
 *  below (the same type+value merge residual/types.ts itself uses). */
export interface Binding extends Base {
  readonly t: "Binding";
  readonly text: string;
}

/** Mirrors residual/types.ts's `Param` — narrowed to `pattern: Binding` (this wave's
 *  rules — map's zip arrow, filter's guard arrow, apply's fold-reduce arrow — only
 *  ever mint a fresh/lexical Binding as an arrow parameter; none destructures a
 *  parameter into an `ArrayPattern`/`RestBinding`, and none annotates a slot with a
 *  per-parameter `type`). Omitting the optional `type` field entirely is still
 *  structurally assignable to residual/types.ts's real `Param` (`{ pattern: Pattern;
 *  type?: TsType }`) — a missing OPTIONAL field is not a shape mismatch. Growth
 *  discipline: widen to the full `Pattern`/`Param` shape only when a rule needs it —
 *  do not pre-build `ArrayPattern`/`RestBinding`/`TsType` machinery speculatively. */
export interface Param {
  readonly pattern: Binding;
}

/**
 * The residual shapes the relocated rules (quotient/modulo/= — Wave 1; cons/not/
 * null?/pair? plus the four arithmetic ops — Wave 2; map/filter/apply — Wave 3)
 * construct — `Ref`, `Lit`, `Bin`, `Method`, `Un`, `Call`, `Member`, `ArrayLit`,
 * `Spread`, `Arrow`, `Index` — field-for-field identical to residual/types.ts's own
 * `R` variants of the same tag. Deliberately NOT the full ~29-constructor union (see
 * the module header); a rule needing a shape absent here is out of scope until its
 * own wave grows it.
 */
export type R =
  | (Base & { readonly t: "Ref"; readonly binding: Binding })
  | (Base & { readonly t: "Lit"; readonly value: LitValue })
  | (Base & { readonly t: "Call"; readonly callee: R; readonly args: readonly R[] })
  | (Base & { readonly t: "Method"; readonly recv: R; readonly name: string; readonly args: readonly R[] })
  | (Base & { readonly t: "Index"; readonly recv: R; readonly index: R })
  | (Base & { readonly t: "Member"; readonly recv: R; readonly name: string })
  | (Base & { readonly t: "Bin"; readonly op: BinOp; readonly left: R; readonly right: R })
  | (Base & { readonly t: "Un"; readonly op: UnOp; readonly arg: R })
  | (Base & { readonly t: "Arrow"; readonly params: readonly Param[]; readonly body: R; readonly async?: boolean })
  | (Base & { readonly t: "ArrayLit"; readonly elements: readonly R[] })
  | (Base & { readonly t: "Spread"; readonly value: R })
  /**
   * TYPE ARM ONLY — no constructor below mints one (see the module header's WHY THIS
   * EXISTS / STRUCTURAL, NOT NOMINAL paragraphs). Every PRIOR wave's rules only ever
   * MINTED a runtime reference via `ctx.runtime(sym): R` (generic over this file's own
   * `R` — no arm needed for that flow). This wave's `apply` rule does something
   * structurally different: it INSPECTS an already-lowered ARGUMENT residual's own
   * tag (`f.t === "RuntimeRef"`, then reads `f.symbol`) to recognize the `+`/`*` shim
   * value apply's own fold-recognition depends on (constitution §6's
   * preserved-knowledge row — `(apply + xs)` → a reduce with the correct identity).
   * That incoming value is genuinely minted by the WALKER engine (via
   * residual/types.ts's own `RuntimeRef` constructor, when a shim-refPolicy symbol
   * resolves in value position) — never by anything in this file — so this arm
   * carries no paired constructor, unlike every other arm here, which exists ONLY
   * because some rule in this wave BUILDS it. Omitting this arm would make
   * `f.t === "RuntimeRef"` a TS2367 error (no overlap between the compared literal
   * and this union's tag set) the moment `apply`'s rule is typed against THIS file's
   * `R` instead of the compiler's real one — a first-of-its-kind need (inspecting,
   * not minting) this wave surfaces.
   */
  | (Base & { readonly t: "RuntimeRef"; readonly symbol: string })
  /**
   * TYPE ARM ONLY — no constructor below mints one (E2b, this module's header —
   * same discipline as the `RuntimeRef` arm just above). Field-for-field identical
   * to residual/types.ts's own `ChunkExpr` (`ast` required, `slots` optional). The
   * compiler package's real `ChunkExpr(...)` constructor (residual/types.ts) is the
   * only mint site that exists anywhere; a value it produces is structurally
   * assignable here with zero adaptation, which is all a Contract rule needs to
   * hand one back through `EmitRule<R>`'s bivariant `call`.
   */
  | (Base & { readonly t: "ChunkExpr"; readonly ast: OpaqueTsNode; readonly slots?: ReadonlyMap<SlotId, R> });

// ─── Constructor functions — pure data, positional, field order matching
// residual/types.ts's own constructors of the same name exactly. These are the ONLY
// sanctioned way to build a residual-lite value (no raw object literals at rule call
// sites) — the same discipline residual/types.ts documents for its own constructors. ──

/** Namer-adapter seam: mints the resolved-identifier handle. A rule that needs a fresh
 *  local normally goes through `EmitCtx.fresh` instead; this constructor is for the
 *  rare minted-GLOBAL case (quotient's `Math`, mirroring the walker's `Error`
 *  door-throw precedent — see numeric.ts's own doc comment on the rule). */
export function Binding(text: string): Binding {
  return { t: "Binding", text };
}

export function Ref(binding: Binding): R {
  return { t: "Ref", binding };
}

/** Smart constructor: infers the `LitValue` tag from the JS value, so call sites write
 *  bare `Lit(0)` / `Lit(false)`. Verbatim shape of residual/types.ts's own `Lit` (the
 *  `null`/`undefined`/`bigint` arms are unreached by the relocated rules today; kept
 *  for shape parity with the mirrored source, not speculative growth). */
export function Lit(value: string | number | bigint | boolean | null | undefined): R {
  const v: LitValue =
    value === null ? { k: "null" }
    : value === undefined ? { k: "undefined" }
    : typeof value === "string" ? { k: "string", value }
    : typeof value === "number" ? { k: "number", value }
    : typeof value === "bigint" ? { k: "bigint", value }
    : { k: "boolean", value };
  return { t: "Lit", value: v };
}

export function Call(callee: R, args: readonly R[]): R {
  return { t: "Call", callee, args };
}

export function Method(recv: R, name: string, args: readonly R[]): R {
  return { t: "Method", recv, name, args };
}

export function Index(recv: R, index: R): R {
  return { t: "Index", recv, index };
}

export function Member(recv: R, name: string): R {
  return { t: "Member", recv, name };
}

export function Bin(op: BinOp, left: R, right: R): R {
  return { t: "Bin", op, left, right };
}

export function Un(op: UnOp, arg: R): R {
  return { t: "Un", op, arg };
}

/** Ergonomic constructor mirroring residual/types.ts's own `Arrow`/`toParam` sugar,
 *  narrowed to the Binding-only case every rule in this wave constructs (map's
 *  multi-list zip arrow, filter's guard arrow, apply's fold-reduce arrow — none ever
 *  destructures a parameter or annotates one with a `type`); widen alongside `Param`
 *  above if a future rule needs more. */
export function Arrow(params: readonly Binding[], body: R, async?: boolean): R {
  return { t: "Arrow", params: params.map((pattern) => ({ pattern })), body, async };
}

export function ArrayLit(elements: readonly R[]): R {
  return { t: "ArrayLit", elements };
}

export function Spread(value: R): R {
  return { t: "Spread", value };
}
