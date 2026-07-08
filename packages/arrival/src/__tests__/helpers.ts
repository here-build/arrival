/**
 * Shared test helpers for arrival-scheme tests
 */

import { ASymbol } from "../values/primitives/ASymbol.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { AExact } from "../values/primitives/AExact.js";
import { AInexact } from "../values/primitives/AInexact.js";
import { APair } from "../values/primitives/APair.js";
import { AListAlike, type SchemeValue } from "../values/types.js";

/**
 * Create a Scheme list from JS values
 */
export function list<T extends SchemeValue>(...items: T[]): AListAlike<T> {
  return APair.fromArray(CONSTANT_CTX, items, false);
}

/**
 * Create a Scheme symbol
 */
export function sym(name: string): ASymbol {
  return new ASymbol(CONSTANT_CTX, name);
}

/**
 * Create a Scheme number (exact for integers, inexact for floats)
 */
export function num(n: number | bigint): AExact | AInexact {
  if (typeof n === "bigint") {
    return new AExact(CONSTANT_CTX, n);
  }
  return Number.isInteger(n) ? new AExact(CONSTANT_CTX, BigInt(n)) : new AInexact(CONSTANT_CTX, n);
}

/**
 * Create an exact number (rational)
 */
export function exact(num: number | bigint, denom: number | bigint = 1): AExact {
  return new AExact(CONSTANT_CTX, BigInt(num), BigInt(denom));
}

/**
 * Create an inexact number (floating point real — arrival is reals-only)
 */
export function inexact(real: number): AInexact {
  return new AInexact(CONSTANT_CTX, real);
}
