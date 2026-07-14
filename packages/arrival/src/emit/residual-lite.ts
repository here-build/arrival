// emit/residual-lite — a MINIMAL, pure-data residual-BUILDER surface for Contract-side
// emit rules (constitution §4.5's own named direction: "residual TYPES belong in
// arrival core eventually", seeded here by the Phase-2 relocation drill — constitution
// §9 — rather than built in full up front).
//
// WHY THIS EXISTS. Constitution §4.5 forbids arrival core importing the compiler's
// residual constructors (`inhuman/foundations/arrival-mercury/src/residual/types.ts` —
// the OUT package; arrival core must not depend on it, only the reverse). But a
// Contract-carried `emit` rule (quotient/modulo/=, this drill's batch) still needs to
// BUILD `Bin`/`Lit`/`Method`/`Ref` shapes to hand back as its residual. This module is
// that seed: NOT the full ~29-constructor algebra (residual-renderer.md / the
// compiler's residual/types.ts still owns that in full), just the four expression
// shapes plus the `Binding` handle THIS wave's three relocated rules actually
// construct — verified by reading phase1.ts's pre-relocation `quotientRule`/
// `moduloRule`/`numEqRule` before writing this file.
//
// STRUCTURAL, NOT NOMINAL. Nothing here is imported BY the compiler, and this module
// never imports the compiler's `R`. The two types are independently declared,
// field-for-field identical (verified against residual/types.ts's own `Base`/`Binding`/
// `BinOp`/`LitValue`/`R` on every field below), so TypeScript's structural typing plus
// `EmitRule`'s bivariant method-parameter check (emit-rule.ts's own doc comment) let a
// rule built from THESE constructors satisfy the compiler's real `EmitRule<R>` — and
// let the compiler's renderer accept the returned object with zero adaptation. A future
// constructor added here that the compiler's `R` doesn't structurally recognize is a
// compile error at the CONSUMING (compiler) site, never a silent shape drift.
//
// GROWTH DISCIPLINE. Mirrors emit-rule.ts's own scoping note: seed only what a wave's
// rules exercise. Do not add a constructor here speculatively — add it in the wave
// whose rule needs it (the same per-symbol package-deal ethos phase1-symbol-rules.md
// applies to facts/rules/oracle rows). Today's set (`Ref`, `Lit`, `Bin`, `Method` +
// `Binding`) is exactly what quotient/modulo/='s relocated rules use; nothing more.

/** Opaque node-id carrier — mirrors residual/types.ts's own `NodeId = unknown` alias
 *  ("coreform-ir.md's branded pre-order node id... never constructed, never inspected
 *  here"). Nothing in this drill populates it; kept for origin-field shape parity. */
export type NodeId = unknown;

interface Base {
  readonly origin?: NodeId;
}

/** Mirrors residual/types.ts's `BinOp` verbatim (the FULL union, not just the five
 *  operators this drill's three rules use) — a rule landing in this same file later
 *  needs no widening of this alias. */
export type BinOp =
  | "+" | "-" | "*" | "/" | "%" | "**"
  | "===" | "!==" | "<" | "<=" | ">" | ">="
  | "&&" | "||" | "??"
  | "&" | "|" | "^" | "<<" | ">>" | ">>>"
  | "in" | "instanceof";

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

/**
 * The residual shapes THIS drill's three rules (quotient/modulo/=) construct — `Ref`,
 * `Lit`, `Bin`, `Method` — field-for-field identical to residual/types.ts's own `R`
 * variants of the same tag. Deliberately NOT the full ~29-constructor union (see the
 * module header); a rule needing a shape absent here is out of scope for this drill.
 */
export type R =
  | (Base & { readonly t: "Ref"; readonly binding: Binding })
  | (Base & { readonly t: "Lit"; readonly value: LitValue })
  | (Base & { readonly t: "Bin"; readonly op: BinOp; readonly left: R; readonly right: R })
  | (Base & { readonly t: "Method"; readonly recv: R; readonly name: string; readonly args: readonly R[] });

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
 *  `null`/`undefined`/`bigint` arms are unreached by this drill's three rules today;
 *  kept for shape parity with the mirrored source, not speculative growth). */
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

export function Bin(op: BinOp, left: R, right: R): R {
  return { t: "Bin", op, left, right };
}

export function Method(recv: R, name: string, args: readonly R[]): R {
  return { t: "Method", recv, name, args };
}
