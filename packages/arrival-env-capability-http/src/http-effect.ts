/**
 * Host capability interface for HTTP EFFECTS — the membrane through which a run's
 * `(http/get …)` / `(http/post …)` calls reach the outside world.
 *
 * This is one protocol-family slice of the data-effect seam, the data-side twin of
 * {@link InferFn} (the `(infer …)` seam). The design principle is identical and
 * load-bearing:
 *
 *   The OSS engine knows the VERBS, never the CREDENTIALS.
 *
 * A program names a connection by **label** (intent) — `"weather-api"` — and the
 * resolver maps that label to a decrypted credential and a concrete endpoint
 * HOST-SIDE (the same membrane the LLM keys cross: the interface vends BEHAVIOUR,
 * not the secret). Code stays portable and secret-free; the label→binding lives in
 * the SaaS config plane.
 *
 * INERT BY DEFAULT. Like the inference plane (an unbound infer store throws at the
 * first `(infer …)`), the http verbs exist as forms but REJECT at call time until an
 * `HttpEffectResolver` is injected via `buildArrivalSession({ http })`. The OSS
 * distribution ships the verbs disarmed: with no resolver the engine can `(require)`
 * and analyse a program that mentions `(http/get …)`, but executing one throws a
 * teaching error (see {@link inertHttpResolver}) — it never silently no-ops, and it
 * never reaches a network.
 *
 * Single seam per family. There is exactly ONE host-contact point for the whole
 * family: a resolver receiving the canonical {@link HttpEffect}. The verbs
 * (`http/get`, `http/post`, …) are thin scheme-facing wrappers that canonicalise
 * their args into the descriptor and cross this one membrane. Every effect a run
 * performs is one uniformly-shaped, content-addressable record, so the effect-log /
 * replay machinery treats an http effect exactly as it treats infer (the kind-tagged
 * key algebra lives in `@inhuman.tools/arrival-effects`, which composes this
 * family's descriptor with its siblings into the `DataEffect` union).
 *
 * The credentialed resolver (label→connection lookup, envelope-decrypt, SSRF-safe
 * fetch) is host-private — it is NOT part of this OSS package. This module defines
 * only the contract those host-side implementations satisfy, plus the inert guard
 * that keeps the engine safe when no host is present.
 */

// Value-level `Nil`. The verb arg-coercion is inherently about the scheme
// membrane's representation: an empty scheme list (`(list)` / `'()`) crosses the
// rosetta boundary as a `Nil` instance, not a JS `[]`, so a coercion that builds a
// positional param list MUST recognise it (the same `instanceof Nil` discipline
// `project.ts`'s `isNilLike` uses). This couples only to the engine's own value
// type, which this pack already depends on package-wide.
import { ANil } from "@inhuman.tools/arrival";

/**
 * The HTTP request methods a `(http/*)` verb can carry. Read methods (`GET`,
 * `HEAD`) are the v1 idempotent surface — content-key cacheable + replay-clean.
 * `POST` is enumerated for the verb the registry reserves; non-idempotent methods
 * are valid in the type but flagged by the effect-log / replay lint (a
 * non-idempotent effect in a parallel arm is the lintable case), not forbidden at
 * the interface.
 */
export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * An HTTP data effect — the INTENT a `(http/get "label" "/path" …)` form carries.
 * Every field is plain-serializable so the effect-log can canonicalise the whole
 * descriptor into a stable content key (the cache / replay identity) without
 * reaching into scheme value types.
 *
 *   (http/get  "weather-api" "/forecast" (dict :query (dict :city "berlin")))
 *   (http/post "crm"         "/contacts" (dict :body  (dict :name "…")))
 *
 * `label` is the connection handle (intent); the resolver binds it to a base URL +
 * credential host-side. `path` is appended to that base — the program never sees
 * (and cannot forge) the absolute origin, so an allowlist enforced at the binding
 * holds regardless of program input.
 */
export interface HttpEffect {
  kind: "http";
  /** HTTP method. Defaults to `GET` at the verb layer; carried explicitly here. */
  method: HttpMethod;
  /** Connection label — the code handle the resolver maps to a base URL + creds. */
  label: string;
  /** Request path appended to the connection's base URL (the resolver owns the base). */
  path: string;
  /** Query parameters, merged into the URL by the resolver (host-side, after
   *  encoding). Plain record so it canonicalises cleanly; absent ⇒ no query. */
  query?: Readonly<Record<string, string | number | boolean>>;
  /** Caller-supplied request headers. The resolver MAY drop/override hop-by-hop or
   *  credential headers — auth is bound from the connection, never the program. */
  headers?: Readonly<Record<string, string>>;
  /** Request body for write methods (serialised host-side, typically JSON).
   *  Ignored for bodyless methods. */
  body?: unknown;
}

/**
 * Minimal structural view of the `EvalContext` a resolver receives — only the
 * current invocation it needs to mark a provenance point / bind node metadata.
 * Mirrors `InferFn`'s context arg; duck-typed to avoid pulling in the run engine's
 * full `Invocation`/trace types at the interface (the same one-way-cycle discipline
 * `rosetta.ts` uses for `InvocationLike`). Structurally identical to the sibling
 * families' context types (`SqlEffectContext`, arrival-effects' `DataEffectContext`)
 * so a combined host dispatcher composes the narrow seams without adapters.
 */
export interface HttpEffectContext {
  currentInvocation?: unknown;
}

/**
 * THE SEAM. A host injects ONE of these to arm the http verbs; absent it, the
 * verbs are inert (see {@link inertHttpResolver}). Receives the eval context
 * (for tracing/provenance) and the canonical {@link HttpEffect}, performs the
 * credentialed, egress-controlled materialisation host-side, and resolves to the
 * raw value the originating verb hands back to scheme (the verb membrane-wraps it
 * on the way out, exactly as the `infer` seam does).
 *
 * This is deliberately the same SHAPE as {@link InferFn}: `(ctx, descriptor) →
 * Promise<value>`. A host that already routes `(infer …)` through its own plane
 * routes http effects through the structurally-identical resolver — one membrane
 * idiom for every external effect a run performs.
 *
 * Contract obligations on the host implementation (NOT enforceable here — they
 * live on the host-private side and are stated so the membrane's guarantees
 * are explicit):
 *   - Resolve `label` → connection host-side; NEVER accept a raw URL/key from
 *     the program (intent over materialisation — the program names, the host binds).
 *   - Enforce egress safety at the network layer (SSRF allowlist) — the interface
 *     admits the shape; the host guarantees the safety.
 *   - SANITISE errors before they propagate: a thrown resolver error must not carry
 *     a credential / internal endpoint (it would otherwise land in the persisted Run
 *     and the logs). The engine surfaces whatever the resolver throws.
 */
export type HttpEffectResolver = (ctx: HttpEffectContext, effect: HttpEffect) => Promise<unknown>;

/**
 * Stable, human-readable name for an http effect — `"http GET weather-api/forecast"`.
 * Used in inert / error messages and as a legible label for the effect node. NOT the
 * content key (the effect-log derives that from the full canonical descriptor incl.
 * query/headers/body); this is the at-a-glance identity.
 */
export function describeHttpEffect(effect: HttpEffect): string {
  return `http ${effect.method} ${effect.label}${effect.path}`;
}

/**
 * The disarmed default. When `buildArrivalSession` is called WITHOUT an `http`
 * resolver, the http verbs route here and throw a teaching error at call time —
 * the data-side analogue of the inference plane's "no inference store bound"
 * invariant.
 *
 * Why throw-at-call rather than omit-the-verb: a missing symbol ("unbound
 * variable: http/get") is opaque and looks like a typo; this names the real
 * condition (the capability isn't wired in THIS environment) and points at the
 * fix (inject a resolver). It also keeps the verb SURFACE identical whether or
 * not a host armed it — the form parses + analyses the same; only execution
 * differs. Crucially it can never silently no-op: an inert environment that
 * pretended a `(http/get …)` returned `nil` would corrupt a run's results.
 *
 * Errors-as-doors: the message routes the caller to the subsystem that grants the
 * capability rather than merely banning the call.
 */
export const inertHttpResolver: HttpEffectResolver = (_ctx, effect) => {
  throw new Error(
    `${describeHttpEffect(effect)}: http effects are not enabled in this environment. ` +
      `The (http/get) and (http/post) verbs require a host-injected HttpEffectResolver — ` +
      `pass one via buildArrivalSession({ http }). The OSS engine ships these verbs disarmed; ` +
      `a credentialed resolver (label→connection, decrypt, egress-safe fetch) is supplied by the SaaS host.`,
  );
};

/** A URL query value is a scalar by construction — it has to become one literal
 *  segment in `?k=v`. Anything structured (a nested dict, a list) is meaningless
 *  as a query param AND would poison the effect-log content key (the log keys
 *  on `query` verbatim), so it is rejected at the verb, not silently flattened. */
function isQueryScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** "No value" as it crosses the rosetta membrane: a missing dict field is JS
 *  `undefined`/`null`, and an empty scheme list (`'()` / `(list)`) arrives as a
 *  `Nil` instance — NOT a JS `[]`. A nil-valued query/header entry means
 *  "omit", so the canonical descriptor stays minimal: `{city}` and
 *  `{city, since: nil}` must mint the SAME content key.
 *  (Duplicated in the sql pack by design: each capability pack is self-contained,
 *  depending only on arrival core — a three-line helper is not worth a shared
 *  micro-package edge.) */
function isAbsentValue(v: unknown): boolean {
  return v === null || v === undefined || v instanceof ANil;
}

/**
 * Coerce a `(dict :query (dict :city "…" :days 3))` options field into the
 * `HttpEffect.query` shape (scalar-valued record). Faithful, not blind-cast:
 *
 *   - drops absent / nil entries (keeps the canonical descriptor minimal so the
 *     content key is stable — `{city}` and `{city, days: nil}` must not differ);
 *   - keeps scalars verbatim (string/number/boolean — the resolver `String()`s
 *     them into the URL host-side; the number/bool identity is preserved in the
 *     descriptor so the cache key reflects what the program actually asked for);
 *   - REJECTS a non-scalar value (nested dict / list) with a teaching error that
 *     names the offending key + the fix — errors-as-doors, never a lying cast.
 *
 *  `undefined` in ⇒ `undefined` out (no `query` key on the effect at all).
 */
function coerceHttpQuery(raw: unknown): HttpEffect["query"] {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(
      `http/get: :query must be a dict of scalar values (got ${dataTypeName(raw)}); ` +
        `e.g. (http/get "label" "/path" (dict :query (dict :city "berlin")))`,
    );
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isAbsentValue(v)) continue; // absent param (incl. empty-list nil) — omit, don't encode "nil"
    if (!isQueryScalar(v)) {
      throw new TypeError(
        `http/get: query param "${k}" must be a scalar (string/number/boolean), got ${dataTypeName(v)}. ` +
          `URL query values are single segments — a nested dict/list can't be one. ` +
          `Pass it in the path or as separate scalar params.`,
      );
    }
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Coerce a `(dict :headers (dict :accept "application/json"))` options field into
 * the `HttpEffect.headers` shape (string-valued record). HTTP header values ARE
 * strings by spec, so a scalar is faithfully `String()`'d (a numeric `:retries 3`
 * → `"3"`); a structured value is a category error and is rejected. Auth/credential
 * headers the program supplies are still subject to the resolver's drop/override
 * (the membrane binds auth from the connection, never the program) — this only
 * shapes what the descriptor carries. `undefined` in ⇒ `undefined` out.
 */
function coerceHttpHeaders(raw: unknown): HttpEffect["headers"] {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(
      `http/get: :headers must be a dict of scalar values (got ${dataTypeName(raw)}); ` +
        `e.g. (http/get "label" "/path" (dict :headers (dict :accept "application/json")))`,
    );
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isAbsentValue(v)) continue; // absent header (incl. empty-list nil) — omit
    if (!isQueryScalar(v)) {
      throw new TypeError(
        `http/get: header "${k}" must be a scalar (string/number/boolean), got ${dataTypeName(v)}. ` +
          `HTTP header values are strings.`,
      );
    }
    out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Shape a `(dict :body …)` options field into `HttpEffect.body` for a WRITE verb
 * (`http/post`). The body is the defining axis of a write — unlike query/headers
 * it is NOT coerced to scalars: a `(http/post "crm" "/contacts" (dict :body (dict
 * :name "ada" :tags (list …))))` carries arbitrary structured intent, and the
 * structure IS the payload. The resolver serialises it host-side (typically
 * JSON); the engine passes it through verbatim — flattening it would destroy the
 * very thing POST exists to send.
 *
 * The ONE shaping the body needs is the membrane's nil discipline (the same fact
 * `coerceHttpQuery` encodes): an absent `:body`, an explicit `:body
 * nil`, and the empty scheme list all mean "no request body" → drop the slot. Two
 * reasons this matters and isn't a blind pass-through:
 *   - CONTENT KEY STABILITY — a bodyless POST and `(dict :body nil)` must mint the
 *     SAME effect key; if `nil` leaked through, the key would canonicalise the
 *     scheme `Nil` sentinel (`{provenance,kind:"nil"}`) and the two would diverge.
 *   - CLEAN MATERIALISATION — the resolver receives `undefined` (no body to send),
 *     never a scheme-internal `Nil` object it would try to JSON-serialise.
 *
 * Any real value (dict / list / scalar) passes through unchanged. `undefined` in
 * (no `:body` field) ⇒ `undefined` out (no `body` key on the effect at all).
 */
function coerceHttpBody(raw: unknown): HttpEffect["body"] {
  return isAbsentValue(raw) ? undefined : raw; // nil/absent ⇒ no body; structure ⇒ verbatim
}

/** Shape an HTTP options dict (`(dict :query … :headers … :body …)`) — already
 *  schemeToJs'd to a plain record by the rosetta wrapper — into the `HttpEffect`
 *  request fields, per method. `query`/`headers` coercion is shared (both verbs
 *  want faithfully-scalar values); the body is the per-method axis: a read verb
 *  (GET/HEAD) carries NO body — a request body on a read is spec-discouraged,
 *  ignored by servers, and would taint the idempotent content key — so it is
 *  dropped here even if the program passed one. Write verbs keep `:body`, shaped
 *  by `coerceHttpBody` (nil-aware, structure-preserving).
 *  Tolerates absence / a non-record opts arg (⇒ no options). Exported so the baked
 *  `symbol.rosetta` verb declarations (`http-capability.ts`, the real production verb
 *  registration) reuse this exact coercion rather than re-deriving it — one shaping
 *  implementation, one registration site. */
export function httpOptions(method: HttpMethod, raw: unknown): Pick<HttpEffect, "query" | "headers" | "body"> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: Pick<HttpEffect, "query" | "headers" | "body"> = {};
  const query = coerceHttpQuery(r.query);
  if (query !== undefined) out.query = query;
  const headers = coerceHttpHeaders(r.headers);
  if (headers !== undefined) out.headers = headers;
  // Read methods carry no request body (keeps GET/HEAD effects idempotent +
  // content-key-stable). Write methods keep the body, nil-shaped by coerceHttpBody.
  if (!isBodylessMethod(method)) {
    const body = coerceHttpBody(r.body);
    if (body !== undefined) out.body = body;
  }
  return out;
}

/** Read methods take no request body — the idempotent, content-key-cacheable
 *  surface. (HEAD reserved alongside GET for symmetry.) */
function isBodylessMethod(method: HttpMethod): boolean {
  return method === "GET" || method === "HEAD";
}

/** Type name for teaching errors — distinguishes null/array from object so a
 *  rejected `:query` says "array"/"null", not a bare "object". */
function dataTypeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
