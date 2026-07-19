/**
 * CHUNK CONSTRUCTION — the `typescript`-importing sibling of ./types.ts (which
 * stays pure per its own header: "imports nothing from `typescript`"). Builds
 * the actual `ts.factory` AST a chunk's opaque `ast` field carries, from
 * already-classified/-lowered data — the walker's ingestion-fold call surface.
 *
 * Deliberately CoreForm-agnostic (no import from `../coreform/`): this module
 * knows how to build one shape — a `ts.ArrayLiteralExpression` from a flat
 * list of {literal | slot-placeholder | already-built AST} elements — and
 * nothing about scheme syntax. `../walker/walk.ts` owns BOTH recursive
 * shapes that call it (`QuoteDatum`'s list case, a `list` App call's argument
 * list), each converting its own source shape into `ChunkElement[]` and
 * folding nested lists via the `"ast"` element kind (embed an already-built
 * `ts.Expression` inline — this is what makes `'(1 (2 3))` and
 * `(list 1 (list 2 3))` both produce one genuinely nested
 * `ts.ArrayLiteralExpression`, not a slot pointing at a second chunk).
 *
 * The OTHER direction — substituting a chunk's precomputed slot values back
 * into `ast` — is NOT here: `../residual/render.ts` owns it (the module's own
 * header: "Every 'how does this print' question terminates in ./render.ts,
 * once"). This file only ever builds; it never prints.
 */
import ts from "typescript";

import type { OpaqueTsNode, SlotId } from "./types.js";

const f = ts.factory;

/**
 * One array element, already classified by the caller (the walker's own
 * ingestion-fold policy — this module makes no eligibility decisions):
 *  - `"lit"` — an inlineable JS primitive (mercury's own "short-circuits
 *    known primitives" move — no slot spent on a constant).
 *  - `"slot"` — a placeholder bridging back to a fluid Residual node; `id` is
 *    the SAME key the caller will use in the `slots` map handed to
 *    `ChunkExpr`/`ChunkStmt` (`../residual/types.ts`) — this module only
 *    mints the matching `ts.Identifier`, it never sees the fluid node itself.
 *  - `"ast"` — an already-built `ts.Expression` (typically a NESTED
 *    `arrayChunkAst` call) spliced in verbatim — what makes nested literal
 *    lists fold to one genuinely nested AST instead of a slot-per-level.
 */
export type ChunkElement =
  | { readonly kind: "lit"; readonly value: string | number | boolean | null | undefined }
  | { readonly kind: "slot"; readonly id: SlotId }
  | { readonly kind: "ast"; readonly node: OpaqueTsNode };

/**
 * A literal `ts.Expression` for a JS primitive. Deliberately a SEPARATE
 * `ts.factory` call site from render.ts's own `renderLit` (which serves a
 * `Lit` R-node, a structurally different — if overlapping — vocabulary: no
 * `bigint` here, since a `list`/quote argument is always one of these five
 * plain-JS shapes) — chunk construction and rendering stay independent by
 * design (residual/render.ts's header: this module BUILDS, that one PRINTS).
 */
function literalNode(value: string | number | boolean | null | undefined): ts.Expression {
  if (value === null) return f.createNull();
  if (value === undefined) return f.createIdentifier("undefined");
  if (typeof value === "string") return f.createStringLiteral(value);
  if (typeof value === "boolean") return value ? f.createTrue() : f.createFalse();
  // createNumericLiteral asserts on a leading `-` — same prefix-minus routing
  // render.ts's own renderLit uses, so negative/`-0` constants print identically
  // whether they arrived via a chunk or the ordinary Lit/renderExpr path.
  return value < 0 || Object.is(value, -0)
    ? f.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, f.createNumericLiteral(String(-value)))
    : f.createNumericLiteral(String(value));
}

/**
 * Build a chunk-expression's `ast`: a `ts.ArrayLiteralExpression` with a
 * placeholder `ts.Identifier` at each slot position, a literal or spliced
 * nested AST everywhere else. Returns the raw `ts.Expression` — opaque to
 * every caller but `../residual/render.ts`; the walker passes it straight to
 * `ChunkExpr(ast, slots)` without ever inspecting it.
 */
export function arrayChunkAst(elements: readonly ChunkElement[]): OpaqueTsNode {
  return f.createArrayLiteralExpression(
    elements.map((el) => {
      switch (el.kind) {
        case "lit":
          return literalNode(el.value);
        case "slot":
          return f.createIdentifier(el.id);
        case "ast":
          return el.node as ts.Expression;
      }
    }),
  );
}
