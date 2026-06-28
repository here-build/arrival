import { is_function } from "./value-guards.js";

// RegExp → predicate coercer. A host RegExp becomes a string-match predicate
// (`String(x).match(re)`); a procedure passes through unchanged; anything else is
// rejected. Extracted from arrival-extensions' `find` so the host-RegExp knowledge
// lives in a reusable leaf rather than baked into a list combinator.
export function regexPredicate(arg: unknown): (x: unknown) => unknown {
  if (arg instanceof RegExp) {
    return (x) => String(x).match(arg);
  }
  if (is_function(arg)) {
    return arg as (x: unknown) => unknown;
  }
  throw new Error("Invalid matcher");
}
