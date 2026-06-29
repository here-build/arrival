/**
 * Core Scheme value-type contracts extracted from lips.ts.
 * Concrete value classes live in ./primitives/*; this file keeps the pure
 * type/interface/guard surface they share.
 */

// SchemeValue is the honest union of every value the interpreter can hold:
// every concrete AValue subclass, the live non-AValue orphans (EOF, Values),
// and a JS function used as a Scheme procedure. Excludes QuotedPromise
// (dissolved) and DatumReference (reader-internal).
import type { AExact } from "./primitives/AExact.js";
import type { AInexact } from "./primitives/AInexact.js";
import type { APair } from "./primitives/APair.js";
import type { ANil } from "./primitives/ANil.js";
import type { AString } from "./primitives/AString.js";
import type { ASymbol } from "./primitives/ASymbol.js";
import type { ABool } from "./primitives/ABool.js";
import type { AVector } from "./primitives/AVector.js";
import type { ABytevector } from "./primitives/ABytevector.js";
import type { ACharacter } from "./primitives/ACharacter.js";
import type { AVoid } from "./primitives/AVoid.js";
import type { AHalfBaked } from "./primitives/AHalfBaked.js";
import type { AJSArray } from "./primitives/AJSArray.js";
import type { AJSObject } from "./primitives/AJSObject.js";
import type { EOF } from "./primitives/EOF.js";
import type { Values } from "./primitives/Values.js";
import type { Keyword } from "./Keyword.js";

export type SchemeValue =
  | AExact
  | AInexact
  | APair
  | ANil
  | AString
  | ASymbol
  | ABool
  | AVector
  | ABytevector
  | ACharacter
  | AVoid
  | AHalfBaked
  | AJSArray
  | AJSObject
  | Keyword
  | EOF
  | Values
  | ((...args: SchemeValue[]) => SchemeValue);

// -------------------------------------------------------------------------
// :: SchemeStringLike interface - duck-typing for SchemeString class
// :: Placed first because other types reference it
// -------------------------------------------------------------------------
export interface SchemeStringLike {
  __string__: string | string[];
  valueOf(): string;
  toString(): string;
}

// SchemeString type guard - works with both interface and actual class
export function isSchemeString(x: unknown): x is SchemeStringLike {
  return typeof x === "object" && x !== null && "__string__" in x;
}

// Combined string check
export function isString(x: unknown): x is SchemeStringLike | string {
  return typeof x === "string" || isSchemeString(x);
}

// Forward declaration for Pair (implemented in lips.ts)
// This allows Nil.append to return the right type without circular dependency
export interface APairLike<Car = unknown, Cdr = unknown> {
  car: Car;
  cdr: Cdr;
}
