// typed-scanner-async — Σ∩T for the GENERATION path (pure kernel, primitive 1):
// wrap a structural+Σ OracleScanner so `validSymbols()` is narrowed by an ASYNC
// type lens without ever blocking the (synchronous) mask callback.
//
// THE TIMING MODEL (why async is enough): a LogitsProcessor's mask callback is
// synchronous — it cannot await — but the type-valid set is a property of the
// SLOT (which call, which argument), not of the token. Slots change every few
// tokens; between mask callbacks sits an awaited forward pass (50–150ms on
// device) during which the worker's event loop is free — exactly where a
// co-located tsgo instance computes. So:
//   • cache HIT → the narrowed set serves synchronously (full Σ∩T mask);
//   • cache MISS → kick the async fill, return Σ UN-narrowed for this step —
//     CONSERVATIVE by the T contract (T only ever drops provably-ill-typed
//     candidates; serving Σ admits a superset, never a wrong restriction) —
//     and by the next mask callback the fill has usually landed.
// The first token of a brand-new slot is Σ-gated, every later token Σ∩T-gated.
// `telemetry` makes the degrade observable; `settle()` awaits quiescence
// (tests, and pre-generation warmup of the prompt's slot).
//
// Mirrors typed-scanner.ts (the SYNC lens adapter on the type-lens side)
// semantically: same gate (mid-token application argument), same slot-prefix
// memoization, same pass-throughs. Lives in the SAMPLER because it depends
// only on the structural scanner contract + an injected async lens — the tsgo
// lens is browser-safe, so the whole Σ∩T generation stack now bundles for the
// generator worker.

import type { OracleScanner, OracleState } from "./oracle-types.js";
import { valueAsSchemeAtom } from "./scheme-atoms.js";

/** The (async) type-lens surface this adapter needs — the tsgo lens and the
 *  worker-RPC twin of service-core both satisfy it.
 *
 *  TWO orthogonal narrowings, two triggers (the `analyze` body composes them):
 *   • `getTypeValidCandidates` narrows Σ MID-TOKEN (a partial symbol is being
 *     typed) — Σ∩T over the bound-symbol set.
 *   • `getSlotIsArray` stamps the slot's list-vs-scalar shape at the value-slot
 *     BOUNDARY (the value is about to OPEN) — feeds the PRECISE list-structure
 *     gate (`violatesValueStructure`). A step may need BOTH (boundary stamp this
 *     step, Σ-narrowing the next), so the two caches are independent. */
export interface AsyncTypeLens {
  getTypeValidCandidates(scheme: string, schemeOffset: number, candidates: readonly string[]): Promise<string[]>;
  /** Is the value slot at `schemeOffset` a LIST/array TS type? `true` ⇒ a value here must be a list
   *  materializer (scalar literals are masked), `false` ⇒ a scalar (list literals are masked), `null`
   *  ⇒ unresolved (the gate stays a no-op). See `OracleState.slotIsArray`. */
  getSlotIsArray(scheme: string, schemeOffset: number): Promise<boolean | null>;
  /** Does the value slot at `schemeOffset` ADMIT A BARE WORD AS A STRING? `true` ⇒ a free-form
   *  `string`/`any` slot — the Σ gate exempts a bare value-word here (it lowers to the string), `false`
   *  ⇒ number/boolean/object/array (a bare word stays Σ-masked), `null` ⇒ unresolved (the exemption stays
   *  inert). See `OracleState.slotIsStringy`. */
  getSlotAcceptsBareWord(scheme: string, schemeOffset: number): Promise<boolean | null>;
  /** The ELEMENT-type verdict at an ARRAY-ELEMENT cursor (CUT A) — recovered DESPITE the array surface
   *  (`(list …)` lowers to a generic `unknown` param; `'(…)` lowers to a quote with no enclosing call).
   *  `{ isStringy: true }` ⇒ a free-form string/any element — FORCE the quoted form (mask a bare-word /
   *  nested-list start). `{ enum: [...] }` ⇒ a closed string-literal element — narrow to those members. Both
   *  `null` ⇒ not an array element / unresolved (the element gate stays inert). See `OracleState.elementIsStringy`. */
  getSlotElementType(
    scheme: string,
    schemeOffset: number,
  ): Promise<{ isStringy: boolean | null; enum: string[] | null }>;
  /** Does the HEAD `head` (in `scheme`'s scope) PROVABLY return a LIST/array? `true` ⇒ a `list`/`vector`/
   *  `append` materializer (its result is an array), `false` ⇒ an element/scalar/non-callable head, `null`
   *  ⇒ unresolved. Feeds the TYPE-REACHABILITY gate (`OracleState.arrayReturningHeads`). OPTIONAL — a lens
   *  that omits it leaves the reachability arm a no-op (the `(head` opener stays admitted, superset-safe). */
  getHeadReturnsArray?(scheme: string, head: string): Promise<boolean | null>;
  /** Is the value slot at `schemeOffset` STRING-TYPED (`__E` a subtype of `string` — `string` or a closed
   *  string-literal enum — and NOT an array)? `true` ⇒ a non-string scalar literal (`#t`/`#f`, a number) is
   *  masked, `false` ⇒ number/boolean/object/array, `null` ⇒ unresolved. Feeds the structure gate
   *  (`OracleState.slotIsStringTyped`). OPTIONAL — omitting it leaves the non-string-literal masking inert. */
  getSlotIsStringTyped?(scheme: string, schemeOffset: number): Promise<boolean | null>;
}

const ATOM = /[^\s()[\]{}"';]/; // an atom character (arrival's lexer)

/** The trailing run of atom characters at the end of `s` (the partial symbol
 *  being typed), or "". */
function trailingAtom(s: string): string {
  let i = s.length;
  while (i > 0 && ATOM.test(s[i - 1])) i--;
  return s.slice(i);
}

/** The text BEFORE the innermost still-open `(`/`[` of `s` — the ENCLOSING form's slot prefix at a NESTED
 *  operator. At `(get_route (` (or `(get_route (l`) this is `(get_route ` (the enclosing `get_route` arg
 *  slot); the enclosing slot's array-ness then decides whether a list head is a dead end here. String- and
 *  comment-aware (a `(` inside a string is not a form opener). Returns `null` when the cursor is NOT inside an
 *  open form (top-level operator — no enclosing slot to consult). */
function enclosingSlotPrefix(s: string): string | null {
  const openStack: number[] = []; // indices of currently-open `(`/`[`
  let inStr = false;
  let escape = false;
  let inLineComment = false;
  for (const [i, c] of [...s].entries()) {
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inStr) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inStr = false;
      continue;
    }
    switch (c) {
      case '"':
        inStr = true;
        break;
      case ";":
        inLineComment = true;
        break;
      case "(":
      case "[":
        openStack.push(i);
        break;
      case ")":
      case "]":
        openStack.pop();
        break;
      default:
        break;
    }
  }
  const innermostOpen = openStack.at(-1);
  if (innermostOpen === undefined) return null; // top-level — no enclosing form
  return s.slice(0, innermostOpen);
}

interface AsyncTypedScannerTelemetry {
  /** Mask steps served the full Σ∩T set from the slot cache. */
  slotHits: number;
  /** Mask steps served Σ-only because the slot's fill was still in flight. */
  sigmaFallbacks: number;
  /** Slot fills started. */
  fillsStarted: number;
  /** Slot fills landed (cache populated). */
  fillsLanded: number;
  /** Fills that rejected (lens error) — the slot stays Σ-only, loudly. */
  fillErrors: number;
}

/** The subset of {@link AsyncTypedScanner} the decode loop force-narrows to before its candidate walk: the
 *  Σ∩T warm-up entry point. An {@link OracleScanner} exposes `prefill` IFF it is an async typed scanner (the
 *  sole implementor), so {@link hasPrefill} lets the greedy descent + branch arm-decode await the slot fill
 *  for the current prefix without asserting — or importing — the full async surface (telemetry/settle). */
export interface PrefillCapableScanner extends OracleScanner {
  /** Pre-warm the slot at the end of `prefix` (call before generate() so the
   *  PROMPT's slot is Σ∩T from token one). */
  prefill(prefix: string): Promise<void>;
}

/** Runtime guard for {@link PrefillCapableScanner} — replaces the `"prefill" in scanner` + structural cast
 *  the decode loop used. A sound narrowing (the typed-async scanner is the only `prefill` implementor) that
 *  both the shared greedy descent and the branch arm sub-decode gate their Σ∩T warm-up on. */
export function hasPrefill(scanner: OracleScanner): scanner is PrefillCapableScanner {
  return "prefill" in scanner && typeof scanner.prefill === "function";
}

export interface AsyncTypedScanner extends PrefillCapableScanner {
  readonly telemetry: AsyncTypedScannerTelemetry;
  /** Resolves when every in-flight slot fill has settled. */
  settle(): Promise<void>;
}

/**
 * Wrap `base` so `analyze(s).validSymbols()` is intersected with the lens's
 * type-valid set once the slot's ASYNC fill lands; Σ-only (un-narrowed)
 * until then. Narrowing applies ONLY at a Σ-constrained APPLICATION ARGUMENT
 * slot — operators and non-application contexts pass through unchanged.
 */
export function narrowByTypeAsync(base: OracleScanner, lens: AsyncTypeLens): AsyncTypedScanner {
  // Σ∩T validSymbols narrowing (mid-token): slotPrefix → narrowed bound-symbol set.
  const cache = new Map<string, ReadonlySet<string>>();
  const pending = new Map<string, Promise<void>>();
  // List-structure verdict (value-slot boundary): slotPrefix → array-ness. An INDEPENDENT cache —
  // a step may need both (this step's boundary stamp, next step's Σ narrowing). A miss leaves
  // `slotIsArray` undefined ⇒ the precise structure gate stays a no-op (superset-safe).
  const arrayCache = new Map<string, boolean | null>();
  const arrayPending = new Map<string, Promise<void>>();
  // Scalar-string verdict (value-slot boundary): slotPrefix → "admits a bare word as a string". A THIRD
  // independent cache (alongside `cache` for Σ∩T and `arrayCache` for the structure gate) — the three
  // verdicts are distinct lens queries that may all be needed at one slot. A miss leaves `slotIsStringy`
  // undefined ⇒ the Σ exemption stays inert (superset-safe — the bare word stays Σ-gated).
  const stringyCache = new Map<string, boolean | null>();
  const stringyPending = new Map<string, Promise<void>>();
  // String-TYPED verdict (value-slot boundary): slotPrefix → "the slot's type is a subtype of string (a
  // free-form string OR a closed string-literal enum), not an array". A FIFTH independent cache. Distinct
  // from `stringyCache` (free-form-string-only, the bare-word exemption): an ENUM is stringTyped=true but
  // stringy=false. A miss leaves `slotIsStringTyped` undefined ⇒ the non-string-literal masking stays inert.
  const stringTypedCache = new Map<string, boolean | null>();
  const stringTypedPending = new Map<string, Promise<void>>();
  // Provably-array-returning HEADS (TYPE-REACHABILITY): slotPrefix → the subset of the slot's Σ symbols whose
  // ReturnType extends `readonly unknown[]` (`list`/`vector`/`append`). A SIXTH independent cache, computed
  // ONLY in a SCALAR context (a scalar value slot, or a nested operator whose enclosing slot is scalar). A
  // miss leaves `arrayReturningHeads` undefined ⇒ the reachability gate stays a no-op (the `(head` opener
  // stays admitted, superset-safe). The set is per-slot; the lens's per-head verdict is cached per (slot, head)
  // inside `headArrayCache` so a re-fill of the same slot re-uses landed head verdicts.
  const arrayHeadsCache = new Map<string, ReadonlySet<string>>();
  const arrayHeadsPending = new Map<string, Promise<void>>();
  // Per-(slotPrefix, head) array-return verdict — the building block the per-slot `arrayHeadsCache` folds. A
  // head's verdict is slot-independent (its ReturnType is the same everywhere), but keyed by slot too so a
  // landed verdict survives a slot's re-fill and the lens is asked at most once per (slot, head).
  const headArrayCache = new Map<string, boolean | null>();
  // Element-type verdict (array-element value-slot boundary, CUT A): slotPrefix → `{ isStringy, enum }`.
  // A FOURTH independent cache — the array-element force-quote / enum-narrow gate's source, recovered DESPITE
  // the array surface (`(list …)`'s `unknown` param, `'(…)`'s quote). A miss leaves both element axes
  // undefined ⇒ the element gate stays a no-op (superset-safe). Fires inside a QUOTE form too (the `'(…)`
  // surface), where the other three axes (application-argument-only) do not.
  const elementCache = new Map<string, { isStringy: boolean | null; enum: string[] | null }>();
  const elementPending = new Map<string, Promise<void>>();
  const telemetry: AsyncTypedScannerTelemetry = {
    slotHits: 0,
    sigmaFallbacks: 0,
    fillsStarted: 0,
    fillsLanded: 0,
    fillErrors: 0,
  };

  function startFill(slotPrefix: string, baseValid: ReadonlySet<string>): void {
    if (cache.has(slotPrefix) || pending.has(slotPrefix)) return;
    telemetry.fillsStarted += 1;
    const fill = lens
      .getTypeValidCandidates(slotPrefix, slotPrefix.length, [...baseValid])
      .then((valid) => {
        cache.set(slotPrefix, new Set(valid));
        telemetry.fillsLanded += 1;
        return undefined;
      })
      .catch(() => {
        // The slot stays Σ-only — conservative; counted, never thrown into
        // the mask path.
        telemetry.fillErrors += 1;
      })
      .finally(() => {
        pending.delete(slotPrefix);
      });
    pending.set(slotPrefix, fill);
  }

  /** Kick the slot's array-ness query (once per slotPrefix). Mirrors `startFill`: in-flight ⇒
   *  `slotIsArray` is left undefined this step (gate no-op); a lens error ⇒ cache `null` so the
   *  miss is permanent and the gate never restricts at this slot. */
  function startArrayFill(slotPrefix: string): void {
    if (arrayCache.has(slotPrefix) || arrayPending.has(slotPrefix)) return;
    const fill = lens
      .getSlotIsArray(slotPrefix, slotPrefix.length)
      .then((verdict) => {
        arrayCache.set(slotPrefix, verdict);
        return undefined;
      })
      .catch(() => {
        arrayCache.set(slotPrefix, null); // lens error ⇒ unknown forever ⇒ gate stays a no-op
      })
      .finally(() => {
        arrayPending.delete(slotPrefix);
      });
    arrayPending.set(slotPrefix, fill);
  }

  /** Kick the slot's bare-word-as-string query (once per slotPrefix). Mirrors `startArrayFill`: in-flight ⇒
   *  `slotIsStringy` is left undefined this step (exemption inert); a lens error ⇒ cache `null` so the miss
   *  is permanent and the exemption never fires at this slot (the bare word stays Σ-gated — superset-safe). */
  function startStringyFill(slotPrefix: string): void {
    if (stringyCache.has(slotPrefix) || stringyPending.has(slotPrefix)) return;
    const fill = lens
      .getSlotAcceptsBareWord(slotPrefix, slotPrefix.length)
      .then((verdict) => {
        stringyCache.set(slotPrefix, verdict);
        return undefined;
      })
      .catch(() => {
        stringyCache.set(slotPrefix, null); // lens error ⇒ unknown forever ⇒ exemption stays inert
      })
      .finally(() => {
        stringyPending.delete(slotPrefix);
      });
    stringyPending.set(slotPrefix, fill);
  }

  /** Kick the slot's string-TYPED query (once per slotPrefix). Mirrors `startStringyFill`. A lens that omits
   *  `getSlotIsStringTyped` ⇒ cache `null` (the masking stays inert). */
  function startStringTypedFill(slotPrefix: string): void {
    if (stringTypedCache.has(slotPrefix) || stringTypedPending.has(slotPrefix)) return;
    if (lens.getSlotIsStringTyped === undefined) {
      stringTypedCache.set(slotPrefix, null);
      return;
    }
    const fill = lens
      .getSlotIsStringTyped(slotPrefix, slotPrefix.length)
      .then((verdict) => {
        stringTypedCache.set(slotPrefix, verdict);
        return undefined;
      })
      .catch(() => {
        stringTypedCache.set(slotPrefix, null); // lens error ⇒ unknown forever ⇒ masking stays inert
      })
      .finally(() => {
        stringTypedPending.delete(slotPrefix);
      });
    stringTypedPending.set(slotPrefix, fill);
  }

  /** Kick the PROVABLY-ARRAY-RETURNING-HEADS query for the slot keyed `cacheKey`, resolving each head in
   *  `scopePrefix`'s scope (= `cacheKey` at a value slot; the ENCLOSING slot prefix at a nested operator —
   *  the head must type in the program context the call sits in). `heads` is the candidate head universe
   *  (the slot's Sigma). For each head not yet resolved, ask the lens whether its ReturnType is an array,
   *  caching per (cacheKey, head); land the array-returning subset under `cacheKey`. A lens that omits
   *  getHeadReturnsArray lands the EMPTY set (the reachability arm no-ops). A per-head lens error caches
   *  null (admit). The `headKey` separator is NUL — a char no scheme atom or prefix can contain — so a
   *  (cacheKey, head) pair never collides with a longer prefix's pair. ONE pending promise per slot. */
  function startArrayHeadsFillFor(cacheKey: string, scopePrefix: string, heads: ReadonlySet<string>): void {
    if (arrayHeadsCache.has(cacheKey) || arrayHeadsPending.has(cacheKey)) return;
    const getHead = lens.getHeadReturnsArray;
    if (getHead === undefined) {
      arrayHeadsCache.set(cacheKey, new Set());
      return;
    }
    const headKey = (head: string): string => `${cacheKey} ${head}`;
    const fill = (async (): Promise<void> => {
      await Promise.all(
        [...heads].map(async (head) => {
          const key = headKey(head);
          if (headArrayCache.has(key)) return;
          try {
            headArrayCache.set(key, await getHead(scopePrefix, head));
          } catch {
            headArrayCache.set(key, null); // lens error -> unknown -> admit (not array)
          }
        }),
      );
      const arrayHeads = new Set<string>();
      for (const head of heads) if (headArrayCache.get(headKey(head)) === true) arrayHeads.add(head);
      arrayHeadsCache.set(cacheKey, arrayHeads);
    })().finally(() => {
      arrayHeadsPending.delete(cacheKey);
    });
    arrayHeadsPending.set(cacheKey, fill);
  }

  /** Kick the slot's ELEMENT-type query (once per slotPrefix, CUT A). Mirrors `startStringyFill`: in-flight ⇒
   *  the element axes are left undefined this step (gate inert); a lens error ⇒ cache `{null,null}` so the
   *  miss is permanent and the element gate never fires at this slot (superset-safe). */
  function startElementFill(slotPrefix: string): void {
    if (elementCache.has(slotPrefix) || elementPending.has(slotPrefix)) return;
    const fill = lens
      .getSlotElementType(slotPrefix, slotPrefix.length)
      .then((verdict) => {
        elementCache.set(slotPrefix, verdict);
        return undefined;
      })
      .catch(() => {
        elementCache.set(slotPrefix, { isStringy: null, enum: null }); // lens error ⇒ inert forever
      })
      .finally(() => {
        elementPending.delete(slotPrefix);
      });
    elementPending.set(slotPrefix, fill);
  }

  function analyze(s: string): OracleState {
    const st = base.analyze(s);
    // The scalar axes (slotIsArray / slotIsStringy / slotIsStringTyped / Σ∩T) live only inside a
    // Σ-constrained APPLICATION ARGUMENT. The ELEMENT axis (CUT A) ALSO fires inside a QUOTE form — the
    // `'(…)` array surface (formKind quote). The TYPE-REACHABILITY axis (arrayReturningHeads) ALSO fires at a
    // NESTED OPERATOR whose ENCLOSING slot is scalar (the incremental `(get_route (` — a list head opened
    // after a committed `(`). Outside all three, pass straight through.
    const inAppArg = st.formKind === "application" && st.position === "argument";
    const inQuote = st.formKind === "quote";
    const inOperator = st.formKind === "application" && st.position === "operator";
    if (!inAppArg && !inQuote && !inOperator) return st;
    // The slot key: strip the partial atom being typed (boundary ⇒ trailingAtom "" ⇒ key = s), so a
    // boundary stamp and its mid-token continuations share ONE key across every cache.
    const slotPrefix = s.slice(0, s.length - trailingAtom(s).length);

    // ── TYPE-REACHABILITY at a NESTED OPERATOR — the incremental `(get_route (` (a `(` committed, the list
    //    head being opened). The base oracle reports operator/application identically to a top-level operator
    //    (no nesting depth in OracleState), so consult the ENCLOSING slot via the prefix: if the form this
    //    operator heads fills a SCALAR enclosing slot, stamp the provably-array head set so the gate masks a
    //    list head here. NOT at the argument site (that path stamps the set below alongside slotIsArray).
    let opArrayReturningHeads: ReadonlySet<string> | undefined;
    if (inOperator && !inAppArg) {
      const enclosing = enclosingSlotPrefix(slotPrefix);
      if (enclosing !== null) {
        const enclosingArr = arrayCache.get(enclosing);
        if (enclosingArr === undefined) startArrayFill(enclosing);
        else if (enclosingArr === false) {
          // The enclosing slot is scalar ⇒ a list head is a dead end here. Stamp the array-returning subset
          // of THIS operator's Σ (the candidate head universe), computed off the enclosing slot prefix (its
          // scope) — keyed by the operator slotPrefix so the gate reads it on this state.
          opArrayReturningHeads = arrayHeadsCache.get(slotPrefix);
          if (opArrayReturningHeads === undefined) {
            const heads = st.validSymbols();
            if (heads !== null && heads.size > 0) startArrayHeadsFillFor(slotPrefix, enclosing, heads);
          }
        }
      }
    }
    if (inOperator && !inAppArg && !inQuote) {
      // The nested-operator path stamps ONLY arrayReturningHeads (the other axes are argument/quote-only).
      if (opArrayReturningHeads === undefined) return st;
      return {
        midToken: st.midToken,
        position: st.position,
        formKind: st.formKind,
        closeable: st.closeable,
        overClosed: st.overClosed,
        validSymbols: st.validSymbols,
        arrayReturningHeads: opArrayReturningHeads,
      };
    }

    // (E) ELEMENT-type verdict (CUT A) — fires in BOTH the application-argument (`(list …)`) and the quote
    //     (`'(…)`) surfaces, at the BOUNDARY (the value is about to open) AND mid-atom (a bare word is being
    //     typed). Stamp the cached element verdict; a miss kicks the fill and leaves both axes undefined.
    const element = elementCache.get(slotPrefix);
    if (element === undefined) startElementFill(slotPrefix);
    const elementIsStringy = element?.isStringy ?? undefined;
    const elementEnum = element?.enum ?? undefined;

    // The scalar axes are APPLICATION-ARGUMENT-only (meaningless inside a quote's datum list).
    let slotIsArray: boolean | null | undefined;
    let slotIsStringy: boolean | null | undefined;
    let slotIsStringTyped: boolean | null | undefined;
    let argArrayReturningHeads: ReadonlySet<string> | undefined;
    let validSymbols = st.validSymbols;
    if (inAppArg) {
      // (A) List-structure verdict — fires at the BOUNDARY too (the value is about to open), so it does
      //     NOT require midToken. Stamp the cached array-ness; a miss kicks the fill.
      slotIsArray = arrayCache.get(slotPrefix);
      if (slotIsArray === undefined) startArrayFill(slotPrefix);

      // (A2) Scalar-string verdict — same BOUNDARY trigger (the Σ exemption decides at the value-opener AND
      //      mid-atom). Stamp the cached stringy-ness; a miss kicks the fill.
      slotIsStringy = stringyCache.get(slotPrefix);
      if (slotIsStringy === undefined) startStringyFill(slotPrefix);

      // (A3) String-TYPED verdict — same BOUNDARY trigger (the structure gate masks a non-string scalar
      //      literal — a `#`-literal / number — at a string/enum slot). Stamp it; a miss kicks the fill.
      slotIsStringTyped = stringTypedCache.get(slotPrefix);
      if (slotIsStringTyped === undefined) startStringTypedFill(slotPrefix);

      // (A4) TYPE-REACHABILITY at the value slot — when the slot is SCALAR (slotIsArray === false), stamp the
      //      provably-array-returning subset of Σ so the gate masks a GLUED list head (`(get_route (list`,
      //      one token). The head universe is this arg slot's Σ; the scope is the slot prefix itself.
      if (slotIsArray === false) {
        argArrayReturningHeads = arrayHeadsCache.get(slotPrefix);
        if (argArrayReturningHeads === undefined) {
          const heads = st.validSymbols();
          if (heads !== null && heads.size > 0) startArrayHeadsFillFor(slotPrefix, slotPrefix, heads);
        }
      }
    }

    // (B) Σ∩T validSymbols narrowing — only MID-TOKEN (a partial symbol is being typed). At a boundary Σ
    //     owns the operator/value distinction; nothing to narrow. CUT A: when the cursor is at an ENUM
    //     ELEMENT (`elementEnum` landed), intersect with the element members FIRST — the array analog of the
    //     scalar `getTypeValidCandidates` narrowing, reaching inside `(list …)` / `'(…)` which the outer-slot
    //     query cannot. Then the in-app-arg Σ∩T narrowing composes on top.
    if (st.midToken) {
      const baseValid = st.validSymbols();
      if (baseValid !== null && baseValid.size > 0) {
        // Element-enum narrowing (both surfaces): keep only Σ members in the element's enum domain. The domain
        // holds RAW string-literal VALUES (`"Scenic View"`) but Σ holds the value's SCHEME-ATOM spelling
        // (`Scenic_View`), so compare in atom space (project each member) — a direct membership test would drop
        // every multi-word member. An atom-clean member round-trips, so this is unchanged when no member carries
        // a separator. (The scalar `getTypeValidCandidates` narrowing reconciles the two via the symbol's TYPE;
        // the element domain cannot reach the symbol, so the projection is its analog.)
        if (elementEnum !== undefined && elementEnum !== null) {
          const members = new Set(elementEnum.map(valueAsSchemeAtom));
          const narrowed = new Set([...baseValid].filter((sym) => members.has(sym)));
          validSymbols = (): ReadonlySet<string> => narrowed;
        } else if (inAppArg) {
          const narrowed = cache.get(slotPrefix);
          if (narrowed === undefined) {
            startFill(slotPrefix, baseValid);
            telemetry.sigmaFallbacks += 1; // Σ-only this step — superset, never a wrong restriction
          } else {
            telemetry.slotHits += 1;
            validSymbols = (): ReadonlySet<string> => narrowed;
          }
        }
      }
    }

    // No type info landed for ANY axis ⇒ return the base state untouched (grammar-mode parity).
    if (
      validSymbols === st.validSymbols &&
      slotIsArray === undefined &&
      slotIsStringy === undefined &&
      slotIsStringTyped === undefined &&
      argArrayReturningHeads === undefined &&
      elementIsStringy === undefined &&
      elementEnum === undefined
    ) {
      return st;
    }
    return {
      midToken: st.midToken,
      position: st.position,
      formKind: st.formKind,
      closeable: st.closeable,
      overClosed: st.overClosed,
      validSymbols,
      ...(slotIsArray === undefined ? {} : { slotIsArray }),
      ...(slotIsStringy === undefined ? {} : { slotIsStringy }),
      ...(slotIsStringTyped === undefined ? {} : { slotIsStringTyped }),
      ...(argArrayReturningHeads === undefined ? {} : { arrayReturningHeads: argArrayReturningHeads }),
      ...(elementIsStringy === undefined ? {} : { elementIsStringy }),
      ...(elementEnum === undefined ? {} : { elementEnum }),
    };
  }

  async function drain(): Promise<void> {
    // Fills can cascade (a fill landing may not start new ones, but callers may analyze between
    // awaits) — drain ALL pending maps until quiet.
    while (
      pending.size > 0 ||
      arrayPending.size > 0 ||
      stringyPending.size > 0 ||
      stringTypedPending.size > 0 ||
      arrayHeadsPending.size > 0 ||
      elementPending.size > 0
    )
      await Promise.all([
        ...pending.values(),
        ...arrayPending.values(),
        ...stringyPending.values(),
        ...stringTypedPending.values(),
        ...arrayHeadsPending.values(),
        ...elementPending.values(),
      ]);
  }

  /** Kick the slot fills for the cursor at the END of `at`, keyed by the slot prefix (text minus the trailing
   *  atom). At a value slot (application argument): array / stringy / stringTyped / Σ∩T / element, plus — when
   *  the array verdict has ALREADY landed `false` (scalar) — the reachability head set. At a nested operator
   *  whose enclosing slot has landed `false` (scalar): the reachability head set (scope = the enclosing slot).
   *  The ELEMENT fill also warms in a QUOTE surface (CUT A). A no-op when `at`'s cursor warms nothing. The
   *  reachability fills are STAGED behind the array verdict, so `prefill` runs `warmSlotAt` twice (round 1
   *  lands the array verdict; round 2 kicks the head set). Used by `prefill` for the current + next-boundary
   *  slots. */
  function warmSlotAt(at: string): void {
    const st = base.analyze(at);
    const inAppArg = st.formKind === "application" && st.position === "argument";
    const inQuote = st.formKind === "quote";
    const inOperator = st.formKind === "application" && st.position === "operator";
    if (!inAppArg && !inQuote && !inOperator) return;
    const slotPrefix = at.slice(0, at.length - trailingAtom(at).length);
    if (inAppArg || inQuote) startElementFill(slotPrefix); // ELEMENT (CUT A) warms in both surfaces
    if (inAppArg) {
      startArrayFill(slotPrefix);
      startStringyFill(slotPrefix);
      startStringTypedFill(slotPrefix);
      const baseValid = st.validSymbols();
      if (baseValid !== null && baseValid.size > 0) startFill(slotPrefix, baseValid);
      // Reachability head set — only once the slot's array verdict has landed SCALAR (round 2 of prefill).
      if (arrayCache.get(slotPrefix) === false && baseValid !== null && baseValid.size > 0)
        startArrayHeadsFillFor(slotPrefix, slotPrefix, baseValid);
    } else if (inOperator) {
      // Nested operator: warm the ENCLOSING slot's array verdict, then (round 2) the head set in its scope.
      const enclosing = enclosingSlotPrefix(slotPrefix);
      if (enclosing !== null) {
        startArrayFill(enclosing);
        const heads = st.validSymbols();
        if (arrayCache.get(enclosing) === false && heads !== null && heads.size > 0)
          startArrayHeadsFillFor(slotPrefix, enclosing, heads);
      }
    }
  }

  return {
    feasible: (prefix) => base.feasible(prefix),
    analyze,
    telemetry,
    settle: drain,
    async prefill(prefix: string): Promise<void> {
      // Warm the slot(s) the NEXT token will land in. Two warm points, because a single model token
      // routinely CLOSES the current atom and OPENS the next argument slot in one step (the live ` men`
      // / ` '` token: the space closes `2021`, the rest opens the gender slot):
      //   (1) the CURRENT slot — `prefix`'s own slot (key = prefix minus its trailing atom). Serves a
      //       continuation that stays in this slot (mid-atom growth, or the value opening at a boundary).
      //   (2) the NEXT-BOUNDARY slot — `prefix + " "`'s slot, i.e. the slot reached once the current atom
      //       CLOSES. When the cursor is mid-atom at an argument (e.g. `…2021`), the next token's leading
      //       delimiter advances to a FRESH argument slot the current-slot key never covers; without this
      //       the gender slot's stringy/array verdict misses on the very token that opens it (the async gap
      //       that left the scalar-string Σ exemption + structure gate inert at the transition).
      // TWO rounds: round 1 kicks the array/stringy/etc. fills; after they drain, round 2 kicks the
      // reachability head-set fill (which depends on the array verdict landing first). A third drain settles.
      for (let round = 0; round < 2; round++) {
        warmSlotAt(prefix);
        warmSlotAt(`${prefix} `);
        await drain();
      }
    },
  };
}
