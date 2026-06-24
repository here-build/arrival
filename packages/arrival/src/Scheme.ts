/**
 * Scheme namespace - clean API for Scheme value types
 *
 * This namespace provides the canonical names for Scheme types.
 * Usage: import { Scheme } from 'arrival-scheme'
 *        const s = new Scheme.String("hello")
 *        const n = new Scheme.Exact(42n)
 */

// Re-export classes with clean names
export { AString as String } from "./values/primitives/AString.js";
export { ASymbol as Symbol } from "./values/primitives/ASymbol.js";
export { ANil as Nil, nil as nil } from "./values/primitives/ANil.js";
export { ACharacter as Character } from "./values/primitives/ACharacter.js";
export { APair as Pair } from "./values/primitives/APair.js";
export { AExact as Exact, AInexact as Inexact } from "./values/numbers.js";
export { Environment as Environment } from "./Environment.js";

// Re-export type aliases
export type { ANumeric as Numeric } from "./values/numbers.js";

// Re-export SchemeValue as Value for the generic "any scheme value" type
export type { SchemeValue as Value } from "./values/types.js";
