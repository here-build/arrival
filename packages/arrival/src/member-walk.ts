// Member-path walk. Given a resolved base VALUE and a dotted member path (`["bar","baz"]`),
// walk it and return the member. Pure value-member access, no Environment — the evaluator's
// dotted-symbol resolution (`env_get`) calls this after resolving the base NAME in scope, so
// name-resolution (scope) and member-access (value) stay separated.
import invariant from "tiny-invariant";
import { AJSObject } from "./values/primitives/AJSObject.js";
import { accessMember, NOT_FOUND } from "./interop-access.js";
import { InteropAccessError } from "./errors.js";
import { patch_value } from "./reader/values-repr.js";
import type { EnvironmentValue } from "./Environment.js";

/**
 * Walk a chain of (string) member keys off a base value, settling each step for
 * Scheme via `patch_value` (a Pair is cycle-marked + quoted, primitives boxed).
 * A foreign value routes through its membrane proxy (`AJSObject.get`); any other
 * value reads through `accessMember`, so blocked names and members past an interop
 * boundary surface as a miss, never host-internal leakage. A miss yields `undefined`,
 * and only the final key may miss (mid-chain miss throws — "get X from undefined").
 */
export function resolveMemberPath(base: unknown, keys: string[]): EnvironmentValue | undefined {
  let object: unknown = base;
  let value: EnvironmentValue | undefined;
  const remaining = [...keys];
  while (remaining.length > 0) {
    const name = remaining.shift()!;
    if (object instanceof AJSObject) {
      value = object.get(name) as EnvironmentValue;
    } else {
      try {
        const accessed = accessMember(object, name);
        value = accessed === NOT_FOUND ? undefined : (accessed as EnvironmentValue);
      } catch (error) {
        if (error instanceof InteropAccessError) {
          value = undefined;
        } else {
          throw error;
        }
      }
    }
    if (value === undefined) {
      invariant(remaining.length === 0, () => `Try to get ${remaining[0]} from undefined`);
      return value;
    }
    value = patch_value(value) as EnvironmentValue;
    object = value;
  }
  return value;
}
