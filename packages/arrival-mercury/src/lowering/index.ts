/**
 * LOWERING DECISIONS — E3's headline decision-view (engine plan §2 E3):
 * "sm.loweringDecisionAt(node) — the ladder verdict (rule/eta/shim/door), the
 * Law-T guard form, the fact-gated predicate forms… all become imperative-
 * mood view answers. The walker/materializer becomes a pure reader; if an
 * emitter branches on semantics anywhere, S5's lint fails it."
 *
 * Two independent decisions live here, matching this package's own "one
 * decision per exported function, node-kind-scoped" convention (../peepholes/,
 * ../prevalue/, ../propagate/):
 *
 *  - `loweringDecisionAt(name, registry, position)` — THE §4.2 fallback ladder
 *    for a symbol reference PROVEN FREE (not locally bound — `../walker/
 *    walk.ts`'s own `resolve()` still owns that scope-structural question;
 *    this function is never consulted until AFTER a name is proven free,
 *    exactly like `../peepholes/index.ts`'s idiom fold is only ever asked
 *    about a registry-shaped App — lexical scope is structural, never a
 *    registry semantic). Two independent ladders, matching the walker's own
 *    pre-E3 `lowerApp`/`registryValueRef` split — `position` selects which:
 *      - `"call"`: `(sym a b …)` — `rule.call` always fires when `row.emit`
 *        is set (required by `EmitRule`'s own type — gate1/measure.ts's own
 *        `reachesEmitRule` precedent: "rung 1 reached ⇔ the registry names a
 *        non-door row carrying an emit rule"); else rung 3 (RuntimeRef shim).
 *      - `"value"`: `(map sym xs)` — `rule.ref` fires when the rule DECLARES
 *        one (R5c landed `car`'s instantiated-signature eta-expansion live,
 *        `rules/phase1.ts`'s `carRule.ref` — verified empirically, not
 *        assumed: an earlier draft of this comment claimed "none do" here,
 *        which was already stale before this wave touched the file). Every
 *        OTHER `refPolicy: "eta"` symbol still has no `.ref` and DEGRADES TO
 *        SHIM here, exactly as it did inline — Law F's value-position
 *        analog: shim is always sound, never wrong; else `refPolicy ===
 *        "door"` doors; else rung 3.
 *    Both share rung 0 (door: unresolved identifier / registry-declared
 *    door). THE ONE NARROWING SEAM this package owns for
 *    `EmitRegistryRow.emit`'s opaquely-stored type (`../walker/walk.ts`'s
 *    former `ruleOf` comment: "the engine re-instantiates it here, ONCE, and
 *    nowhere else") RELOCATES here — this is now the only site in the whole
 *    package that performs it. The "rule" verdict carries the
 *    already-narrowed `EmitRule<R>` value directly, so no caller ever
 *    re-narrows or re-decides.
 *
 *  - `guardFormOf(facts, register)` — Law-T's guard form (constitution §5.2):
 *    `"bare"` (emit the condition's own residual, unwrapped) iff the read
 *    register (glass is never executed — §1) or `facts.boolean` proves it;
 *    `"strict"` (wrap in the exact-Scheme `c !== false` guard) otherwise. A
 *    one-line pure function, but named and exported — not inlined at each
 *    call site — so it is a genuine, independently-testable DECISION the
 *    walker consults, rather than a fact-table dereference it performs
 *    itself and branches on inline.
 *
 * Both are pure functions of their own explicit arguments — no model, no
 * memoization needed (`registry.lookup` is an O(1) Map hit; `guardFormOf` is
 * one comparison) — `../model/model.ts`'s `sm.loweringDecisionAt`/
 * `sm.guardFormOf` are thin wraps, matching `registryRow`'s own "a second
 * cache layer here would earn nothing" precedent.
 */
import type { EmitRule, TypeFacts } from "@inhuman.tools/arrival/emit";

import type { EmitRegistry, EmitRegistryRow } from "../registry/harvest.js";
import type { R } from "../residual/types.js";

// ── Law-T's guard form ──────────────────────────────────────────────────────

/** "bare" — emit the condition's own residual unwrapped; "strict" — wrap in
 *  the exact-Scheme `c !== false` guard (only `#f` is false: `0`/`""` are
 *  truthy). See the module header. */
export type GuardForm = "bare" | "strict";

/**
 * `sm.guardFormOf`'s underlying decision (constitution §5.2, Law T run-side):
 * the read register is ALWAYS bare (glass is never executed — §1); the run
 * register is bare iff `facts` proves `boolean`, otherwise strict. `facts` is
 * the SAME per-occurrence lookup `sm.factsAt`/`WalkOptions.facts` already
 * produce — this function never extracts a fact, it only reads the ONE it is
 * handed (Law F: absence of a fact ⇒ the conservative — "strict" — form).
 */
export function guardFormOf(facts: TypeFacts | undefined, register: "run" | "read"): GuardForm {
  return register === "read" || facts?.boolean === true ? "bare" : "strict";
}

// ── the §4.2 ladder verdict ──────────────────────────────────────────────────

/**
 * The ladder verdict for a symbol reference already proven free (see the
 * module header). `rung: "rule"` carries the narrowed `EmitRule<R>` directly
 * (never a second `row.emit as …` cast at the call site — see `ruleOf`,
 * below); `rung: "shim"` carries the row (its `.symbol` names the
 * `RuntimeRef`); `rung: "door"` carries the ready-to-throw diagnostic
 * (`code`/`message` — the walker's `doorExpr`/`WalkDoorError` shapes it into
 * a residual or a thrown compile error, never decides the text itself).
 */
export type LoweringDecision =
  | { readonly rung: "rule"; readonly rule: EmitRule<R>; readonly row: EmitRegistryRow }
  | { readonly rung: "shim"; readonly row: EmitRegistryRow }
  | { readonly rung: "door"; readonly code: string; readonly message: string };

/** Bivariant re-instantiation of the registry's opaquely-stored `EmitRule`
 *  (`../walker/walk.ts`'s former `ruleOf` — relocated here; see the module
 *  header for why this is now the ONE seam in the whole package that performs
 *  this cast). `EmitRegistryRow.emit` is stored opaque (`EmitRule<unknown>`)
 *  because arrival core cannot name this package's `R` (§4.5 layering);
 *  bivariant method-parameter checking makes a rule authored against the real
 *  `R` assignable INTO the opaque slot, but the opaque slot does not
 *  implicitly assign back out. */
function ruleOf(row: EmitRegistryRow): EmitRule<R> | undefined {
  return row.emit as EmitRule<R> | undefined;
}

/** Message text byte-identical to the walker's former `unresolvedDoor` —
 *  several committed `.error.txt` fixtures pin it. */
function unresolvedDoor(name: string): LoweringDecision {
  return {
    rung: "door",
    code: "unsupported-form/unresolved-identifier",
    message: `\`${name}\` is not lexically bound and is not a registry symbol.`,
  };
}

/** Message text byte-identical to the walker's former `doorRowExpr`. */
function doorRow(row: EmitRegistryRow): LoweringDecision {
  return {
    rung: "door",
    code: `unsupported-form/${row.symbol}`,
    message: row.doorReason ?? `\`${row.symbol}\` is not supported in compiled output.`,
  };
}

/**
 * THE ladder — see the module header. `position` selects the call-vs-value
 * ladder (the walker's pre-E3 `lowerApp`/`registryValueRef` split). Pure:
 * reads `registry.lookup(name)` once, decides, never mutates.
 */
export function loweringDecisionAt(
  name: string,
  registry: EmitRegistry,
  position: "call" | "value",
): LoweringDecision {
  const row = registry.lookup(name);
  if (row === undefined) return unresolvedDoor(name);
  if (row.kind === "door") return doorRow(row);
  const rule = ruleOf(row);

  if (position === "call") {
    return rule !== undefined ? { rung: "rule", rule, row } : { rung: "shim", row };
  }

  // Value position: `rule.ref` is OPTIONAL — most rules define only `.call`.
  // `car`'s own rule DOES declare one (R5c, `rules/phase1.ts`'s `carRule.ref`
  // — instantiated-signature eta-expansion, live); every other declared
  // "eta" `refPolicy` with no `.ref` degrades to shim here exactly as it did
  // inline (Law F's value-position analog: shim is always sound).
  if (rule?.ref !== undefined) return { rung: "rule", rule, row };
  if (row.refPolicy === "door") {
    return {
      rung: "door",
      code: `unsupported-form/${name}`,
      message: `\`${name}\` cannot be used as a first-class value in compiled output (refPolicy "door").`,
    };
  }
  return { rung: "shim", row };
}
