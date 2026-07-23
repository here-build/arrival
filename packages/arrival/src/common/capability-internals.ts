// capability-internals — the `-internals` naming signals what it is: a SIBLING CONTRACT
// between `common/capability.ts` and `env/vocabulary.ts`, not part of the capability-authoring
// public surface (`EnvCapability`/`SymbolDeclaration`/`ImplThis`, capability.ts's own "3 story").
// Physically relocated OUT of capability.ts (export-restructure, docs/plans/
// stage-c-corpse-deletion.md §"Export restructure") so that file reads as the clean authoring
// contract it claims to be, and so the `/capability` subpath's external surface never leaked
// these bind-loop helpers in the first place. NOT package.json-exported under any subpath —
// reached only by relative import (`env/vocabulary.ts`, `type-layer/prelude.ts`) — no
// stability contract, may change shape whenever the bind loop that consumes it does.

import type { AEntity, DefineSymbolDef, DefineSyntaxSymbolDef, MacroSymbolDef } from "./symbols/_bake.js";
import type { AliasSymbolDef } from "./symbols/alias.js";
import type { EnvCapability, SymbolDeclaration } from "./capability.js";
import type { DegradedCapability, DegradedNeed } from "./degradation.js";
import { AKernelKeyword } from "../values/AKernelKeyword.js";
import { ANativeProcedure, ARosettaProcedure, DoorProcedure } from "../values/primitives/ACallable.js";

type Fn = (...args: any[]) => unknown;

// ── LEGACY-form RUNTIME refusal guard (Stage C Cut 4): `{ fn }` is no longer a
// `SymbolDeclaration` union member (see capability.ts's own doc) — `env/vocabulary.ts`'s
// `buildVocabulary` still calls this against a runtime-cast `SymbolDeclaration` record to
// refuse a legacy-shaped capability with `VocabularyLegacyCapabilityError` instead of
// silently mis-binding it (a stale-dist or untyped-JS producer can still hand one in, past
// the type system). Structural, not `SymbolDeclaration`-narrowing anymore — the predicate
// type below is deliberately wider than the (now `{fn}`-free) parameter type. */
export const isSymbolSpec = (m: SymbolDeclaration): m is SymbolDeclaration & { fn: Fn } =>
  typeof m === "object" && m !== null && "fn" in m;

/** `symbol.alias`'s marker — see `alias.ts`'s header for the full dissolution-semantics
 *  contract. Checked BEFORE every other dispatch in the apply loop (its `kind` — `"alias"` —
 *  is deliberately outside both the minted-value family and the three surviving declarative
 *  kinds, so it would otherwise fall through to the legacy `{ fn }`-guessing arm instead). */
export const isAliasDef = (m: SymbolDeclaration): m is AliasSymbolDef =>
  typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "alias";

/** The three SURVIVING declarative record kinds — `symbol.define`/`symbol.defineSyntax` (the
 *  two-phase carve-out) and `symbol.macro` (already hands over a real `Macro`, but stays a
 *  `{kind, name, macro}` record so `preludeOnly` routing has somewhere to live). Every OTHER
 *  kind mints its A-value directly now (see `SymbolDeclaration`'s doc), so a plain object
 *  carrying one of these three `kind` tags is unambiguous — none of the minted classes'
 *  OWN `.kind` field (`"procedure"`/`"keyword"`/an ordinary scheme-value kind) collides with
 *  `"define"`/`"define-syntax"`/`"macro"`. */
export const isDeclarativeDef = (
  m: SymbolDeclaration,
): m is MacroSymbolDef | DefineSymbolDef | DefineSyntaxSymbolDef =>
  typeof m === "object" &&
  m !== null &&
  "kind" in m &&
  ((m as { kind: unknown }).kind === "macro" ||
    (m as { kind: unknown }).kind === "define" ||
    (m as { kind: unknown }).kind === "define-syntax");

/** Stage A2 READ-SIDE seam: extract a `SymbolDeclaration` entry's `AEntity` CONTRACT view, for
 *  read-only introspection consumers (the describe/catalog roster in `eval/exec-phases.ts`, the
 *  type-lens harvest in `type-layer/prelude.ts`/`schema-to-ts.ts`, the mercury registry harvest)
 *  that used to walk a `symbols` record expecting each entry to BE its own `AEntity` record.
 *  Since the symbol.* factories now mint the runtime A-value directly (see `SymbolDeclaration`'s
 *  doc), those readers dispatch by `instanceof` here exactly like the bind loop above, pulling
 *  the SAME `.contract`/`.door` data the bind loop reads per-assembly — never invoking anything
 *  (a value is inert until applied; this is a pure, dry projection). `undefined` for an entry
 *  with no contract to show: `symbol.alias` (resolve the target first), the legacy `{ fn }` arm,
 *  and the narrow bigint-leaf gap `symbol.value`'s own factory documents (a JS primitive can't
 *  carry a hidden property to stamp).
 *
 *  gap-a ruling (2026-07-22): `symbol.value` stamps its OWN `{kind:"value",name,doc}` onto the
 *  minted/boxed value's `.contract` too (own, non-enumerable, define-once — see `value.ts`),
 *  the SAME slot every other kind rides — so the generic `"contract" in def` fallback below
 *  picks it up uniformly, with no per-kind special-casing here. */
export function contractOf(def: SymbolDeclaration): AEntity | undefined {
  if (def instanceof DoorProcedure) return def.door;
  if (def instanceof ANativeProcedure || def instanceof ARosettaProcedure) return def.contract as AEntity;
  if (def instanceof AKernelKeyword) return { kind: "keyword", name: def.name };
  if (isDeclarativeDef(def)) return def;
  if (typeof def === "object" && def !== null && "contract" in def) {
    return (def as { contract?: AEntity }).contract;
  }
  return undefined;
}

/** Stage 3 auto-derive gate (`Contract.requiresConfig`, `./symbols/_bake.js`): the declared
 *  keys ABSENT from this activation's validated `configuration` — `undefined` when the def
 *  declares no `requiresConfig` or every declared key is present (the zero-cost, overwhelming-
 *  majority path). Read UNCONDITIONALLY by the `native`/`rosetta` bind arms below — no
 *  builder-form, no `degradation:"doors"` gate; see the field's own doc for the D2 departure
 *  this closes (a bare-required config key used to fail-close at `schema.parse`, before any
 *  program graph existed to statically explain WHY). */
export const missingRequiresConfig = (
  requiresConfig: readonly (string | readonly string[])[] | undefined,
  configuration: Record<string, unknown>,
): readonly (string | readonly string[])[] | undefined => {
  if (requiresConfig === undefined || requiresConfig.length === 0) return undefined;
  // A group entry (`readonly string[]`) is ANY-OF: missing only when EVERY key is absent.
  const missing = requiresConfig.filter((entry) =>
    typeof entry === "string"
      ? configuration[entry] === undefined
      : entry.every((key) => configuration[key] === undefined),
  );
  return missing.length === 0 ? undefined : missing;
};

/** The keys a door's `cause.needs` carries for a missing set — group entries flattened
 *  (each key in an any-of group is a real enabling key; the either-of semantics live in the
 *  reason text, `cause.needs` stays the flat `configuration`-key list every reader expects). */
export const requiresConfigNeeds = (missing: readonly (string | readonly string[])[]): readonly string[] =>
  missing.flatMap((entry) => (typeof entry === "string" ? [entry] : [...entry]));

/** Auto-door misses surfaced for `Vocabulary.degraded`: `env/vocabulary.ts`'s bind loop mints
 *  `requiresConfig` doors as bound `DoorProcedure`s WITHOUT writing a `DoorSymbolDef` back
 *  into `symbolsRec`, so `collectDegraded`'s record scan (built for the builder-form
 *  `degradation.door(...)` path, which does write defs) can't see them — this sibling scan
 *  reads the same misses straight off the baked defs, and that bind loop merges the two
 *  views via {@link mergeDegraded}. */
export const collectRequiresConfigDegraded = (
  capabilityName: string,
  symbolsRec: Record<string, SymbolDeclaration>,
  configuration: Record<string, unknown>,
): DegradedCapability | undefined => {
  const seen = new Set<string>();
  const needs: DegradedNeed[] = [];
  for (const rawDef of Object.values(symbolsRec)) {
    // Stage A2: `requiresConfig` rides `.contract` on a minted native/rosetta value now
    // (never a top-level field on the value itself) — `contractOf` is the shared read-side
    // seam every describe/catalog/harvest reader already dispatches through.
    const entity = contractOf(rawDef);
    if (entity === undefined || !("requiresConfig" in entity)) continue;
    const missing = missingRequiresConfig(entity.requiresConfig, configuration);
    if (missing === undefined) continue;
    for (const key of requiresConfigNeeds(missing)) {
      if (seen.has(key)) continue;
      seen.add(key);
      needs.push({ kind: "configuration", key });
    }
  }
  return needs.length === 0 ? undefined : { capability: capabilityName, needs };
};

/** Merge the two degraded views (builder-door record scan + requiresConfig def scan),
 *  deduped by need key; `undefined` when both are. */
export const mergeDegraded = (
  a: DegradedCapability | undefined,
  b: DegradedCapability | undefined,
): DegradedCapability | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const seen = new Set(a.needs.map((need) => `${need.kind}:${need.key}`));
  return {
    capability: a.capability,
    needs: [...a.needs, ...b.needs.filter((need) => !seen.has(`${need.kind}:${need.key}`))],
  };
};

/** The auto-derived door's teaching reason — same "provide X to enable it" register
 *  `degradation.ts`'s hand-authored `.door(name, needs, reason)` callers write by hand, minted
 *  here mechanically from the declaring verb's OWN `doc` instead. An any-of group renders as
 *  "`fs` or `loader`" with a "one of them" pronoun, keeping the disjunction legible. */
export const requiresConfigReason = (missing: readonly (string | readonly string[])[], doc: string | undefined): string => {
  const keysClause = missing
    .map((entry) => (typeof entry === "string" ? `\`${entry}\`` : entry.map((key) => `\`${key}\``).join(" or ")))
    .join(", ");
  const pronoun = missing.length === 1 ? (typeof missing[0] === "string" ? "it" : "one of them") : "them";
  const docClause = doc === undefined ? "" : ` (${doc})`;
  return `requires configuration ${keysClause} — provide ${pronoun} to enable this verb.${docClause}`;
};

/** Every `.spec.prelude` reachable from `caps`, DAG order (a dep's prelude precedes its
 *  dependent's — matching `env/vocabulary.ts`'s `buildVocabulary` deps-first bind order, so a
 *  dependent's prelude may reference names its dep's prelude defined), deduplicated by
 *  capability IDENTITY (a
 *  diamond-shaped dep graph must not double-emit a shared dep's prelude).
 *
 *  For an EDITOR/type-lens's ambient scheme vocabulary: walk the actually-assembled capability
 *  set, never a hand-picked subset — a hand-picked list silently drifts the moment a
 *  capability's prelude changes or a new capability joins the root-set. */
export function collectPrelude(caps: readonly EnvCapability[], seen: Set<EnvCapability> = new Set()): string {
  const parts: string[] = [];
  for (const cap of caps) {
    if (seen.has(cap)) continue;
    seen.add(cap);
    if (cap.spec.deps !== undefined) {
      const depsPrelude = collectPrelude(cap.spec.deps, seen);
      if (depsPrelude !== "") parts.push(depsPrelude);
    }
    if (cap.spec.prelude !== undefined) parts.push(cap.spec.prelude);
  }
  return parts.join("\n");
}

/** Serialize a capability DAG's scheme-bodied `symbol.define`s as `(define <verb> <body>)`
 *  source — the type-lens compile-path counterpart to {@link collectPrelude}'s `prelude:`
 *  strings. A `symbol.define`'s `body` is its RHS EXPRESSION (`(lambda () "string")` for
 *  `s/string`), bound at runtime under its own record key (see `env/vocabulary.ts`'s
 *  `processCapability` Pass-2 loop, the successor of capability.ts's retired `lower().apply()`).
 *  Emitting the SAME `(define verb body)` lets a type-lens infer each symbol's type FROM ITS
 *  OWN BODY, so the runtime binding and the editor type derive from one source — no
 *  hand-authored `.d.ts`, no editorial subset (the drift trap {@link collectPrelude} warns of,
 *  same reasoning). Deps FIRST (a dependent body may reference a base define — `s/field/string`
 *  calls `s/field`), deduped by the shared `seen` set exactly like `collectPrelude`.
 *
 *  Only `kind: "define"` entries emit; every other kind (rosetta/native/door/…) is either a
 *  JS impl with no scheme body or a keyword/macro the lens models elsewhere.
 *
 *  NOT for runtime prelude eval: `env/vocabulary.ts`'s bind loop already binds these via
 *  `bindCapabilityDefines`; re-running them as a prelude would double-bind. This output feeds
 *  a type-lens `schemePrelude` (the editor's compiled scheme vocabulary), never the runtime
 *  env. */
export function collectSymbolDefines(caps: readonly EnvCapability[], seen: Set<EnvCapability> = new Set()): string {
  const parts: string[] = [];
  for (const cap of caps) {
    if (seen.has(cap)) continue;
    seen.add(cap);
    if (cap.spec.deps !== undefined) {
      const depDefines = collectSymbolDefines(cap.spec.deps, seen);
      if (depDefines !== "") parts.push(depDefines);
    }
    const symbols = cap.spec.symbols;
    if (symbols === undefined) continue;
    for (const [key, def] of Object.entries(symbols)) {
      if (def !== null && typeof def === "object" && "kind" in def && def.kind === "define") {
        parts.push(`(define ${key} ${(def as DefineSymbolDef).body})`);
      }
    }
  }
  return parts.join("\n");
}
