// emit — the `@here.build/arrival/emit` subpath: compiler-facing PURE-DATA types
// (constitution §4.5's IN-arrival-core layer). The whole transitive closure of this
// barrel must stay `typescript`-free — the `type-layer/index.ts` co-bundling
// anti-pattern (one barrel granting all-or-nothing access to LanguageService
// machinery) is the named counter-example this subpath exists to avoid.
//
// Residual (`R`, proposal §3.4) and its constructors are owned by residual-renderer.md
// and join this barrel when they land; until then `EmitRule`/`EmitCtx` stay generic
// over an opaque residual type (see emit-rule.ts's header).

export type { TypeFacts } from "./type-facts.js";
export type { EmitConfig, EmitCtx, EmitRule, RefPolicy } from "./emit-rule.js";
