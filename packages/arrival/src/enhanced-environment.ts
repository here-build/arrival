/**
 * Sandboxed LIPS Environment
 *
 * Provides a secure, restricted LIPS environment with only whitelisted built-ins
 * and curated Ramda functions for safe expression evaluation.
 */

import { env as lipsGlobalEnv, Environment, nil } from "./lips/lips";
import { SAFE_BUILTINS } from "./lips/safe_builtins";
import { RAMDA_FUNCTIONS } from "./ramda-functions";
import { applyFantasyLandPatches } from "./fantasy-land-lips";

/**
 * Create a sandboxed LIPS environment with only safe built-ins and Ramda functions
 */
export function createSandboxedEnvironment(): any {
  // Apply Fantasy Land patches to LIPS classes first
  applyFantasyLandPatches();

  // Create isolated environment with no parent access
  const env = new (Environment as any)({}, null, null);

  // Add only whitelisted LIPS built-ins
  for (const name of SAFE_BUILTINS) {
    const value = lipsGlobalEnv.get(name, { throwError: false });
    if (value !== undefined) {
      // Special forms like 'if' are not functions but syntax constructs
      // Only check function type for actual function values
      if (typeof value === "function" || typeof value === "object") {
        env.set(name, value);
      }
    }
  }

  // Add curated Ramda functions (Fantasy Land compatible superset)
  Object.entries(RAMDA_FUNCTIONS).forEach(([name, fn]) => {
    env.set(name, fn);
  });

  // Add the Nil constructor/value (empty list)
  env.set("nil", nil);


  // Add minimal debugging helpers (safe)
  env.set("tap", (fn: Function) => (x: any) => {
    fn(x);
    return x;
  });
  env.set("trace", (label: string) => (x: any) => {
    console.log(label, x);
    return x;
  });

/*
  // Add length function explicitly (seems to be missing from Ramda functions)
  env.set("length", (collection: any) => {
    // LIPS lists have their own length calculation
    if (collection && typeof collection === 'object' && 'car' in collection) {
      // Count LIPS list elements manually
      let count = 0;
      let current = collection;
      while (current && current.constructor && current.constructor.name !== 'Nil') {
        count++;
        current = current.cdr;
      }
      return count;
    }
    // JS arrays and other collections
    return Array.isArray(collection) ? collection.length : 0;
  });
*/

  return env;
}

/**
 * Global sandboxed environment instance
 */
export const sandboxedEnv = createSandboxedEnvironment();
