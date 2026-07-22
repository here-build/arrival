// symbol.value — per-tag factory file assembled into `symbol` by ./index.ts; shared
// types live in ./_bake.js. docs/environments.md §SYMBOL-KINDS — the `value` row (a raw
// DATA binding made first-class: the discriminated successor of the retired untagged
// `{ value }` SymbolDeclaration arm).

import { parseNameDoc, type ValueSymbolDef } from "./_bake.js";
import { fromJS, isSchemeValue } from "../../membrane/membrane.js";
import type { AmbientValue } from "../../env/AmbientRuntime.js";

/** The factory's honest return shape: `AmbientValue` MINUS anything callable. `fromJS`/the
 *  `isSchemeValue` passthrough never produce a bare procedure (see this factory's body) —
 *  narrowing the DECLARED return type to match keeps a `symbol.value` result assignable
 *  into a `Record<string, SymbolDeclaration>` slot (`common/capability.ts`'s own
 *  `SymbolDeclaration` excludes callables for the identical reason: the Stage-6-retired
 *  bare-`Fn` authoring arm). Without this narrowing, TS can't prove — from `AmbientValue`'s
 *  own `AProcedure` union member alone — that THIS particular call never returns one, and a
 *  downstream `symbols: { foo: symbol.value\`x\`(v) }` record literal fails to typecheck
 *  even though no runtime value here is ever callable. */
type NonCallableAmbientValue = Exclude<AmbientValue, (...args: any[]) => any>;

/** Stamp `def` onto `boxed`'s OWN `.contract` — own, non-enumerable, define-once (the SAME
 *  slot native/rosetta/sequence/tagless/tagless-guard mint theirs onto) — so `contractOf()`
 *  (common/capability.ts) picks up a `symbol.value` entry uniformly with every other kind,
 *  restoring harvest/registry PRESENCE for data constants (gap-a ruling, 2026-07-22).
 *
 *  TWO arms, per the ruling:
 *   - a FRESH box (`fromJS`'s own mint) never carries a `.contract` yet — stamp it
 *     unconditionally. `Object.defineProperty` (not a plain assignment) so serialization/
 *     equality/enumeration surfaces (`Object.keys`, `JSON.stringify`, a structural walk)
 *     never see it, and a second stamp attempt on the SAME box (below) either no-ops or
 *     doors instead of silently overwriting (`writable: false, configurable: false` —
 *     define-once).
 *   - a PRE-BOXED scheme value / host object may ALREADY carry a `.contract` — from a
 *     PRIOR `symbol.value` declaration of the exact same object (`fromJS`'s own
 *     `jsToWrapper` cache gives the same raw JS array/object the same wrapper across two
 *     mint calls — membrane.ts's "same JS array → same wrapper (eq? stability)"), or
 *     because the payload IS itself a native/rosetta/… proc reused by mistake (those
 *     already carry a real `.contract` field). Same NAME already stamped ⇒ idempotent
 *     no-op (the identical declaration re-running its own `symbols` builder). DIFFERENT
 *     name ⇒ a value belongs to exactly ONE declaration (the SAME ownership posture
 *     `run/CallCtx.ts`'s `associateCapability` enforces for capability ownership) — throw
 *     a teaching error rather than silently relabeling it.
 *
 *  NARROW GAP: a primitive leaf (`bigint` — scheme-zod's thin compat shim; a JS primitive
 *  can never carry a hidden own property) skips stamping entirely — `contractOf()` simply
 *  answers `undefined` for it, same as before this ruling. No live `symbol.value` payload
 *  is a bigint today; documented here so the gap is a decision, not an oversight. */
function stampValueContract(boxed: unknown, def: ValueSymbolDef): void {
  if (typeof boxed !== "object" || boxed === null) return; // the bigint gap, see doc above
  const existing = (boxed as { contract?: unknown }).contract;
  if (existing === undefined) {
    Object.defineProperty(boxed, "contract", {
      value: def,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    return;
  }
  const existingName = (existing as { name?: unknown }).name;
  if (existingName !== def.name) {
    // Same ownership posture as run/CallCtx.ts's associateCapability ("value already
    // owned by a different capability") — a plain Error, not a dedicated class, matching
    // that precedent exactly.
    throw new Error(
      `symbol.value\`${def.name}\`: this value is already contracted under a different name ` +
        `("${String(existingName)}") — a value belongs to exactly ONE declaration; declare a ` +
        `fresh value for "${def.name}" instead of reusing an already-declared one.`,
    );
  }
  // Same name already stamped — idempotent re-declaration, nothing to do.
}

/** raw VALUE binding — a host-supplied constant bound by name, never a scheme call target.
 *  The tagged template's `name: doc` now rides the minted value's OWN `.contract`
 *  (`{kind: "value", name, doc}` — see `stampValueContract` above), the harvest/registry's
 *  read-side identity for a data constant — no separate carried `value` field (the box IS
 *  the value; the "no interim representation" law). The payload call boxes at DEFINE
 *  time — the SAME `fromJS` tail `bindValue` (env/AmbientRuntime.ts) uses for its own
 *  bake-time-boxing carve-out: a pre-boxed scheme value passes through untouched (then
 *  gets its contract stamp, per the ownership rule above), a bare JS leaf is minted
 *  through `fromJS` (run-neutral, provenance-empty — pre-run by construction, so there is
 *  no live run to mint against). The home of host sentinels (`mcp/break`'s MCP_BREAK) and
 *  pre-marshalled data roots (a device sim's seeded contact list) — anything a capability
 *  binds as DATA rather than declares as a verb. */
export function value(tpl: TemplateStringsArray, ...sub: unknown[]): (v: unknown) => NonCallableAmbientValue {
  const { name, doc } = parseNameDoc(tpl, sub);
  const def: ValueSymbolDef = { kind: "value", name, doc };
  return (v: unknown): NonCallableAmbientValue => {
    const boxed = isSchemeValue(v) ? (v as AmbientValue) : (fromJS(v) as AmbientValue);
    stampValueContract(boxed, def);
    return boxed as NonCallableAmbientValue;
  };
}
