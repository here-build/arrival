// emit — the `@inhuman.tools/arrival/emit` subpath: the compiler-facing, PURE-DATA type
// surface. Import discipline is the feature — the whole transitive closure of this barrel
// stays `typescript`-free, so a Contract can carry emit rules without dragging the
// LanguageService into arrival core.
//
// THE LAYERING RULE (canonical statement; the other emit/ files point here). The
// dependency runs one way only: the compiler package (arrival-mercury) READS contracts and
// interprets residuals; arrival core NEVER imports the compiler. Rejected alternative — one
// barrel co-bundling these types with the LanguageService machinery (the `type-layer`
// anti-pattern) grants all-or-nothing access and pulls `typescript` into every consumer.
//
// The Residual algebra `R` is owned by the compiler package; until it relocates,
// `EmitRule`/`EmitCtx` stay generic over an opaque residual (see ./emit-rule.ts).
// `residual-lite` seeds a local, structural mirror of the residual builders
// (see ./residual-lite.ts).

export type { TypeFacts } from "./type-facts.js";
export type { EmitConfig, EmitCtx, EmitRule, RefPolicy } from "./emit-rule.js";

export type { BinOp, LitValue, NodeId, Param, R, UnOp } from "./residual-lite.js";
// `Binding` is a merged type + value; this value re-export carries both facets (no
// separate `export type { Binding }` needed).
export { ArrayLit, Arrow, Bin, Binding, Call, Index, Lit, Member, Method, Ref, Spread, Un } from "./residual-lite.js";
