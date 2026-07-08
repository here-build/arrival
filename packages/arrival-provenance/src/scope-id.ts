/**
 * Thin facade over `@here.build/arrival`'s (core) scope-identity leaf.
 *
 * `scopeId`/`headOf`/`userCallSite` moved to
 * `@here.build/arrival/src/provenance/scope-id.ts` (core) — a pure,
 * dependency-free leaf with no mobx/analysis-stack ties, so it belongs in
 * core alongside the rest of the tracing spine. This file exists so every
 * sibling here keeps importing "./scope-id.js" unchanged.
 */
export { headOf, scopeId, userCallSite, DOTPROMPT_SOURCE_MARKER, type ScopedParented } from "@here.build/arrival/provenance";
