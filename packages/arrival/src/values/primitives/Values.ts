import { theVoid } from "./AVoid.js";
import { INTEROP_BOUNDARY } from "../../membrane/interop-access.js";
import type { SchemeValue } from "../types.js";

// The carrier for `(values …)`: a distinct wrapper, not a plain value, so a
// multiple-values return is distinguishable from a single value that happens
// to be a collection.
export class Values {
  /** Outside AValue — explicit interop stamp (FAMILY RULE misses non-AValue).
   *  `type()` reports `foreign:Values`. */
  static [INTEROP_BOUNDARY] = true;

  __values__: SchemeValue[];

  // Use Values.from() — it unwraps 0/1-element cases this constructor cannot.
  private constructor(values: SchemeValue[]) {
    this.__values__ = values;
  }

  /**
   * Empty → void (the unspecified value); single element → that element
   * unwrapped; ≥2 → a Values. The unwrap is what keeps a 1-value `(values x)`
   * indistinguishable from `x`. Precise on BOTH sides (not `unknown[]`/`unknown`):
   * every branch is honestly a SchemeValue — `theVoid` (AVoid), `values[0]` (an
   * element of the SchemeValue[] argument), or `new Values(values)` itself (`Values`
   * is a member of the `SchemeValue` union in ../types.ts).
   */
  static from(values: SchemeValue[]): SchemeValue {
    if (values.length === 0) {
      return theVoid;
    }
    if (values.length === 1) {
      return values[0];
    }
    return new Values(values);
  }

  toString(): string {
    return this.__values__.map((x) => String(x)).join("\n");
  }

  valueOf(): SchemeValue[] {
    return this.__values__;
  }
}
