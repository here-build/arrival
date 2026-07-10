// env.ts — Track O, Layer Σ: the OracleEnv backed by a live arrival Environment.
//
// Σ's symbol source #1 is `boundSymbols()` — the identifiers bound in the running discovery env.
// arrival's `Environment` is a chain of frames, each holding bindings in `__env__` and a `__parent__`
// pointer. Enumerating the chain (own keys of every frame up to the root, deduped) IS the bound set
// the sandbox would resolve a free symbol against — so Σ enforces the grant for free (spec §A2): an
// env-bound name is exactly a name production code can call.
//
// `isCallable(id)` decides operator-position filtering: a bound value is applicable iff it is a JS
// function (every arrival primitive + lambda is) or a Macro/Syntax (a special-form head). Detected
// structurally (typeof + constructor-name walk) rather than importing the Macro class, keeping the
// oracle free of a runtime dependency on the evaluator.
//
// `signatureOf` is T (O3) — not modelled here yet; returns null (graceful per the contract).

import type { Environment } from "../Environment.js";
import type { Macro } from "../eval/Macro.js";
import type { Syntax } from "../eval/Syntax.js";
import { is_callable_value } from "../values/value-guards.js";
import type { OracleEnv } from "./contract.js";
import type { OracleEnvΣ } from "./sigma.js";

/** The structural shape of "this bound value can be a form head". A JS function covers legacy
 *  bare-fn bindings (`env.defineRosetta`-era); `is_callable_value` (values/value-guards.ts, a value-
 *  kernel leaf) covers the tagless-final callable-as-value classes a capability's baked `symbol.rosetta`
 *  / `symbol.native` declarations bind (`ANativeProcedure`/`ARosettaProcedure`/`ALambda`/`DoorProcedure`
 *  — common/capability.ts's `apply()`); the Macro/Syntax classes cover special-form heads (`if`, `let`,
 *  `quote`, syntax-rules macros). Macro/Syntax are matched by walking the prototype chain's constructor
 *  names so we needn't import the class at RUNTIME (a subclass like Syntax-extends-Macro is caught too)
 *  — those imports are `import type`, erased at compile, so the oracle keeps no runtime edge into the
 *  evaluator proper (`is_callable_value` is a value-kernel leaf, not an evaluator import). */
function isCallableValue(value: unknown): value is Function | Macro | Syntax {
  if (value === undefined || value === null) return false;
  if (typeof value === "function") return true;
  if (is_callable_value(value)) return true;
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
 * The enumeration is a snapshot taken on each call — cheap for scout-sized envs, always reflecting
 * the env handed in. Symbol-keyed bindings are intentionally excluded: Σ constrains SOURCE symbols,
 * which are string-named.
 */
export function makeOracleEnv(env: Environment): OracleEnvΣ {
  const boundSymbols = (): ReadonlySet<string> => {
    const names = new Set<string>();
    let frame: Environment | null = env;
    while (frame) {
      for (const key of Object.keys(frame.__env__)) names.add(key);
      frame = frame.__parent__;
    }
    // car/cdr are kernel-synthesized c[ad]+r primitives — always-available callables, so they
    // belong in Σ even though no frame binds them (the family's emittable base case).
    names.add("car");
    names.add("cdr");
    return names;
  };

  const isCallable = (id: string): boolean => {
    // car/cdr and every c[ad]+r are kernel-synthesized accessors — always callable.
    if (/^c[ad]+r$/.test(id)) return true;
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
 * Build an {@link OracleEnvΣ} straight off a flat record of grant bindings — the scope-node-free
 * form of `makeOracleEnv(new Environment(_, bindings, null))`. A grant ("these symbols are
 * callable") is never inherited, set, or looked up through — only enumerated and probed for
 * callability — so it needs the Σ INTERFACE, not a runtime scope-node.
 *
 * Byte-identical to the single-frame `Environment` it replaces (that env's `__env__` IS the record
 * verbatim, parent `null`): `boundSymbols()` = the record's own string keys; `isCallable(id)` = the
 * same {@link isCallableValue} predicate over `bindings[id]`; `signatureOf` is T (O3), not modelled
 * — null per the contract.
 *
 * The grant boundary (spec §A2) is enforced for free — an unbound name is ungeneratable — exactly
 * as the Environment-backed path enforces it.
 */
export function oracleEnvFromBindings(bindings: Record<string, unknown>): OracleEnvΣ {
  const boundSymbols = (): ReadonlySet<string> => new Set(Object.keys(bindings));

  const isCallable = (id: string): boolean =>
    Object.hasOwn(bindings, id) ? isCallableValue(bindings[id]) : false;

  const signatureOf: OracleEnv["signatureOf"] = (_id: string) => null;

  return { boundSymbols, isCallable, signatureOf };
}

/**
 * Build an {@link OracleEnvΣ} off the DECLARED exec products — an {@link AssembledAmbient}
 * (the sealed capability base a `{ ambient }` / `{ capabilities }` run resolves through) plus
 * an optional {@link LexicalScope} (the run's define-accumulation frame). This is the
 * privatization-era twin of {@link makeOracleEnv}: consumers that used to mint a grant env via
 * `sandboxedEnv.inherit(name)` + `defineRosetta` now assemble a capability ambient and hand it
 * here — Σ enumerates exactly what the run's Resolver would resolve (`scope.lookup ??
 * ambient.lookup`, nearest binding wins), so the grant boundary (spec §A2) holds unchanged.
 *
 * `boundSymbols()` = the ambient's sealed-chain vocabulary (resolver-synthesized names absent,
 * per the chain's own contract) ∪ the scope chain's own string keys, plus the kernel-synthesized
 * `car`/`cdr` family base cases — mirroring {@link makeOracleEnv}'s frame walk. `signatureOf` is
 * T (O3), not modelled — null per the contract.
 */
export function oracleEnvFromAmbient(ambient: AmbientLike, scope?: { env: Environment }): OracleEnvΣ {
  const boundSymbols = (): ReadonlySet<string> => {
    const names = new Set<string>();
    for (const name of ambient.names()) if (typeof name === "string") names.add(name);
    let frame: Environment | null = scope?.env ?? null;
    while (frame) {
      for (const key of Object.keys(frame.__env__)) names.add(key);
      frame = frame.__parent__;
    }
    names.add("car");
    names.add("cdr");
    return names;
  };

  const isCallable = (id: string): boolean => {
    if (/^c[ad]+r$/.test(id)) return true;
    // Nearest binding wins, exactly like the run's composed Resolver: lexical chain first,
    // then the sealed capability chain.
    let frame: Environment | null = scope?.env ?? null;
    while (frame) {
      if (Object.hasOwn(frame.__env__, id)) return isCallableValue(frame.__env__[id]);
      frame = frame.__parent__;
    }
    const bound = ambient.lookup(id);
    return bound === undefined ? false : isCallableValue(bound);
  };

  const signatureOf: OracleEnv["signatureOf"] = (_id: string) => null;

  return { boundSymbols, isCallable, signatureOf };
}

/** The structural slice of {@link AssembledAmbient} the oracle consumes — typed structurally
 *  (not by importing exec-phases) so the oracle keeps zero edges into the exec pipeline. */
interface AmbientLike {
  lookup(name: string | symbol): unknown;
  names(): ReadonlySet<string | symbol>;
}
