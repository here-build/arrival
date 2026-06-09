// typed-scanner.ts — the Σ∩T bridge: wrap a structural+Σ OracleScanner so its `validSymbols()`
// is narrowed by Layer T (getTypeValidCandidates). The sampler's mask machinery
// (isCandidateLive / passesSigma) is UNCHANGED — it just receives a smaller, type-valid symbol
// set, so a candidate whose value/return can't fill the current argument slot is masked out.
//
// WHY HERE (not in arrival-sampler): the sampler is browser-targeted and must stay light; the type
// lens pulls in the TypeScript compiler (node-only). So this adapter — which depends on BOTH — lives
// on the lens side, and a node-side runner composes `narrowByType(sigmaScanner, ls)` to get a
// type-aware scanner. In the browser, you use the bare Σ scanner; under node you wrap it.
//
// PERF: T is a TS round-trip — far too slow to run per vocab candidate. But the type-valid set is a
// property of the SLOT (which call, which argument), identical for every candidate extending the
// same cursor. So it is memoized by the slot prefix (the accepted text minus the atom being typed):
// one `getTypeValidCandidates` per decode step, reused across all candidates that step.

/** The structural OracleScanner surface this adapter consumes/produces — a subset of arrival's
 *  (and sift's) OracleScanner, kept structural so any real scanner satisfies it. */
export interface ScannerState {
  readonly midToken: boolean;
  readonly position: "top" | "operator" | "argument";
  readonly formKind: "top" | "application" | "lambda-list" | "quote" | "lazy-arm";
  readonly closeable: boolean;
  validSymbols(): ReadonlySet<string> | null;
}
export interface Scanner {
  analyze(prefix: string): ScannerState;
  feasible(prefix: string): boolean;
}

/** The only method of the language service this adapter needs. */
export interface TypeLens {
  getTypeValidCandidates(scheme: string, schemeOffset: number, candidates: readonly string[]): string[];
}

const ATOM = /[^\s()[\]{}"';]/; // an atom character (arrival's lexer: not ws / bracket / string / quote / comment)

/** The trailing run of atom characters at the end of `s` (the partial symbol being typed), or "". */
function trailingAtom(s: string): string {
  let i = s.length;
  while (i > 0 && ATOM.test(s[i - 1]!)) i--;
  return s.slice(i);
}

/**
 * Wrap `base` so `analyze(s).validSymbols()` is intersected with the Layer-T type-valid set at the
 * cursor's argument slot. Narrowing applies ONLY at a Σ-constrained APPLICATION ARGUMENT slot —
 * operators and non-application contexts pass through unchanged (Σ owns operators; T never adds a
 * wrong restriction). Conservative by construction: `getTypeValidCandidates` keeps any candidate it
 * can't prove ill-typed, so the narrowed set is never smaller than the truly-valid set.
 */
export function narrowByType(base: Scanner, lens: TypeLens): Scanner {
  // slotPrefix → the T-valid subset of that slot's Σ (as a Set). Memoized across the decode step.
  const cache = new Map<string, ReadonlySet<string>>();
  return {
    feasible: (prefix) => base.feasible(prefix),
    analyze(s) {
      const st = base.analyze(s);
      if (!st.midToken || st.formKind !== "application" || st.position !== "argument") return st;
      const baseValid = st.validSymbols();
      if (baseValid === null || baseValid.size === 0) return st; // Σ not modelled / empty — nothing to narrow.
      // The slot is fixed for the whole atom being typed → key by the prefix up to the atom start.
      const slotPrefix = s.slice(0, s.length - trailingAtom(s).length);
      let narrowed = cache.get(slotPrefix);
      if (narrowed === undefined) {
        narrowed = new Set(lens.getTypeValidCandidates(slotPrefix, slotPrefix.length, [...baseValid]));
        cache.set(slotPrefix, narrowed);
      }
      // Return a state identical except for the narrowed validSymbols. (Only the fields the mask
      // consumes are reconstructed — see arrival-sampler/oracle-types.ts.)
      return {
        midToken: st.midToken,
        position: st.position,
        formKind: st.formKind,
        closeable: st.closeable,
        validSymbols: () => narrowed!,
      };
    },
  };
}
