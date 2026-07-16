/**
 * STAGE-0 RUNTIME MODULE — the hand-written shim set for the slice's conservative
 * paths (constitution §4.4 "Stage 0"; §1(c): the cold tail compiles to *named imports
 * from a runtime module*, which is how humans also write code). This file is the
 * runtime SOURCE an emitted project imports: the oracle harness copies it verbatim
 * into each scratch project, so it must stay **self-contained — zero imports** — and
 * dependency-free strict TS.
 *
 * Everything here operates on the membrane's JS faces (§2.1 representation law):
 * lists/pairs/vectors are arrays, strings are primitives, `#f` is `false`, all
 * numbers are `number`. The interpreter's *boxed* impls do not transfer (§4.4);
 * these bodies re-state the same semantics over the collapsed representation.
 * One consequence is permanent and documented rather than papered over: boxed-string
 * IDENTITY is unobservable post-collapse, so `(eq? "ab" (string-append "a" "b"))`
 * — interpreter `#f` — is `#t` compiled (the `eq-vs-equal-string-eq` corpus row
 * stays a catalogued divergence; `equal?` agrees on both sides).
 *
 * Scheme truthiness rules every predicate-shaped consumer here (Law T): only `#f`
 * is false — a result is kept/accepted unless it `=== false`, never by JS coercion.
 * `every`/`any` are the SRFI-1 value-RETURNING forms (last result / first witness),
 * matching the interpreter's honest any?/every? split.
 *
 * The export set is **corpus-driven** — exactly the symbols the walker's rung-3
 * `RuntimeRef` shims reach in the current oracle corpus — not an attempt at the
 * 186-symbol preamble (that is Phase 3's self-hosting, §4.4 Stage 1). Growing it
 * is always the same two-line move: add the export, add its `STAGE0` manifest row.
 *
 * `STAGE0` is the shared symbol→export manifest FRAME consumes (§3.4 frame-as-query):
 * scheme names are not JS identifiers (`eq?`, `>`, `string-append`), so the module
 * exports SAFE names and the manifest is the one place the mapping lives.
 */

// ─── equality walkers (Appendix B: operator-identity cells) ───────────────────────────

/**
 * `eq?` — identity. `Object.is` is the honest JS-face identity: reference identity
 * for objects/arrays, sentinel-faithful for numbers (`NaN`≡`NaN`, `-0`≢`+0` — the
 * eqv? rows' texture, which R7RS permits eq? to share).
 */
export const eqP = (a: unknown, b: unknown): boolean => Object.is(a, b);

/**
 * `eqv?` — `Object.is`-shaped by the interpreter's own semantics (Appendix B
 * runtime-sentinel rows: `(eqv? NaN NaN)` → `#t`, `(eqv? -0.0 0.0)` → `#f`).
 * On the collapsed representation eqv? and eq? coincide.
 */
export const eqvP = (a: unknown, b: unknown): boolean => Object.is(a, b);

/** Dict faces are plain objects (or null-proto); anything class-shaped falls through
 *  to identity — the same gate the oracle comparator uses. */
const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * `equal?` — deep structural equality over the membrane faces: arrays recursively,
 * bytevectors (`Uint8Array`) element-wise, dict faces key-set + recursive values,
 * scalars via `Object.is` (so `equal?` inherits eqv?'s NaN/-0 texture, per R7RS
 * "equal? applies eqv? to non-compound data"). Acyclic by the immutability law
 * (§2.2) — no seen-set, no Floyd guard.
 */
export function equalP(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => equalP(x, b[i]));
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && equalP(a[k], b[k]));
  }
  return false;
}

// ─── member / assoc (R7RS §6.4 — equal?-keyed; the list-tail / entry-pair shapes) ─────

/**
 * `member` — the TAIL of the list from the first `equal?` match (`(member 2 '(1 2 3))`
 * → `[2, 3]`), else `#f`. Interpreter-verified through the oracle's member-assoc row.
 */
export function member(x: unknown, xs: readonly unknown[]): unknown[] | false {
  for (let i = 0; i < xs.length; i++) {
    if (equalP(x, xs[i])) return xs.slice(i);
  }
  return false;
}

/**
 * `assoc` — the first entry (pair-as-array) whose car `equal?`s the key
 * (`(assoc 2 '((1 "a") (2 "b")))` → `[2, "b"]`), else `#f`. A non-array entry is
 * skipped rather than thrown on (Law U: malformed alists are outside the contract).
 */
export function assoc(x: unknown, alist: readonly unknown[]): unknown | false {
  for (const entry of alist) {
    if (Array.isArray(entry) && equalP(x, entry[0])) return entry;
  }
  return false;
}

// ─── error (R7RS §6.11) — the user-error raise ────────────────────────────────────────

/**
 * The compiled world's `(error message irritant …)` object. The class NAME is the
 * oracle classifier's contract (`classifyCompiledError` → `"user-error"`): keep
 * `SchemeUserError` stable or update the classifier in the same change.
 */
export class SchemeUserError extends Error {
  readonly irritants: readonly unknown[];
  constructor(message: unknown, irritants: readonly unknown[]) {
    super(String(message));
    this.name = "SchemeUserError";
    this.irritants = irritants;
  }
}

/** `error` — throws; never returns. Replaces the oracle harness's legacy-path
 *  `COMPILED_PREAMBLE` shim on the greenfield path. */
export function error(message: unknown, ...irritants: unknown[]): never {
  throw new SchemeUserError(message, irritants);
}

// ─── constructors / string ops ────────────────────────────────────────────────────────

/** `list` — variadic construction; the array IS the list (§2.1). */
export const list = (...xs: unknown[]): unknown[] => xs;

/** `string-append` — concatenation over primitive strings. */
export const stringAppend = (...ss: string[]): string => ss.join("");

// ─── SRFI-1 every / any — value-returning, Law-T truthiness ──────────────────────────

/**
 * `every` — `#t` for empty input, else the LAST predicate result (value-returning:
 * `(every (lambda (x) x) '(1 2))` → `2`), short-circuiting on the first `#f`.
 * N-ary over parallel lists, driving off the shortest.
 */
export function every(pred: (...xs: unknown[]) => unknown, ...lists: readonly (readonly unknown[])[]): unknown {
  if (lists.length === 0) return true;
  const n = Math.min(...lists.map((l) => l.length));
  let last: unknown = true;
  for (let i = 0; i < n; i++) {
    last = pred(...lists.map((l) => l[i]));
    if (last === false) return false;
  }
  return last;
}

/**
 * `any` — the first Scheme-truthy predicate RESULT (the witness: `(any f '(0 2))`
 * → `f`'s result at `2`, not `#t`), else `#f`.
 */
export function any(pred: (...xs: unknown[]) => unknown, ...lists: readonly (readonly unknown[])[]): unknown {
  if (lists.length === 0) return false;
  const n = Math.min(...lists.map((l) => l.length));
  for (let i = 0; i < n; i++) {
    const r = pred(...lists.map((l) => l[i]));
    if (r !== false) return r;
  }
  return false;
}

/**
 * `some` — NOT `any`'s value-returning twin, despite the shared shape. Verified
 * against the interpreter (srfi-1.ts): `some` aliases `any?`, the HONEST boolean
 * quantifier — plain `#t` iff `pred` holds (Law T: result `!== false`) for SOME
 * element-tuple across the parallel lists, short-circuiting on the first hit;
 * never the witness. N-ary, min-length-driven, same parallel-list convention as
 * `every`/`any` above.
 */
export function some(pred: (...xs: unknown[]) => unknown, ...lists: readonly (readonly unknown[])[]): boolean {
  if (lists.length === 0) return false;
  const n = Math.min(...lists.map((l) => l.length));
  for (let i = 0; i < n; i++) {
    if (pred(...lists.map((l) => l[i])) !== false) return true;
  }
  return false;
}

// ─── infer — placeholder ONLY (the framework axis is a later phase) ──────────────────
/**
 * `infer` — the call-position emit rule (`phase1.ts`'s `inferRule`) always emits
 * `Call(RuntimeRef("infer"), args)`, so FRAME needs a manifest row for this symbol
 * to resolve at all, independent of which framework eventually answers the call.
 * The real per-framework residual (`ctx.config.framework === "vercel" ? … :
 * langchain …`) is an explicit TODO in `phase1.ts` ("do NOT land in this wave —
 * the stage-0 runtime shim owns the framework axis: one `infer` export whose
 * body dispatches"): that dispatch is NOT built here. This export exists solely
 * so async-seeded programs (`inferAsyncSeeds` — Gate-3's async-map golden) can
 * compile and render end to end; it is honestly async (satisfying ASYNC-IFY's
 * seed contract — the symbol's runtime target DOES return a Promise) and throws
 * rather than pretending to answer, so nothing silently fabricates a model
 * response. Replace with the real framework dispatch when phase1.ts's TODO lands.
 */
export async function infer(..._args: unknown[]): Promise<unknown> {
  throw new Error(
    "infer: stage-0 has no inference backend yet — the framework axis (vercel/langchain) " +
      "is deferred past Phase 1 (constitution §4.3; phase1.ts's config.framework TODO).",
  );
}

/**
 * `infer/scalar` / `infer/chat/scalar` — the infer-scalar-fold PEEPHOLE's targets
 * (../peepholes/infer.ts; `phase1.ts`'s `inferRule("infer/scalar")` /
 * `inferRule("infer/chat/scalar")` rows): `(car (infer m p))` folds at compile
 * time to `App(infer/scalar, [m, p])`, so — exactly like the bare `infer` export
 * above — FRAME needs a manifest row for the FOLDED name to resolve at all,
 * independent of which framework eventually answers the call. Same placeholder
 * discipline as `infer`: honestly async (both fold-targets are `inferAsyncSeeds`
 * members — the ASYNC-IFY seed contract needs a real Promise-returning target),
 * throws rather than fabricating a response. The one thing that WILL differ once
 * the real framework dispatch lands (phase1.ts's TODO): these two return the bare
 * completion directly, never `infer`'s one-element list wrap — the peephole's own
 * doc calls this out as "the SYMBOL NAME already carries that fact," i.e. the
 * future dispatch body reads its own export name to decide unwrap-vs-wrap, no
 * compiler-side branching needed. Not built here; these stay throwing stubs until
 * that TODO lands.
 */
export async function inferScalar(..._args: unknown[]): Promise<unknown> {
  throw new Error(
    "infer/scalar: stage-0 has no inference backend yet — the framework axis (vercel/langchain) " +
      "is deferred past Phase 1 (constitution §4.3; phase1.ts's config.framework TODO).",
  );
}

export async function inferChatScalar(..._args: unknown[]): Promise<unknown> {
  throw new Error(
    "infer/chat/scalar: stage-0 has no inference backend yet — the framework axis (vercel/langchain) " +
      "is deferred past Phase 1 (constitution §4.3; phase1.ts's config.framework TODO).",
  );
}

// ─── car / cdr in VALUE position (§2.1 representation collapse) ──────────────────────
// Call position NEVER reaches here — the `car`/`cdr` emit rules fold inline to
// `xs[0]` / `xs.slice(1)` unconditionally (constitution §4.3: "No guard, no shim,
// no mode"). These shims exist ONLY for first-class use as a bare HOF argument
// (`(map car xss)`) — `refPolicy: "eta"` degrades to a `RuntimeRef` shim until the
// instantiated-signature facts feed value position (walker's own module header,
// "this wave's 'eta'"), so the symbol must resolve to a real export or FRAME doors.

/** `car` in VALUE position (`(map car xss)`). */
export const car = (xs: readonly unknown[]): unknown => xs[0];

/** `cdr` in VALUE position (`(map cdr xss)`). */
export const cdr = (xs: readonly unknown[]): unknown[] => xs.slice(1);

// ─── numeric tail (corpus-driven; §7 one-number — plain JS arithmetic) ────────────────

/** `odd?` — integer parity, sign-safe (`(odd? -7)` → `#t`). */
export const odd = (n: number): boolean => Math.abs(n % 2) === 1;

/** `>` — n-ary strictly-decreasing chain (R7RS §6.2.6); vacuously true below 2 args. */
export function gt(...xs: number[]): boolean {
  for (let i = 1; i < xs.length; i++) {
    if (!(xs[i - 1]! > xs[i]!)) return false;
  }
  return true;
}

/** `+` in VALUE position (`(map + xs ys)`, `(apply + …)`'s generic tail): the
 *  variadic fold with the additive identity. Call position never reaches here —
 *  the `+` emit rule folds inline. */
export const plus = (...xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/**
 * `map` in VALUE position (`(apply map list rows)`): the n-ary zip, driving off the
 * FIRST list — the same length convention the `map` emit rule's index-zip inherits
 * (phase1-symbol-rules.md OQ4). Call position never reaches here.
 */
export function map(f: (...xs: unknown[]) => unknown, ...lists: readonly (readonly unknown[])[]): unknown[] {
  const first = lists[0] ?? [];
  return first.map((x, i) => (lists.length === 1 ? f(x) : f(...lists.map((l) => l[i]))));
}

// ─── the manifest — FRAME's symbol→export map (the one shared naming authority) ──────

/**
 * Scheme symbol → exported safe name. FRAME resolves every `RuntimeRef` census entry
 * through this record and doors on a miss, so an export without a row here is
 * unreachable and a row without an export is a loud import-time error — the two
 * stay in lockstep by construction of this one file.
 */

/** `null?`'s total semantics — the shim rung for an UNPROVEN argument (Law F):
 *  only the empty LIST is null; a string (which also carries `.length`) is not.
 *  The clean `xs.length === 0` form emits only under a proven list fact. */
export const nullP = (v: unknown): boolean => Array.isArray(v) && v.length === 0;

/** `pair?`'s total semantics — see `nullP`; a non-empty ARRAY, nothing else. */
export const pairP = (v: unknown): boolean => Array.isArray(v) && v.length > 0;


// ── Corpus-driven growth (constitution §4.4): the gate1 real programs' FRAME
// doors named these exact exports. Comparisons/predicates are shim-tier today;
// the hot ones graduate to Contract emit rules with the next relocation batch. ──

export const lt = (a: number, b: number): boolean => a < b;
export const le = (a: number, b: number): boolean => a <= b;
export const ge = (a: number, b: number): boolean => a >= b;
export const zeroP = (n: number): boolean => n === 0;
export const evenP = (n: number): boolean => Math.abs(n % 2) === 0;
export const length_ = (xs: readonly unknown[]): number => xs.length;
export const listRef = (xs: readonly unknown[], k: number): unknown => xs[k];
export const max_ = (...ns: number[]): number => Math.max(...ns);
export const append_ = (...xss: readonly unknown[][]): unknown[] => xss.flat(1) as unknown[];

/**
 * `max-by` — argmax by key function (`(max-by total pool)`): the element of `xs`
 * maximizing `f`, ties going to the FIRST (leftmost) element attaining the max.
 * Mirrors the interpreter's own scheme-bodied definition verbatim
 * (`@inhuman.tools/arrival-run`'s `run-program.ts`, `BUILTIN_PREAMBLE`:
 * `(reduce (lambda (x best) (if (> (f x) (f best)) x best)) (car xs) (cdr xs))`
 * — max-by is not a Contract anywhere, just scheme prelude text): a strict `>`
 * fold seeded on the first element never lets a later TIE displace an earlier
 * max. `xs` empty is outside the contract — the interpreter's own `(car xs)`
 * seed is equally undefined on `'()` (§2.1 UB parity; no guard added here that
 * the reference doesn't have either).
 */
export function maxBy(f: (x: unknown) => number, xs: readonly unknown[]): unknown {
  let best = xs[0];
  let bestKey = f(best);
  for (let i = 1; i < xs.length; i++) {
    const key = f(xs[i]);
    if (key > bestKey) {
      best = xs[i];
      bestKey = key;
    }
  }
  return best;
}

export const STAGE0: Readonly<Record<string, string>> = {
  "<": "lt",
  "<=": "le",
  ">=": "ge",
  "zero?": "zeroP",
  "even?": "evenP",
  length: "length_",
  "list-ref": "listRef",
  max: "max_",
  append: "append_",
  "null?": "nullP",
  "pair?": "pairP",
  "eq?": "eqP",
  "eqv?": "eqvP",
  "equal?": "equalP",
  member: "member",
  assoc: "assoc",
  error: "error",
  list: "list",
  "string-append": "stringAppend",
  every: "every",
  any: "any",
  some: "some",
  "max-by": "maxBy",
  "odd?": "odd",
  ">": "gt",
  "+": "plus",
  map: "map",
  car: "car",
  cdr: "cdr",
  infer: "infer",
  "infer/scalar": "inferScalar",
  "infer/chat/scalar": "inferChatScalar",
};
