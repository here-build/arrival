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
  /** The argument slot's TS type is an array/list type — the precise list-structure gate's source.
   *  Stamped SYNCHRONOUSLY here so it is present the instant the (sync) mask reads it at the value-opener. */
  readonly slotIsArray?: boolean | null;
  /** The argument slot admits a bare word as a STRING — the scalar-string Σ exemption's source. Stamped
   *  SYNCHRONOUSLY here so it is present the instant the (sync) mask's Σ gate reads it. See
   *  `OracleState.slotIsStringy` in arrival-sampler. */
  readonly slotIsStringy?: boolean | null;
}
export interface Scanner {
  analyze(prefix: string): ScannerState;
  feasible(prefix: string): boolean;
}

/** The two methods of the language service this adapter needs — the value narrowing (Σ∩T) and the
 *  structure verdict (the list-structure gate). Both SYNC: the LS is sync, so the scanner is too. */
export interface TypeLens {
  getTypeValidCandidates(scheme: string, schemeOffset: number, candidates: readonly string[]): string[];
  getSlotIsArray(scheme: string, schemeOffset: number): boolean | null;
  getSlotAcceptsBareWord(scheme: string, schemeOffset: number): boolean | null;
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
  // slotPrefix → the slot's array-ness (the structure-gate source). Memoized per slot, like `cache`.
  const arrayCache = new Map<string, boolean | null>();
  // slotPrefix → the slot's stringy-ness (the scalar-string Σ-exemption source). Memoized per slot.
  const stringyCache = new Map<string, boolean | null>();
  return {
    feasible: (prefix) => base.feasible(prefix),
    analyze(s) {
      const st = base.analyze(s);
      // Act only inside an application ARGUMENT slot (Σ owns operators; T never adds a wrong restriction).
      if (st.formKind !== "application" || st.position !== "argument") return st;
      // The slot is fixed for the whole atom being typed → key by the prefix up to the atom start. At a
      // value BOUNDARY (no atom yet) the trailing atom is "" ⇒ slotPrefix = s, the slot about to open.
      const slotPrefix = s.slice(0, s.length - trailingAtom(s).length);

      // STRUCTURE — stamp the slot's array-ness, SYNCHRONOUSLY, at the boundary AND mid-atom (the gate
      // decides list-vs-scalar at the value-opener, a boundary the value-narrowing path skips). This is
      // the whole point of the sync scanner: the verdict is present the instant the sync mask reads it.
      let slotIsArray = arrayCache.get(slotPrefix);
      if (slotIsArray === undefined) {
        slotIsArray = lens.getSlotIsArray(slotPrefix, slotPrefix.length);
        arrayCache.set(slotPrefix, slotIsArray);
      }

      // SCALAR-STRING — stamp whether the slot admits a bare word as a string, SYNCHRONOUSLY, at the
      // boundary AND mid-atom (the Σ gate's exemption reads it while the bare word is being typed). Same
      // memoization as the array verdict; the verdict is present the instant the sync mask's Σ gate reads it.
      let slotIsStringy = stringyCache.get(slotPrefix);
      if (slotIsStringy === undefined) {
        slotIsStringy = lens.getSlotAcceptsBareWord(slotPrefix, slotPrefix.length);
        stringyCache.set(slotPrefix, slotIsStringy);
      }

      // VALUE (Σ∩T) — narrow validSymbols ONLY mid-atom (a partial symbol being typed), as before.
      let validSymbols = st.validSymbols;
      const baseValid = st.midToken ? st.validSymbols() : null;
      if (baseValid !== null && baseValid.size > 0) {
        let narrowed = cache.get(slotPrefix);
        if (narrowed === undefined) {
          narrowed = new Set(lens.getTypeValidCandidates(slotPrefix, slotPrefix.length, [...baseValid]));
          cache.set(slotPrefix, narrowed);
        }
        validSymbols = () => narrowed!;
      }

      // Reconstruct only the fields the mask consumes (see arrival-sampler/oracle-types.ts) + the two
      // type-stamped axes (slotIsArray for the structure gate, slotIsStringy for the Σ exemption).
      return {
        midToken: st.midToken,
        position: st.position,
        formKind: st.formKind,
        closeable: st.closeable,
        validSymbols,
        slotIsArray,
        slotIsStringy,
      };
    },
  };
}
