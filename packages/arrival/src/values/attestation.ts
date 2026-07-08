/**
 * attestation — the branded-value registry behind the manifold's `s/*` family
 * (design: second-foundation/arrival-manifold/docs/attestation-design.md).
 *
 * PROVENANCE/TAINT-FLOW, NOT TYPING — and deliberately not the provenance set.
 * Provenance has union/forward algebra (survives computation via
 * `withInputProvenance`); attestation needs DROP-ON-COMPUTE algebra: a computed
 * value (`(+ (:a r) 1)`, `string-append`, any fresh box) must lose its inputs'
 * attestation so a model has to re-assert what the new value IS. An identity-keyed
 * WeakSet expresses "drop unless explicitly carried" natively: every builtin mints
 * fresh boxes (op-helpers.ts `withInputProvenance` — always a fresh construction
 * or a `withProvenance` clone), so computation drops attestation for free, while
 * reference-passing (`let`, lambda args, stored container elements, `if`/`cond`
 * selects) preserves it for free.
 *
 * Three stamp sites, each mirroring an existing provenance touch:
 *   1. the `bakeRosetta` return walk (common/symbols/_bake.ts step 4) — a SOURCE
 *      rosetta's return is machine-made, so its spine + leaves are deep-attested
 *      in the same position as the provenance deep-stamp;
 *   2. pluck inheritance — `AJSObject.get` / `AJSArray`'s element materialization
 *      attest the boxes they mint iff the container itself is attested;
 *   3. the manifold's `s/*` validators — an explicit, model-authored assertion
 *      (arrival-manifold/src/bind.ts) whose identity-return rides site 1's walk.
 *
 * Enforcement lives wholly in arrival-manifold's tool boundary; core arrival only
 * carries the registry + the stamps. Attesting values no manifold ever inspects
 * (e.g. `infer` results outside a manifold env) is deliberate and harmless.
 */

import { AValue } from "./primitives/AValue.js";
import { schemeFalse, schemeTrue } from "./primitives/ABool.js";
import { ANil } from "./primitives/ANil.js";
import { AVoid } from "./primitives/AVoid.js";
import { ASymbol } from "./primitives/ASymbol.js";
import { APair } from "./primitives/APair.js";
import { AVector } from "./primitives/AVector.js";
import type { SchemeValue } from "./types.js";

const attested = new WeakSet<AValue>();

/** Shared-box families that must NEVER enter the registry (design §F2):
 *  - `ANil` / `AVoid` — "absent"/"unspecified" are not values a tool should receive
 *    as attested (and `AJSObject.get` returns the SHARED `nil` for missing keys —
 *    stamping it would attest every missing field in the program);
 *  - `ASymbol` — keywords are call syntax (consumed by the kwargs fold), never a
 *    payload; the per-run intern table makes them shared within a run;
 *  - the `schemeTrue`/`schemeFalse` flyweights — program-wide singletons; attest a
 *    FRESH clone instead (`freshIfSingleton`). A fresh `new ABool` is attestable. */
function refusesAttestation(v: AValue): boolean {
  return v instanceof ANil || v instanceof AVoid || v instanceof ASymbol || v === schemeTrue || v === schemeFalse;
}

/** Mark one value as attested. No-op (returns the value unattested) on non-AValues
 *  and on the refused shared-box families above. */
export function attest<V>(v: V): V {
  if (v instanceof AValue && !refusesAttestation(v)) attested.add(v);
  return v;
}

/** Is this exact box attested? `false` for anything that is not an AValue. */
export function isAttested(v: unknown): v is SchemeValue {
  return v instanceof AValue && attested.has(v);
}

/** The boolean escape hatch: a shared `schemeTrue`/`schemeFalse` flyweight is
 *  cloned (`withProvenance` always mints a fresh instance) so the CLONE can be
 *  attested without every `#t` in the program becoming attested. Everything else
 *  passes through unchanged (no sharing exists for the other primitives — F1).
 *  Used by the manifold's `s/boolean` AND by the machine stamp sites themselves:
 *  `fromJs` reuses the flyweights on the empty-provenance fast path, so a tool
 *  returning / a pluck minting a raw boolean would otherwise surface the
 *  unattestable singleton. */
export function freshIfSingleton(v: SchemeValue): SchemeValue;
export function freshIfSingleton(v: unknown): unknown;
export function freshIfSingleton(v: unknown): unknown {
  if (v === schemeTrue) return schemeTrue.withProvenance(schemeTrue.provenance);
  if (v === schemeFalse) return schemeFalse.withProvenance(schemeFalse.provenance);
  return v;
}

function walk(v: unknown, seen: Set<unknown>): void {
  if (!(v instanceof AValue) || seen.has(v)) return;
  seen.add(v);
  attest(v);
  if (v instanceof APair) {
    walk(v.car, seen);
    walk(v.cdr, seen);
    return;
  }
  if (v instanceof AVector) {
    for (const el of v.__vector__) walk(el, seen);
  }
  // AJSObject / AJSArray: attest the WRAPPER only — their entries box lazily and
  // inherit at the pluck site (stamp site 2), so eager traversal here would defeat
  // the membrane's laziness (and `AJSArray.vec()` covers its own materialization).
}

/** Deep-attest a value: the container spine (`APair` chains, `AVector` elements)
 *  plus every leaf, in one pass — the attestation twin of the `jsToScheme`
 *  provenance deep-stamp, applied by `bakeRosetta`'s return walk so `car` /
 *  `vector-ref` on a tool result return already-attested STORED boxes. Lazy
 *  membrane wrappers are attested shallowly (see `walk`). Cycle-safe. */
export function attestDeep<V>(v: V): V {
  walk(v, new Set());
  return v;
}
