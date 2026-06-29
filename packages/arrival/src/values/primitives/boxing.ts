import invariant from "tiny-invariant";
import type { RunContext } from "./RunContext.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { AString } from "./AString.js";
import { AExact } from "../primitives/AExact.js";
import { AInexact } from "../primitives/AInexact.js";
import { ABool, schemeTrue, schemeFalse } from "./ABool.js";
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
 * History: this was a `registerBoxer` registry that inverted the dependency (each subtype
 * + the membrane self-registered its boxer) so this module imported only `AValue`. Two
 * reasons drove that — (1) the subtypes `extends AValue`, and (2) the object/function
 * boxers lived in membrane.ts (which pulls the evaluator). Both dissolved: the cycles are
 * benign RUNTIME cycles (the setMembraneBridge removal proved hoisted-function call edges
 * close fine — here only `AJSArray` calls `fromJs` back, in a method body), and the
 * object/function boxers are plain value-class construction now that AJSArray/AJSObject
 * are value-primitive files. The one membrane-side arm (`function` → #void warn) uses the
 * leaf `membrane-warn`, so no evaluator is pulled into the value layer. Hence: a switch.
 */
export function fromJs(ctx: RunContext, v: unknown, provenance: ReadonlySet<number> = EMPTY_PROVENANCE): AValue {
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

  const tag = resolveTypeofTag(v);
  switch (tag) {
    case "string":
      return new AString(ctx, v as string, provenance);
    case "number": {
      // Safe-integer JS numbers route to exact (precision-preserving through scheme
      // arithmetic); anything beyond MAX_SAFE_INTEGER would round on bigint conversion.
      const n = v as number;
      return Number.isSafeInteger(n) ? new AExact(ctx, BigInt(n), 1n, provenance) : new AInexact(ctx, n, provenance);
    }
    case "bigint":
      return new AExact(ctx, v as bigint, 1n, provenance);
    case "boolean":
      // Reuse singletons on the empty-provenance fast path; allocate only when stamped.
      return provenance === EMPTY_PROVENANCE ? (v ? schemeTrue : schemeFalse) : new ABool(ctx, v as boolean, provenance);
    case "null":
      // JS `null` → nil (empty list); JS `undefined` → void: the two host bottoms map to
      // the two distinct Scheme absences rather than collapsing to one.
      return new ANil(ctx, provenance);
    case "undefined":
      return new AVoid(ctx, provenance);
    case "object":
      // `typeof [] === "object"`: a JS array IS an R7RS vector → a borrowed AJSArray (the
      // faithful Rosetta mapping); a plain object wraps as a lazy AJSObject.
      return Array.isArray(v) ? new AJSArray(ctx, v, provenance) : new AJSObject(ctx, v as object, provenance);
    case "function":
      // A borrowed JS function is NOT a portable Scheme value → #void + warn, the same as
      // the inbound crossings (fromJS/jsToScheme). Never mints a callable wrapper.
      warnMembrane("a JS function");
      return theVoid;
    default:
      // "symbol" and any future tag: not boxable here (symbols cross via the membrane's
      // keyword/Symbol.for path, never fromJs). A programmer error, not a runtime one.
      invariant(false, `fromJs: no boxer for typeof tag "${tag}"`);
  }
}

/** `null` gets its own tag — JS quirk: `typeof null === "object"`. */
function resolveTypeofTag(v: unknown): string {
  switch (true) {
    case v === null:
      return "null";
    case v === undefined:
      return "undefined";
    default:
      return typeof v;
  }
}
