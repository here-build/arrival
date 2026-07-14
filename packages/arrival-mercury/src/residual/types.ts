/**
 * The Residual algebra — the compiler's internal target language (constitution §3.4,
 * residual-renderer.md §2). Pure data: this module imports nothing from `typescript`;
 * emit rules and the engine walker construct these values via the constructor FUNCTIONS
 * below (never raw object literals) and never touch `ts.factory`, parenthesization, or
 * comment placement. Every "how does this print" question terminates in ./render.ts, once.
 *
 * Frozen small (~29 R constructors + 6 Decl constructors): additions require a
 * demonstrated emit-rule need + renderer support + oracle coverage. (The 29th, the
 * statement-position `If`, landed with the engine walker under exactly that rule —
 * see its constructor's doc for the demonstrated need.)
 */

/** coreform-ir.md's branded pre-order node id. Carried opaquely — never constructed,
 *  never inspected here; resolves to a source span via coreform-ir.md's table. */
export type NodeId = unknown;

interface Base {
  readonly origin?: NodeId;
}

/**
 * The namer-resolved JS identifier handle `Ref(binding)` / `EmitCtx.fresh()` produce.
 * Nominal to constructing code (rules never mint one by hand — the namer adapter does),
 * but concrete enough for the renderer to print: `text` is the final, collision-resolved
 * identifier. (residual-renderer.md leaves this opaque; the renderer structurally needs
 * the resolved text, so this greenfield package pins the minimal honest shape.)
 */
export interface Binding extends Base {
  readonly t: "Binding";
  readonly text: string;
}

export type BinOp =
  | "+" | "-" | "*" | "/" | "%" | "**"
  | "===" | "!==" | "<" | "<=" | ">" | ">="
  | "&&" | "||" | "??"
  | "&" | "|" | "^" | "<<" | ">>" | ">>>"
  | "in" | "instanceof";

export type UnOp = "!" | "-" | "+" | "~" | "typeof" | "void";

/** `bigint` is host-value infrastructure (a viem-style API residual can need a bigint
 *  literal); scheme numerics never produce one (one-number RATIO law). */
export type LitValue =
  | { readonly k: "string"; readonly value: string }
  | { readonly k: "number"; readonly value: number }
  | { readonly k: "bigint"; readonly value: bigint }
  | { readonly k: "boolean"; readonly value: boolean }
  | { readonly k: "null" }
  | { readonly k: "undefined" };

/**
 * Output-annotation type language. Related to, but deliberately NOT identical to,
 * type-infer.ts's `Ty`: no `lit` member (rvalue-only), `ref.args` added (generic
 * instantiation — `Promise<T>`), `prim.name` widened with bigint/void, and
 * `shape.fields` is ordered tuples (never a Map) so renderer output order is the
 * input order by construction (§4.7 determinism).
 */
export type TsType =
  | { readonly k: "unknown" }
  | { readonly k: "prim"; readonly name: "number" | "string" | "boolean" | "bigint" | "void" }
  | { readonly k: "array"; readonly el: TsType }
  | { readonly k: "shape"; readonly fields: readonly (readonly [string, TsType])[] }
  | { readonly k: "ref"; readonly name: string; readonly args?: readonly TsType[] }
  | { readonly k: "union"; readonly members: readonly TsType[] }; // pre-sorted upstream — renderer never re-sorts

export type Pattern = Binding | ArrayPattern | RestBinding;

export interface ArrayPattern {
  readonly t: "ArrayPattern";
  readonly elements: readonly Pattern[];
}

/** Legal ONLY as the last element of an ArrayPattern, or as the last Param's pattern.
 *  No ObjectPattern — arrival has no destructuring-at-declaration-site source form. */
export interface RestBinding {
  readonly t: "RestBinding";
  readonly binding: Binding;
}

/**
 * A function-parameter slot: a binding shape plus its OPTIONAL per-slot type.
 * NOT a member of `R` (patterns are a disjoint grammar from expressions — `Annotated`
 * structurally cannot reach a parameter), so the per-slot type needs its own carrier.
 */
export interface Param {
  readonly pattern: Pattern;
  readonly type?: TsType;
}

export type ObjectEntry =
  | { readonly kind: "prop"; readonly key: string; readonly value: R }
  | { readonly kind: "spread"; readonly value: R }; // → createSpreadAssignment, NOT the Spread R-node

/**
 * The `R` union. Notes pinned by the constitution:
 * - No raw-text node — hygiene by construction; every name is a `Ref`/`RuntimeRef`.
 * - No `Try` — `guard` doors in v1; `Try` is a Phase-2, demand-driven design.
 * - `Let`/`Assign`/target-position `ArrayPattern` are engine-minted TCO/loop machinery
 *   only (the language has no user mutation); documented, not enforced here.
 * - `Await` is engine-minted (Law W) or renderer-IIFE-synthesized — never rule-minted.
 * - `Block` is the one position-polymorphic node: statement position → bare block,
 *   expression position → IIFE (async-awaited inline when it contains an Await).
 */
export type R =
  | (Base & { t: "Ref"; binding: Binding })
  | (Base & { t: "RuntimeRef"; symbol: string })
  | (Base & { t: "Lit"; value: LitValue })
  | (Base & { t: "Template"; quasis: readonly string[]; exprs: readonly R[] }) // quasis.length === exprs.length+1
  | (Base & { t: "Call"; callee: R; args: readonly R[] })
  | (Base & { t: "New"; callee: R; args: readonly R[] }) // args REQUIRED (never absent) — `new Foo()` prints safe before `.prop`
  | (Base & { t: "Method"; recv: R; name: string; args: readonly R[] })
  | (Base & { t: "Index"; recv: R; index: R })
  | (Base & { t: "Member"; recv: R; name: string })
  | (Base & { t: "Bin"; op: BinOp; left: R; right: R })
  | (Base & { t: "Un"; op: UnOp; arg: R })
  | (Base & { t: "Cond"; test: R; then: R; else: R })
  | (Base & { t: "Arrow"; params: readonly Param[]; body: R; async?: boolean })
  | (Base & { t: "ArrayLit"; elements: readonly R[] }) // an element MAY be a `Spread` node
  | (Base & { t: "ObjectLit"; entries: readonly ObjectEntry[] })
  | (Base & { t: "Spread"; value: R }) // legal only inside ArrayLit.elements / Call.args / New.args
  | (Base & { t: "Await"; value: R }) // engine-minted only — Law W
  | (Base & { t: "Block"; stmts: readonly R[] }) // position-polymorphic — see render.ts
  | (Base & { t: "Const"; pattern: Pattern; init: R })
  | (Base & { t: "Let"; pattern: Pattern; init: R })
  | (Base & { t: "Assign"; pattern: Pattern; value: R })
  | (Base & { t: "Return"; value?: R })
  | (Base & { t: "While"; test: R; body: Extract<R, { t: "Block" }> })
  | (Base & { t: "ForOf"; pattern: Pattern; iterable: R; body: Extract<R, { t: "Block" }> })
  | (Base & { t: "Continue" }) // no label — innermost loop, by construction
  | (Base & { t: "If"; test: R; then: Extract<R, { t: "Block" }>; else?: R }) // statement-only; `else` is a Block or a chained If (render-asserted)
  | (Base & { t: "Throw"; value: R })
  | (Base & { t: "Comment"; text: string; node: R }) // LEADING block comment only
  | (Base & { t: "Annotated"; value: R; type: TsType }); // legal shapes pinned in render.ts

export interface ImportName {
  readonly imported: string;
  readonly local?: string; // only when aliased
}

/**
 * The declaration layer (module frame) — disjoint from `R`, consumed only by
 * FRAME/renderer; keeping module structure out of `R` stops the expression algebra
 * creeping toward "all of TS". `FnDecl`/`ConstDecl` carry `returnType`/`type` directly
 * (a `Decl` is never wrapped by `Annotated`, so it needs its own field).
 */
export type Decl =
  | (Base & {
      t: "FnDecl";
      name: Binding;
      params: readonly Param[];
      body: Extract<R, { t: "Block" }>;
      async?: boolean;
      returnType?: TsType;
    })
  | (Base & { t: "ConstDecl"; name: Binding; init: R; type?: TsType })
  | (Base & { t: "Import"; names: readonly ImportName[]; from: string })
  | (Base & { t: "ImportType"; names: readonly ImportName[]; from: string })
  | (Base & { t: "Export"; names: readonly string[] }) // trailing `export { a, b };`
  | (Base & { t: "DeclComment"; text: string; decl: Decl }); // Decl-layer twin of Comment

export interface CompilationUnit {
  readonly decls: readonly Decl[];
  readonly body: readonly R[];
}

// ─── Constructor functions — the call surface every emit rule / walker uses ─────────
// One function per variant, positional, matching field order. These are the ONLY
// sanctioned way to build residuals (no raw object literals at call sites).

/** Namer-adapter seam: mints the resolved-identifier handle. Rules use `EmitCtx.fresh`. */
export function Binding(text: string): Binding {
  return { t: "Binding", text };
}

export function ArrayPattern(elements: readonly Pattern[]): ArrayPattern {
  return { t: "ArrayPattern", elements };
}

export function RestBinding(binding: Binding): RestBinding {
  return { t: "RestBinding", binding };
}

export function Ref(binding: Binding): R {
  return { t: "Ref", binding };
}

export function RuntimeRef(symbol: string): R {
  return { t: "RuntimeRef", symbol };
}

/** Smart constructor: infers the LitValue tag from the JS value, so call sites write
 *  bare `Lit(0)` / `Lit(false)` / `Lit("s")`. */
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

export function Template(quasis: readonly string[], exprs: readonly R[]): R {
  return { t: "Template", quasis, exprs };
}

export function Call(callee: R, args: readonly R[]): R {
  return { t: "Call", callee, args };
}

export function New(callee: R, args: readonly R[]): R {
  return { t: "New", callee, args };
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

/** Data field is named `else`; a FUNCTION parameter can't be (reserved word). */
export function Cond(test: R, then: R, elseBranch: R): R {
  return { t: "Cond", test, then, else: elseBranch };
}

const toParam = (p: Pattern | Param): Param => ("t" in p ? { pattern: p } : p);

/** Ergonomic union on `params`: a bare `Pattern` is sugar for `{ pattern, type: undefined }`
 *  — the common unannotated case stays boilerplate-free; typed slots pass real `Param`s. */
export function Arrow(params: readonly (Pattern | Param)[], body: R, async?: boolean): R {
  return { t: "Arrow", params: params.map(toParam), body, async };
}

export function ArrayLit(elements: readonly R[]): R {
  return { t: "ArrayLit", elements };
}

export function ObjectLit(entries: readonly ObjectEntry[]): R {
  return { t: "ObjectLit", entries };
}

export function Spread(value: R): R {
  return { t: "Spread", value };
}

export function Await(value: R): R {
  return { t: "Await", value };
}

export function Block(stmts: readonly R[]): Extract<R, { t: "Block" }> {
  return { t: "Block", stmts };
}

export function Const(pattern: Pattern, init: R): R {
  return { t: "Const", pattern, init };
}

export function Let(pattern: Pattern, init: R): R {
  return { t: "Let", pattern, init };
}

export function Assign(pattern: Pattern, value: R): R {
  return { t: "Assign", pattern, value };
}

export function Return(value?: R): R {
  return { t: "Return", value };
}

export function While(test: R, body: Extract<R, { t: "Block" }>): R {
  return { t: "While", test, body };
}

export function ForOf(pattern: Pattern, iterable: R, body: Extract<R, { t: "Block" }>): R {
  return { t: "ForOf", pattern, iterable, body };
}

export function Continue(): R {
  return { t: "Continue" };
}

/**
 * Statement-position conditional — engine-minted TCO/loop machinery only, like
 * `Let`/`Assign` above. Demonstrated need (the §3.4 amendment rule): the constitution's
 * §6 ledger requires named-let→while with a `continue` loop step and a `return` base
 * case — both statements, so the branch between them structurally cannot ride the
 * expression `Cond` (a `continue` inside a Block-as-IIFE arm would be a SyntaxError).
 * `While`/`Continue`/`Assign` entered the algebra for exactly this rewrite; without a
 * statement branch, `Continue` is unreachable from a `While(Lit(true), …)` body at all.
 * `elseBranch` must be a `Block` or another `If` (else-if chain) — render-asserted.
 * Emit rules never mint one (rules return expressions; statement shapes are the
 * walker's own).
 */
export function If(test: R, then: Extract<R, { t: "Block" }>, elseBranch?: R): R {
  return { t: "If", test, then, else: elseBranch };
}

export function Throw(value: R): R {
  return { t: "Throw", value };
}

export function Comment(text: string, node: R): R {
  return { t: "Comment", text, node };
}

export function Annotated(value: R, type: TsType): R {
  return { t: "Annotated", value, type };
}

export function FnDecl(
  name: Binding,
  params: readonly (Pattern | Param)[],
  body: Extract<R, { t: "Block" }>,
  opts?: { async?: boolean; returnType?: TsType },
): Decl {
  return { t: "FnDecl", name, params: params.map(toParam), body, async: opts?.async, returnType: opts?.returnType };
}

export function ConstDecl(name: Binding, init: R, type?: TsType): Decl {
  return { t: "ConstDecl", name, init, type };
}

export function Import(names: readonly ImportName[], from: string): Decl {
  return { t: "Import", names, from };
}

export function ImportType(names: readonly ImportName[], from: string): Decl {
  return { t: "ImportType", names, from };
}

export function Export(names: readonly string[]): Decl {
  return { t: "Export", names };
}

export function DeclComment(text: string, decl: Decl): Decl {
  return { t: "DeclComment", text, decl };
}
