/**
 * STAGE-0 RUNTIME MODULE — Scheme-texture shims the cold tail cannot take from
 * ramda (Law T, n-ary folds, list-ref arg order, eq?/equal? identity, infer stubs).
 * Cold HOF/structural symbols live on **ramda** via `runtime-manifest.ts`.
 *
 * The oracle copies this file into the scratch project: **self-contained, zero
 * imports**, dependency-free strict TS. Emitting projects also import `ramda`
 * when RuntimeRefs resolve there.
 *
 * Membrane JS faces (§2.1): lists are arrays, `#f` is `false`, numbers are
 * `number`. Law T: only `#f` is false for every/any/some. Grow stage0 only for
 * symbols that must stay here — prefer a `RUNTIME_MANIFEST` ramda row first.
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

/** `error` — throws; never returns. Replaces the oracle harness's dual-path
 *  `COMPILED_PREAMBLE` shim on the greenfield path. */
export function error(message: unknown, ...irritants: unknown[]): never {
  throw new SchemeUserError(message, irritants);
}

// ─── constructors / string ops ────────────────────────────────────────────────────────

/** `list` — variadic construction; the array IS the list (§2.1). */
export const list = (...xs: unknown[]): unknown[] => xs;

/**
 * `cons` — the UNKNOWN-tail case `consEmitRule`'s fact gate cannot resolve
 * statically (foundations/arrival/arrival/src/env/r7rs/lists.ts): a tail PROVEN
 * list/pair spreads inline (`[x, ...xs]`) and a tail PROVEN scalar is a bare
 * 2-element literal (`[x, xs]`), both without ever reaching this shim. This is
 * the total, always-correct fallback for a tail whose shape the type pass cannot
 * pin (an inferred or higher-order result, the common case for a real alist
 * entry) — array-backed spreads in, anything else becomes the second slot,
 * matching the interpreter's own uniform pair construction (a pair whose cdr is
 * a list IS that longer list, by Scheme's own equivalence).
 */
export const cons = (x: unknown, xs: unknown): unknown[] => (Array.isArray(xs) ? [x, ...xs] : [x, xs]);

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

/**
 * `chat/completion` — the LLM/MCP layer's real verb (`@inhuman.tools/llm-plane/arrival-env`'s
 * `chat.ts`), which replaced the whole `infer`/`infer/chat/*` family above (the retired
 * `arrival/infer` capability's own file). It declares no Contract-level `emit` (the layer's
 * whole package has none — verified directly, `grep -n "emit:" src/*.ts` over
 * `llm-plane-arrival-env` is empty), so a `(chat/completion …)` call falls to the walker's
 * rung-3 `RuntimeRef` shim exactly like the bare `infer` above did — and needs the SAME
 * manifest-row treatment for that name to resolve at all, independent of which framework
 * eventually answers the call. Same placeholder discipline: honestly async, throws rather
 * than fabricating a response.
 */
export async function chatCompletion(..._args: unknown[]): Promise<unknown> {
  throw new Error(
    "chat/completion: stage-0 has no inference backend yet — the framework axis (vercel/langchain) " +
      "is deferred past Phase 1 (constitution §4.3; phase1.ts's config.framework TODO).",
  );
}

// car/cdr value-position (RuntimeRef / eta): LOOSE nil-tolerance — empty → [] (nil face),
// not undefined and not R7RS throw. Call position uses the same algebra in phase1 carRule.
/** Loose `car` — empty sequence → nil (`[]`); else first element. */
export const car = (xs: readonly unknown[]): unknown => (xs.length === 0 ? [] : xs[0]);
/** Loose `cdr` — rest as array (empty → []). */
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
/** `list-ref` — keep stage0: ramda `nth` is index-first; scheme is list-first. */
export const listRef = (xs: readonly unknown[], k: number): unknown => xs[k];
export const max_ = (...ns: number[]): number => Math.max(...ns);
export const append_ = (...xss: readonly unknown[][]): unknown[] => xss.flat(1) as unknown[];

/**
 * `max-by` — list argmax by key (leftmost wins ties). Not ramda.maxBy (binary).
 * Interpreter: reduce over (cdr xs) seeded on (car xs); empty is UB.
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

/**
 * `string-ci=?` — R7RS §6.7 case-insensitive string equivalence, n-ary
 * (vacuously `#t` under 2 args). Mirrors the interpreter's own definition
 * verbatim (`foundations/arrival/arrival/src/env/r7rs/strings.ts`).
 */
export function stringCiEq(...ss: string[]): boolean {
  if (ss.length < 2) return true;
  const first = ss[0]!.toLowerCase();
  return ss.slice(1).every((s) => s.toLowerCase() === first);
}

// ── Env-native shims the live inhuman plane already has; emit must match. ─────
// R7RS / polyglot / SRFI names used by examples and notebooks. Membrane face:
// lists are arrays, dicts are plain objects (require json/yaml, schema'd output).

/** `number->string` — R7RS §6.7; radix optional (default 10). */
export const numberToString = (n: number, radix?: number): string =>
  radix === undefined ? String(n) : Number(n).toString(radix);

/** `string?` — R7RS type predicate. */
export const stringP = (v: unknown): boolean => typeof v === "string";

/** `string-join` — SRFI-13: (string-join list [delimiter]) → string. Default delimiter: space.
 *  Deliberately not LIPS `join` (sep-first) — that extension is out of the emit surface. */
export const stringJoin = (list: readonly unknown[], delimiter?: string): string =>
  list.map((x) => (x == null ? "" : String(x))).join(delimiter === undefined ? " " : delimiter);

/** `abs` — R7RS numeric. */
export const abs_ = (n: number): number => Math.abs(n);

/** `range` — plane helper: (range n) → (0 1 … n-1). */
export const range_ = (n: number): number[] => {
  const len = Math.max(0, Math.floor(Number(n)) || 0);
  const out: number[] = [];
  for (let i = 0; i < len; i++) out.push(i);
  return out;
};

/**
 * `@` — polyglot member read. Loose emit face: plain objects / arrays.
 * Missing key → "" (same as the plane's `field` rosetta, not polyglot's nil).
 */
export function at(obj: unknown, key: unknown): unknown {
  if (obj == null) return "";
  const k = key == null ? "" : String(key).replace(/^:/, "");
  if (Array.isArray(obj)) {
    const i = Number(k);
    return Number.isInteger(i) && i >= 0 && i < obj.length ? obj[i] : "";
  }
  if (typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    return Object.hasOwn(rec, k) ? rec[k] : "";
  }
  return "";
}

/** `@values` — own member values (vector-as-array on the membrane). */
export const atValues = (obj: unknown): unknown[] =>
  obj != null && typeof obj === "object" && !Array.isArray(obj) ? Object.values(obj as object) : [];

/** `@keys` — own member keys. */
export const atKeys = (obj: unknown): string[] =>
  obj != null && typeof obj === "object" && !Array.isArray(obj) ? Object.keys(obj as object) : [];

// NOTE: do NOT re-export runtime-manifest from this file. The oracle copies
// stage0.ts verbatim into a scratch dir (self-contained, zero imports).
// Manifest lives only in ./runtime-manifest.ts.
