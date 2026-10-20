import invariant from "tiny-invariant";
import type { RunContext } from "../run/RunContext.js";
import { NoLensError } from "../errors.js";
import { AValue, EMPTY_PROVENANCE } from "../values/primitives/AValue.js";
import { AString } from "../values/primitives/AString.js";
import { AExact } from "../values/primitives/AExact.js";
import { AInexact } from "../values/primitives/AInexact.js";
import { ABool, schemeFalse, schemeTrue } from "../values/primitives/ABool.js";
import { ANil } from "../values/primitives/ANil.js";
import { AVoid } from "../values/primitives/AVoid.js";

/**
 * JS → Scheme SCALAR boxing: a single `typeof`-tag switch that constructs the right AValue
 * subtype for a raw host scalar (already-AValue short-circuits) — string, number, boolean,
 * plus the two null-ish bottoms. Closed, no plugins.
 *
 * Containers and functions are NOT boxed here: they cross via `jsToScheme` (rosetta's
 * inbound claims — object ladder, and the callable lens of docs/membrane.md §CALLABLE-LENS,
 * which re-admits a reverse-membrane wrapper as its original callable). A non-null
 * object or function reaching `fromJs` is a programmer error.
 *
 * Host bigint DOORS (NoLensError `"bigint"`) — same spirit as unique-symbol. Exact
 * numbers are safe-int ratios; convert with Number/bigintToNumber in the safe range
 * before re-crossing. Codecs that speak bigint (`z.bigint`) encode to AExact BEFORE
 * the membrane and never reach here.
 */
export function fromJs(ctx: RunContext, v: unknown, provenance: ReadonlySet<number> = EMPTY_PROVENANCE): AValue {
  // Same-instance fast path. Re-stamp only when a distinct non-empty provenance is supplied.
  if (v instanceof AValue) {
    if (provenance === EMPTY_PROVENANCE || provenance === v.provenance) return v;
    // withProvenance is typed to the broad SchemeValue union; a clone of an AValue is
    // always an AValue subclass at runtime — narrow with a guard, not a cast.
    const restamped = v.withProvenance(provenance);
    invariant(restamped instanceof AValue, "fromJs: withProvenance must mint an AValue");
    return restamped;
  }

  if (v === null) {
    // null → nil (empty list); undefined → void: two host bottoms map to two Scheme absences.
    return new ANil(provenance);
  }
  switch (typeof v) {
    case "string":
      return new AString(v, provenance);
    case "number":
      // Safe-integer → exact (both AExact components are plain numbers); beyond
      // MAX_SAFE_INTEGER → inexact. Never a silent out-of-range exact
      // (mint-numeric crash-on-overflow is for ARITHMETIC; bare host number ingress
      // stays status-based).
      return Number.isSafeInteger(v) ? new AExact(v, 1, provenance) : new AInexact(v, provenance);
    case "bigint":
      // No lens — exact numbers are safe-int ratios; raw bigint never enters scheme.
      throw new NoLensError("bigint");
    case "boolean":
      // Reuse singletons on the empty-provenance path; allocate only when stamped.
      return provenance === EMPTY_PROVENANCE ? (v ? schemeTrue : schemeFalse) : new ABool(v, provenance);
    case "undefined":
      return new AVoid(provenance);
    default:
      // Containers and functions cross via jsToScheme (object ladder / callable lens rows):
      // they need a ctx-threaded lens and, for functions, re-admission by identity.
      // symbol and any future tag: not boxable here either (symbols cross via the
      // keyword/Symbol.for path). Programmer error, not a runtime one.
      invariant(
        false,
        typeof v === "object" || typeof v === "function"
          ? "fromJs is the scalar boxer — containers/functions cross via jsToScheme"
          : `fromJs: no boxer for typeof tag "${typeof v}"`,
      );
  }
}
