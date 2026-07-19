import invariant from "tiny-invariant";
import type { RunContext } from "./RunContext.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { AString } from "./AString.js";
import { AExact } from "../primitives/AExact.js";
import { AInexact } from "../primitives/AInexact.js";
import { ABool, schemeFalse, schemeTrue } from "./ABool.js";
import { ANil } from "./ANil.js";
import { AVoid, theVoid } from "./AVoid.js";
import { AJSArray } from "./AJSArray.js";
import { AJSObject } from "./AJSObject.js";
import { warnMembrane } from "../../membrane-warn.js";

/**
 * The JS → Scheme boxing membrane: a single `typeof`-tag `switch` that constructs the
 * right AValue subtype for a raw host value (already-AValue input short-circuits). The
 * tag set is JS's fixed `typeof` family + the two null-ish tags — closed, no plugins.
 *
 * A single switch, not a registry: the subtypes already `extends AValue`, and the
 * object/function boxers are plain value-class construction (AJSArray/AJSObject are
 * value-primitive files) — nothing here needs indirection through a self-registering
 * boxer table. The one membrane-side arm (`function` → #void warn) uses the leaf
 * `membrane-warn`, so no evaluator is pulled into the value layer.
 *
 * `bigint` is the one tag that does NOT box (docs/design-history/
 * arrival-one-number-rework.md §2.3): an opaque HOST value, not a scheme number — it
 * rides the same raw identity lane a bytevector does at the membrane's public face
 * (membrane.ts's `isBytevectorLike`), never reinterpreted as an `AExact`. That widens
 * this function's return type by exactly that one member; every caller already treats
 * the result as `unknown`/a cast target (rosetta.ts's INBOUND_CLAIMS row, op-helpers.ts's
 * `withInputProvenance`).
 */
export function fromJs(
  ctx: RunContext,
  v: unknown,
  provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
): AValue | bigint {
  // Same-instance fast path: already a Scheme value. Re-stamp only when a distinct,
  // non-empty provenance is supplied (then `withProvenance` mints a copy).
  if (v instanceof AValue) {
    if (provenance === EMPTY_PROVENANCE || provenance === v.provenance) return v;
    // `withProvenance` is typed to the broad `SchemeValue` union (its abstract base
    // declaration; concrete subclasses override to their own narrower type). A clone
    // of an `AValue` is always an `AValue` subclass at runtime — narrow honestly with
    // a guard rather than a cast, so `fromJs` keeps its `AValue` contract.
    const restamped = v.withProvenance(provenance);
    invariant(restamped instanceof AValue, "fromJs: withProvenance must mint an AValue");
    return restamped;
  }

  if (v === null) {
    // JS `null` → nil (empty list); JS `undefined` → void: the two host bottoms map to
    // the two distinct Scheme absences rather than collapsing to one.
    return new ANil(ctx, provenance);
  }
  switch (typeof v) {
    case "string":
      return new AString(ctx, v, provenance);
    case "number":
      // Safe-integer JS numbers route to exact (both AExact components are plain
      // `number`s, §2.1); anything beyond MAX_SAFE_INTEGER is inexact — never a silent
      // out-of-range exact (values/mint-numeric.ts's crash-on-overflow law is for
      // ARITHMETIC results; ingress from a bare host number stays this status-quo
      // silent law per the plan's §0.3).
      return Number.isSafeInteger(v) ? new AExact(ctx, v, 1, provenance) : new AInexact(ctx, v, provenance);
    case "bigint":
      // Opaque host value — not a scheme number (see this function's header doc):
      // never boxed, rides straight through by identity.
      return v;
    case "boolean":
      // Reuse singletons on the empty-provenance fast path; allocate only when stamped.
      return provenance === EMPTY_PROVENANCE ? (v ? schemeTrue : schemeFalse) : new ABool(ctx, v, provenance);
    case "undefined":
      return new AVoid(ctx, provenance);
    case "object":
      // `typeof [] === "object"`: a JS array IS an R7RS vector → a borrowed AJSArray (the
      // faithful Rosetta mapping); a plain object wraps as a lazy AJSObject.
      return Array.isArray(v) ? new AJSArray(ctx, v, provenance) : new AJSObject(ctx, v, provenance);
    case "function":
      // A borrowed JS function is NOT a portable Scheme value → #void + warn, the same as
      // the inbound crossings (fromJS/jsToScheme). Never mints a callable wrapper.
      warnMembrane("a JS function");
      return theVoid;
    default:
      // "symbol" and any future tag: not boxable here (symbols cross via the membrane's
      // keyword/Symbol.for path, never fromJs). A programmer error, not a runtime one.
      invariant(false, `fromJs: no boxer for typeof tag "${typeof v}"`);
  }
}
