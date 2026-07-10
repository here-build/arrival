/**
 * deep-restamp.ts — the CHILD recursion behind `arrival/withProvenanceDeep` (the inbound
 * membrane's deep re-stamp term, declared optional on AValue beside `arrival/toJS`).
 *
 * A spine carrier (APair / AVector) re-stamps by MINTING a fresh spine whose children are
 * re-stamped through THIS fold; every other carrier re-stamps shallowly via its own
 * `withProvenance` (borrowed wrappers stay lazy — their entries pick the stamp up on
 * access). The fold is CLOSED over what a spine child can be at runtime (the SchemeValue
 * union), so the recursion needs no `unknown` router re-entry and no casts — the exact
 * reason the term moved onto the classes (the old jsToSchemeImpl arms carried the
 * membrane's only two sanctioned casts because the router couldn't see class internals).
 *
 * Behavior is byte-stable with the dissolved router arms:
 *  - same-provenance / empty-provenance children pass through by identity;
 *  - `seen` terminates cyclic spines: a re-encountered node returns AS-IS (the outer
 *    clone already carries the stamp), so shared/diamond substructure past the first
 *    occurrence keeps its original box — exactly the old WeakSet discipline;
 *  - a bare JS function in a value slot (the legacy AProcedure arm of SchemeValue) has no
 *    portable re-stampable value → #void, loudly — the same crossing rule the router
 *    applies to any inbound function;
 *  - non-AValue scheme orphans (EOF / Values / R7RSError) carry no provenance → identity.
 *
 * Leaf-ish module: imports the AValue base, the #void singleton and the membrane warn
 * flag — never the router (rosetta.ts), so APair/AVector can import it without widening
 * their existing benign cycles.
 */
import type { RunContext } from "./RunContext.js";
import type { SchemeValue } from "../types.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { theVoid } from "./AVoid.js";
import { ANil, nil } from "./ANil.js";
import { warnMembrane } from "../../membrane-warn.js";

/** Re-stamp ONE spine child. The caller (a carrier's own `arrival/withProvenanceDeep`)
 *  threads its `seen` set so mutual/cyclic spines terminate co-inductively. */
export function reStampChild(
  child: SchemeValue,
  ctx: RunContext,
  p: ReadonlySet<number>,
  seen: WeakSet<object>,
): SchemeValue {
  // The two host bottoms, kept for router parity: `undefined` is REACHABLE — the
  // empty-pair sentinel carries `car === undefined` at runtime (APair's iterator
  // documents it) — and takes the same warn+#void crossing every inbound undefined
  // does; `null` (type-impossible, runtime-defensive) maps to nil like the router's
  // null claim.
  if (child === undefined) {
    warnMembrane("a JS `undefined`");
    return theVoid;
  }
  if (child === null) return p === EMPTY_PROVENANCE ? nil : new ANil(ctx, p);
  // Legacy bare-fn procedure arm: same rule as every inbound function crossing.
  if (typeof child === "function") {
    warnMembrane("a JS function");
    return theVoid;
  }
  // Cycle / shared-substructure shortcut — the old router's WeakSet discipline verbatim.
  if (seen.has(child)) return child;
  seen.add(child);
  // Non-AValue orphans (EOF / Values / R7RSError): no provenance slot → identity.
  if (!(child instanceof AValue)) return child;
  // Same-provenance fast path preserves identity (mirrors the router's AValue claim).
  if (p === EMPTY_PROVENANCE || p === child.provenance) return child;
  const deep = child["arrival/withProvenanceDeep"];
  return deep === undefined ? child.withProvenance(p) : deep.call(child, ctx, p, seen);
}
