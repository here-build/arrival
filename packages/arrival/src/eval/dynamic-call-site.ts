/**
 * The ambient "dynamic call site" holder — extracted from evaluator.ts into its
 * own leaf so a module BELOW evaluator.ts in the import order can install one
 * without creating a cycle.
 *
 * Why this had to move: the reverse-membrane crossing (`rosetta.ts`'s
 * `schemeToJs` ACallable branch, `scheme-zod.ts`'s `z.procedure().decode`)
 * needs to install a dynamic call site around a re-entrant scheme call, so a lambda
 * invoked back from host JS nests its trace under the symbol invocation that
 * exported it instead of the lambda's definition-time lexical one. But
 * `eval/evaluator.ts` already imports `Environment.ts`, which imports
 * `createRosettaWrapper` from `rosetta.ts` (a VALUE import) — so `rosetta.ts`
 * importing anything back from `evaluator.ts` would close a real runtime cycle:
 * rosetta.ts → evaluator.ts → Environment.ts → rosetta.ts. Both sides import
 * THIS dependency-free leaf instead (the exact rationale `CallCtx.ts`'s own
 * extraction documents for the same class of cycle).
 *
 * Single-threaded JS makes a module-level holder safe; save/restore around
 * each apply handles nesting — see evaluator.ts's `wrapLambda`/`wrapLambdaValue`
 * (the two HOF-boundary installers) and evaluatePair's direct-dispatch sites
 * for the existing usages this leaf now backs.
 */

/** Opaque tag for one dynamic evaluation of an AST node — the tap implementation
 *  (`provenance/trace.ts`'s `Invocation`) owns the real shape; this leaf and
 *  evaluator.ts only thread it through as an opaque parent pointer. */
export type Invocation = unknown;

let _dynamicCallSite: Invocation | undefined = undefined;

/** Read the current holder — the ALambda runner's synchronous prologue falls
 *  back to `ctx.currentInvocation` when this is unset (see evalLambda). */
export function currentDynamicCallSite(): Invocation | undefined {
  return _dynamicCallSite;
}

/** Raw, unconditional write — for the direct-dispatch sites (evaluatePair,
 *  applyArrowProc) that are themselves registering a genuine NEW call site
 *  rather than re-installing one for a HOF/reverse-crossing re-entry. Those
 *  sites save/restore by hand around this (no "prefer the deeper candidate"
 *  comparison — there is nothing to compare against, the call IS the site). */
export function setDynamicCallSite(site: Invocation | undefined): void {
  _dynamicCallSite = site;
}

/** Is `a` a strict descendant of `b` in the invocation tree? Walks `a`'s parent
 *  chain looking for `b`. Used to pick the deeper of two candidate dynamic call
 *  sites — see {@link withDynamicCallSite}. */
export function isStrictDescendant(a: Invocation | undefined, b: Invocation | undefined): boolean {
  if (!a || !b) return false;
  // `Invocation` is opaque (`unknown`) here — the tap owns its shape — but every
  // tap invocation exposes a `parent` link; narrow structurally to walk it.
  type ParentLinked = { parent: ParentLinked | null };
  for (let p = (a as ParentLinked).parent; p; p = p.parent) if (p === b) return true;
  return false;
}

/**
 * Install `dynSite` as the ambient dynamic call site for the duration of `fn`,
 * preferring the DEEPER of the current holder and `dynSite`: `dynSite` is a
 * candidate parent (a HOF boundary, or — for the reverse-membrane wrapper — the
 * symbol invocation a scheme callable was exported from); the current holder is
 * whatever the immediate caller already set. Keeping the current holder when
 * it's a descendant nests genuinely-deeper work under itself instead of
 * scattering it to the outer boundary (needed for a TCO loop calling a
 * passed-in lambda — see evaluator.ts's `wrapLambda` doc for the full case).
 */
export function withDynamicCallSite<T>(dynSite: Invocation | undefined, fn: () => T): T {
  const saved = _dynamicCallSite;
  _dynamicCallSite = isStrictDescendant(saved, dynSite) ? saved : dynSite;
  try {
    return fn();
  } finally {
    _dynamicCallSite = saved;
  }
}
