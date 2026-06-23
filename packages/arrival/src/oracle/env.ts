// env.ts — Track O, Layer Σ: the OracleEnv backed by a live arrival Environment.
//
// Σ's symbol source #1 is `boundSymbols()` — the identifiers bound in the running discovery env.
// arrival's `Environment` is a chain of frames, each holding bindings in `__env__` and a `__parent__`
// pointer. Enumerating the chain (own keys of every frame up to the root, deduped) IS the bound set
// the sandbox would resolve a free symbol against — so Σ enforces the grant for free (spec §A2): an
// env-bound name is exactly a name production code can call.
//
// `isCallable(id)` decides operator-position filtering: a bound value is applicable iff it is a JS
// function (every arrival primitive + lambda is) OR a Macro / Syntax (a special-form head). We detect
// these structurally (typeof + constructor-name walk) rather than importing the Macro class, keeping
// the oracle free of a runtime dependency on the evaluator.
//
// `signatureOf` is T (O3) — not modelled here yet; it returns null (graceful per the contract).

import type { Environment } from "../Environment.js";
import type { OracleEnv } from "./contract.js";
import type { OracleEnvΣ } from "./sigma.js";

/** The structural shape of "this bound value can be a form head". A JS function covers every arrival
 *  primitive and every user lambda; the Macro/Syntax classes cover special-form heads (`if`, `let`,
 *  `quote`, syntax-rules macros). We match those by walking the prototype chain's constructor names
 *  so we needn't import the class (and so a subclass like Syntax-extends-Macro is caught too). */
function isCallableValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "function") return true;
  // Walk the constructor-name chain for Macro / Syntax (special-form heads).
  let proto: object | null = Object.getPrototypeOf(value as object);
  while (proto) {
    const name = (proto.constructor as { name?: string } | undefined)?.name;
    if (name === "Macro" || name === "Syntax") return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/**
 * Wrap a live {@link Environment} as the Σ-aware {@link OracleEnvΣ}. `boundSymbols()` enumerates the
 * frame chain (own string keys of every `__env__` up to the root); `isCallable()` resolves a name
 * the same way the runtime would (nearest binding wins) and tests its value's applicability.
 *
 * The enumeration is a snapshot taken on each call — cheap for scout-sized envs and always reflecting
 * the env handed in (a cloned/inherited frame surfaces its own keys plus its parents'). Symbol-keyed
 * bindings are intentionally excluded: Σ constrains SOURCE symbols, which are string-named.
 */
export function makeOracleEnv(env: Environment): OracleEnvΣ {
  const boundSymbols = (): ReadonlySet<string> => {
    const names = new Set<string>();
    let frame: Environment | null = env;
    while (frame) {
      for (const key of Object.keys(frame.__env__)) names.add(key);
      frame = frame.__parent__;
    }
    return names;
  };

  const isCallable = (id: string): boolean => {
    // Resolve the nearest binding the runtime would pick.
    let frame: Environment | null = env;
    while (frame) {
      if (Object.hasOwn(frame.__env__, id)) {
        return isCallableValue(frame.__env__[id]);
      }
      frame = frame.__parent__;
    }
    return false;
  };

  const signatureOf: OracleEnv["signatureOf"] = (_id: string) => null;

  return { boundSymbols, isCallable, signatureOf };
}

/**
 * Build an {@link OracleEnvΣ} straight off a flat record of grant bindings — the platonic,
 * scope-node-free form of `makeOracleEnv(new Environment(_, bindings, null))`. A toy grant ("these
 * symbols are callable") is exactly an OracleEnvΣ: it never inherits, sets, or is looked-up through —
 * it is enumerated and probed for callability, then handed to {@link makeOracle} and discarded. So it
 * needs the Σ INTERFACE, not a runtime scope-node.
 *
 * Byte-identical to the single-frame `Environment` it replaces: that env's `__env__` IS the record
 * verbatim (the constructor assigns it untouched) and its parent is `null`, so the chain has one
 * frame. `boundSymbols()` = the record's own string keys; `isCallable(id)` = the same structural
 * {@link isCallableValue} predicate over `bindings[id]` (typeof function, or a Macro/Syntax head);
 * `signatureOf` is T (O3), not modelled — null per the contract.
 *
 * Intent-over-materialization: the caller declares "these symbols are callable grants", not
 * "construct a scope-node". The grant boundary (spec §A2) is enforced for free — an unbound name is
 * ungeneratable — exactly as the Environment-backed path enforced it.
 */
export function oracleEnvFromBindings(bindings: Record<string, unknown>): OracleEnvΣ {
  const boundSymbols = (): ReadonlySet<string> => new Set(Object.keys(bindings));

  const isCallable = (id: string): boolean =>
    Object.hasOwn(bindings, id) ? isCallableValue(bindings[id]) : false;

  const signatureOf: OracleEnv["signatureOf"] = (_id: string) => null;

  return { boundSymbols, isCallable, signatureOf };
}

/** Re-export the type for the type tag used by `signatureOf` consumers (kept for symmetry with O3). */
