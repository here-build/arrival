/**
 * Host capability interface for SQL EFFECTS — the membrane through which a run's
 * `(sql/query …)` calls reach an external database.
 *
 * This is one protocol-family slice of the data-effect seam, the data-side twin of
 * {@link InferFn} (the `(infer …)` seam). The design principle is identical and
 * load-bearing:
 *
 *   The OSS engine knows the VERBS, never the CREDENTIALS.
 *
 * A program names a connection by **label** (intent) — `"analytics"` — and the
 * resolver maps that label to a DSN and a read-only role HOST-SIDE (the same
 * membrane the LLM keys cross: the interface vends BEHAVIOUR, not the secret).
 * Code stays portable and secret-free; the label→binding lives in the SaaS config
 * plane.
 *
 * INERT BY DEFAULT. Like the inference plane (an unbound infer store throws at the
 * first `(infer …)`), the sql verbs exist as forms but REJECT at call time until a
 * `SqlEffectResolver` is injected via `buildArrivalSession({ sql })`. The OSS
 * distribution ships the verbs disarmed: with no resolver the engine can `(require)`
 * and analyse a program that mentions `(sql/query …)`, but executing one throws a
 * teaching error (see {@link inertSqlResolver}) — it never silently no-ops, and it
 * never reaches a database.
 *
 * Single seam per family. There is exactly ONE host-contact point for the family: a
 * resolver receiving the canonical {@link SqlEffect}. Every effect a run performs is
 * one uniformly-shaped, content-addressable record, so the effect-log / replay
 * machinery treats a sql effect exactly as it treats infer (the kind-tagged key
 * algebra lives in `@inhuman.tools/arrival-effects`, which composes this family's
 * descriptor with its siblings into the `DataEffect` union).
 *
 * The credentialed resolver (label→connection lookup, envelope-decrypt, read-only
 * role) is host-private — it is NOT part of this OSS package. This module defines
 * only the contract those host-side implementations satisfy, plus the inert guard
 * that keeps the engine safe when no host is present.
 */

// Value-level `Nil` — defence for DIRECT-JS callers of the coercions below. In the
// exec path `schemeToJs(v, {})` lowers an empty scheme list (`(list)` / `'()`) to a
// JS `[]` at every depth, so a Nil instance never reaches these functions from a
// verb; the `instanceof ANil` arms cover a caller that hands over raw scheme values
// without the conversion pass. This couples only to the engine's own value type,
// which this pack already depends on package-wide.
import { ANil } from "@inhuman.tools/arrival";

/**
 * A SQL data effect — the INTENT a `(sql/query "label" "select …" (list …))` form
 * carries. SELECT-only is a v1 invariant enforced at the resolver / connection
 * role (a read-only DB role + single-statement extended protocol — see the
 * host-private egress node), NOT by string parsing here: the interface admits
 * the shape and the credentialed side guarantees read-only by construction.
 *
 * Params are a SEPARATE positional list — never string-interpolated into the
 * query — so the binding is injection-safe by construction (`$1`, `$2`, … bind to
 * `params[0]`, `params[1]`, …). Keeping params off the SQL text is the whole
 * safety property; the interface makes the separation structural.
 */
export interface SqlEffect {
  kind: "sql";
  /** Connection label — the code handle the resolver maps to a DSN + read-only role. */
  label: string;
  /** Parameterised SQL text. Placeholders bind positionally to `params`; the text
   *  itself never carries a caller value (that is what `params` is for). */
  query: string;
  /** Positional bind values, scalars only at v1 (already coerced from scheme).
   *  `$n` binds to `params[n-1]`. Empty list ⇒ a query with no placeholders. */
  params: readonly unknown[];
}

/**
 * Minimal structural view of the `EvalContext` a resolver receives — only the
 * current invocation it needs to mark a provenance point / bind node metadata.
 * Mirrors `InferFn`'s context arg; duck-typed to avoid pulling in the run engine's
 * full `Invocation`/trace types at the interface (the same one-way-cycle discipline
 * `rosetta.ts` uses for `InvocationLike`). Structurally identical to the sibling
 * families' context types (`HttpEffectContext`, arrival-effects' `DataEffectContext`)
 * so a combined host dispatcher composes the narrow seams without adapters.
 */
export interface SqlEffectContext {
  currentInvocation?: unknown;
}

/**
 * THE SEAM. A host injects ONE of these to arm the sql verbs; absent it, the
 * verbs are inert (see {@link inertSqlResolver}). Receives the eval context
 * (for tracing/provenance) and the canonical {@link SqlEffect}, performs the
 * credentialed materialisation host-side, and resolves to the raw value the verb
 * hands back to scheme (SQL ⇒ an array of row objects → a scheme list; the verb
 * membrane-wraps it on the way out, exactly as the `infer` seam does).
 *
 * This is deliberately the same SHAPE as {@link InferFn}: `(ctx, descriptor) →
 * Promise<value>`. A host that already routes `(infer …)` through its own plane
 * routes sql effects through the structurally-identical resolver — one membrane
 * idiom for every external effect a run performs.
 *
 * Contract obligations on the host implementation (NOT enforceable here — they
 * live on the host-private side and are stated so the membrane's guarantees
 * are explicit):
 *   - Resolve `label` → connection host-side; NEVER accept a raw DSN/key from
 *     the program (intent over materialisation — the program names, the host binds).
 *   - Enforce the read-only guarantee at the role layer (SELECT-only role + single
 *     statement) — the interface admits the shape; the host guarantees the safety.
 *   - SANITISE errors before they propagate: a thrown resolver error must not carry
 *     a DSN / key (it would otherwise land in the persisted Run and the logs).
 *     The engine surfaces whatever the resolver throws.
 */
export type SqlEffectResolver = (ctx: SqlEffectContext, effect: SqlEffect) => Promise<unknown>;

/**
 * Stable, human-readable name for a sql effect — `"sql analytics"`. Used in inert /
 * error messages and as a legible label for the effect node. NOT the content key
 * (the effect-log derives that from the full canonical descriptor incl. params);
 * this is the at-a-glance identity.
 */
export function describeSqlEffect(effect: SqlEffect): string {
  return `sql ${effect.label}`;
}

/**
 * The disarmed default. When `buildArrivalSession` is called WITHOUT a `sql`
 * resolver, the sql verbs route here and throw a teaching error at call time —
 * the data-side analogue of the inference plane's "no inference store bound"
 * invariant.
 *
 * Why throw-at-call rather than omit-the-verb: a missing symbol ("unbound
 * variable: sql/query") is opaque and looks like a typo; this names the real
 * condition (the capability isn't wired in THIS environment) and points at the
 * fix (inject a resolver). It also keeps the verb SURFACE identical whether or
 * not a host armed it — the form parses + analyses the same; only execution
 * differs. Crucially it can never silently no-op: an inert environment that
 * pretended a `(sql/query …)` returned `nil` would corrupt a run's results.
 *
 * Errors-as-doors: the message routes the caller to the subsystem that grants the
 * capability rather than merely banning the call.
 */
export const inertSqlResolver: SqlEffectResolver = (_ctx, effect) => {
  throw new Error(
    `${describeSqlEffect(effect)}: sql effects are not enabled in this environment. ` +
      `The (sql/query) verb requires a host-injected SqlEffectResolver — ` +
      `pass one via buildArrivalSession({ sql }). The OSS engine ships these verbs disarmed; ` +
      `a credentialed resolver (label→connection, decrypt, read-only role) is supplied by the SaaS host.`,
  );
};

/** "No value" as it crosses the rosetta membrane: a missing field is JS
 *  `undefined`/`null`. (An empty scheme list is NOT "no value" on this path:
 *  `schemeToJs` lowers `(list)`/`'()` to a JS `[]`, so an empty-list param element
 *  arrives as an ARRAY and rejects as non-scalar rather than folding to SQL NULL.
 *  The `ANil` arm is defence for direct-JS callers holding raw scheme values.)
 *  (Duplicated in the http pack by design: each capability pack is self-contained,
 *  depending only on arrival core — a three-line helper is not worth a shared
 *  micro-package edge.) */
function isAbsentValue(v: unknown): boolean {
  return v === null || v === undefined || v instanceof ANil;
}

/** Type name for teaching errors — distinguishes null/array from object so a
 *  rejected param says "array"/"null", not a bare "object". */
function dataTypeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Coerce the `(sql/query "…" "select … $1" (list a b))` params arg into the
 * positional bind list the resolver hands to the driver. The SEPARATION of these
 * values from the query text is the load-bearing safety property (`$n` binds to
 * `params[n-1]`; a caller value never touches the SQL string) — it lives HERE so
 * the resolver only ever sees a clean positional scalar list, and the effect-log
 * keys on `params` verbatim (a junk element ⇒ a wrong content key).
 *
 * Three arg shapes arrive across the membrane (verified against the rosetta
 * boundary — `schemeToJs(v, {})` lowers every scheme list to a JS array):
 *   - a scheme list `(list a b)`  → a JS array  → bind each element;
 *   - the empty list `(list)` / `'()` → a JS `[]` → the `Array.isArray` arm ⇒ no binds;
 *   - omitted (no params arg)     → `undefined`  → no binds;
 *   - a bare scalar `42` (sugar for `(list 42)`) → wrapped as one element.
 *
 * The `ANil` arm is defence for a DIRECT-JS caller that hands the coercion a raw
 * scheme value without the `schemeToJs` pass (an empty list then arrives as a `Nil`
 * instance, and must still mean "no binds" rather than binding a spurious sentinel
 * to a placeholder-free query).
 *
 * Exported for the same reason as the http pack's `httpOptions` — the baked
 * `sql/query` verb (`sql-capability.ts`) reuses this exact coercion rather than
 * re-deriving it.
 */
export function sqlParams(raw: unknown): readonly unknown[] {
  if (raw === undefined || raw instanceof ANil) return []; // omitted, or the empty scheme list
  if (Array.isArray(raw)) return raw.map((el, i) => sqlParam(el, i));
  return [sqlParam(raw, 0)]; // bare scalar — `(sql/query … 42)` ≡ `(sql/query … (list 42))`
}

/**
 * Coerce ONE positional param element to a v1 SQL bind value — the scalar
 * discipline the {@link SqlEffect} contract states ("scalars only at v1"):
 *
 *   - a scheme nil element (`'()` used as a value) / JS null/undefined ⇒ `null`
 *     (SQL `NULL` is a legitimate bind — `where col = $1` with `$1 = null`);
 *   - string / number / boolean / bigint ⇒ passed verbatim (real PG scalar binds);
 *   - a composite (array / object) ⇒ REJECTED with a teaching error naming the
 *     offending position (errors-as-doors). A v1 bind value can't be a structure:
 *     the driver has no scalar to send and the effect-log can't canonicalise it
 *     into a stable key. Surfacing it at the verb (vs a later opaque driver crash)
 *     keeps the membrane's promise that the resolver sees only positional scalars.
 */
function sqlParam(value: unknown, index: number): unknown {
  if (isAbsentValue(value)) return null;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return value;
    default:
      throw new TypeError(
        `sql/query: param $${index + 1} must be a scalar (string/number/boolean/null), got ${dataTypeName(value)}. ` +
          `Positional binds are single values — a list/dict can't be one. ` +
          `Bind each scalar separately, or serialise the structure to text first.`,
      );
  }
}
