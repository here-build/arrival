/**
 * Module RESOLUTION primitives for `(require …)`: the `Loader` interface (resolve + read +
 * the per-suffix `ExtensionHandler` table), the path jail, the builtin data-format parsers,
 * and the data-value ↔ scheme ↔ editor-TS-type projections every resolver shares.
 *
 * The `require` VERB ITSELF — the single-flight cache, cycle detection, and statement-
 * position eval loop that actually walks these primitives at call time — is declared directly
 * by `arrivalLoaderCapability` (loader-capability.ts) as a `symbol.native`, not built here: its
 * state is scoped to one capability `.lower()` (one live env), which is exactly what that
 * declarative builder already provides, so there is no separate factory to call through.
 * `runResolverOf`/`runEnvOf` below are the shared back-channel readers require's
 * declaration (and `require/extension`'s) both need — genuine cross-verb plumbing, kept here.
 *
 * See docs/package-specific/arrival-chain/require-import-loader.md.
 */
import { currentRunResolver } from "../eval/evaluator.js";
import { execExpr, parse } from "../eval/generator-exec.js";
import type { Resolver } from "../eval/Resolver.js";
import { jsToScheme } from "../membrane/rosetta.js";
import { APair } from "../values/primitives/APair.js";
import { CONSTANT_CTX } from "../run/RunContext.js";
import { nil } from "../values/primitives/ANil.js";
import type { SchemeEnv } from "../common/scheme-env.js";
import { RunResolverUnreachableError, RequirePathError } from "../errors.js";

export type MaybePromise<T> = T | Promise<T>;

/** The run env the verbs evaluate module forms into — typed `SchemeEnv`, never the
 *  package-internal `AmbientRuntime` class. Every real caller's env is a base-linked live one
 *  (the prelude-scope mint in loader-capability.ts's `require/extension`). */
export type RunEnv = SchemeEnv;

/** A scheme value, derived from the public `execExpr` (the concrete union is not on
 *  arrival's public surface, but the alias is exported so `dataToScheme` / `require`'s
 *  declaration (loader-capability.ts) can name it — a derived name, not a new type). */
export type SchemeVal = Awaited<ReturnType<typeof execExpr>>;

/** The run's COMPOSED resolver — scope + capability base — with a teaching error when absent.
 *  require IS a membrane penetration (each source read crosses the VFS boundary), so like the
 *  rosetta membrane it reads the evaluator's run-scoped back-channel: `currentRunResolver()`,
 *  published at every apply boundary (`ctxResolver(ctx)`, this call's own frame). That is how
 *  the verb reaches its resolution context as an ANativeProcedure, whose apply term threads
 *  ONLY `runCtx` (run-constant data — a resolver cannot ride it; see evaluator.ts's holder doc).
 *
 *  WHY the resolver and not just its env: under `exec({ capabilities })` the run resolves
 *  through `Resolver(lexicalRoot, capabilityBase)` — the lexical frame is null-rooted and the
 *  stdlib lives on the capability base. A required module's forms evaluated against the ENV
 *  alone (reconstructing a resolver from a bare frame) would lose that base, so module code
 *  couldn't see `string-append`. Evaluating through THIS resolver (`execExpr({ resolver })`,
 *  loader-capability.ts) keeps a required module's resolution identical to the requiring
 *  program's: defines still spill into the same lexical frame (`resolver.env` — `define` binds
 *  there), and builtins resolve exactly as they do for the requiring program.
 *
 *  `ctx` is accepted (and ignored) for the verb declarations' `this: CallCtx` convention: the
 *  flat `CallCtx` (`{ runCtx, invocation }`) carries no resolver, so the back-channel is the
 *  one real source. */
export function runResolverOf(ctx: unknown, verb: string): Resolver {
  void ctx;
  const resolver = currentRunResolver();
  RunResolverUnreachableError.invariant(resolver !== undefined, verb);
  return resolver;
}

/** The run env these verbs spill module `define`s into — the composed resolver's lexical
 *  frame. The env-shaped face of {@link runResolverOf} for callers that need only the frame
 *  (`require/extension`'s assembler binding, the prelude-scope mint). The through-`unknown`
 *  widen is safe: the frame is a concrete `AmbientRuntime` satisfying `SchemeEnv`, and every
 *  use here is on the shared surface. */
export function runEnvOf(ctx: unknown, verb: string): RunEnv {
  return runResolverOf(ctx, verb).env as unknown as RunEnv;
}

/** A parsed scheme form — exactly what `parse` yields and `execExpr` consumes.
 *  Derived from `parse` to avoid depending on the (unexported) `SchemeValue`. */
export type SchemeForm = Awaited<ReturnType<typeof parse>>[number];

/** What an extension resolver produces; the require rosetta executes it.
 *  - `load`  → `execExpr` each form into the run env (spill); require returns ⊥.
 *  - `eval`  → `execExpr` the forms, return the LAST value (e.g. an `.hbs` lambda).
 *  - `value` → return the (plain, membrane-safe) value; the caller binds it
 *    explicitly with `(define x (require …))`. No spill into the global env — a
 *    data file's binding is as greppable and provenance-clear as an import.
 *
 *  ── THE CALLABLE RULE (non-obvious, load-bearing) ─────────────────────────────
 *  A `value` MUST be DATA, never a JS function. `require`'s value channel crosses
 *  through `jsToScheme`, and the membrane VOIDS an inbound JS function to `#void`
 *  (BY DESIGN — a borrowed/returned JS callback is an untrackable interaction that
 *  provenance can't follow; see arrival's membrane materialization). So a resolver
 *  that returns `{ kind: "value", value: <jsFn> }` yields a `#void` binding and
 *  `(the-fn …)` throws "Not callable".
 *
 *  To expose a CALLABLE from a `require`d file, the resolver returns `kind: "eval"`
 *  whose forms evaluate to a SCHEME LAMBDA that composes directly-bound native verbs
 *  — the lambda is a real (trackable) scheme value, and the verbs live in the env
 *  (never crossing the membrane). The `.hbs` shape is the reference:
 *      `(lambda args (template/handlebars <src> args))`
 *  i.e. parse to scheme DATA, then return a scheme lambda over it (the verb doing the
 *  work — `template/handlebars` — is directly bound). `value` is for data files
 *  (`.json`/`.yaml`/…); callables are ALWAYS `eval` + scheme lambdas. */
export type ResolverResult =
  | { kind: "load"; forms: SchemeForm[] }
  | { kind: "eval"; forms: SchemeForm[] }
  | { kind: "value"; value: unknown };

export type ContentResolver = (contents: string | Uint8Array, ctx: { path: string }) => MaybePromise<ResolverResult>;

/** The EDITOR twin of a {@link ContentResolver}: given a `(require)`d file's raw
 *  source, synthesize the TS type the lens should give `(require "path")` —
 *  expressed in the lens vocabulary (`SStr`/`SNum`/`SBool`/`List<…>`/object
 *  literals), the same dialect rosetta `type:` strings already speak. Returns
 *  `null` when the handler has no static shape to offer (the lens falls back to
 *  `unknown`). PURE — it parses the source the same way `resolve` does, but
 *  never touches the runtime env. Co-located with `resolve` so a single
 *  registration teaches BOTH the runtime parse and the editor shape: register
 *  once → runtime + editor both updated, no drift. */
export type RequireTypeProvider = (source: string, ctx: { path: string }) => string | null;

/** An extension's handler: its runtime `resolve` and its optional editor `type`
 *  provider (the require analogue of a rosetta's `{ fn, type }`). */
export interface ExtensionHandler {
  resolve: ContentResolver;
  type?: RequireTypeProvider;
}

export interface Loader {
  /** Pure path math: specifier resolved against the importing module's dir →
   *  canonical root-relative key. Throws on escape above the root. */
  resolve(specifier: string, fromDir: string): MaybePromise<string>;
  /** The one IO call + the jail. Throws (located) if the key isn't in the root. */
  read(path: string): MaybePromise<string | Uint8Array>;
  /** extension → terminal handler (runtime resolve + editor type). Longest
   *  matching suffix wins. */
  resolvers: Map<string, ExtensionHandler>;
}

/** Single-function resolver (`path → source`). May be async — `Loader.read` awaits
 *  it — so a resolver can fetch a not-yet-loaded module on demand (e.g. over a fs). */
export type RequireResolver = (path: string) => MaybePromise<string>;

// ── path helpers (posix, no node:path dep — runs in browser + worker + node) ──

/** Normalize a posix path, dropping `.`/empty segments and applying `..`. Throws
 *  if `..` would escape above the root — the traversal jail. */
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    RequirePathError.invariant(seg !== "\0" && !seg.includes("\0"), "nul-byte", p);
    if (seg === "..") {
      RequirePathError.invariant(out.length > 0, "escapes-root", p);
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join("/");
}

/** Resolve `specifier` against `fromDir`. A leading `/` is root-relative. */
function joinPath(fromDir: string, specifier: string): string {
  if (specifier.startsWith("/")) return normalizePath(specifier);
  return normalizePath(fromDir ? `${fromDir}/${specifier}` : specifier);
}

/** Exported for `require`'s own declaration (loader-capability.ts), which pushes it onto
 *  `dirStack` for relative-require resolution once a module's forms start evaluating. */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

// ── data parsers ──────────────────────────────────────────────────────────────
//
// Only the DEP-FREE formats parse here (`JSON.parse`). Dep-bearing formats — `.yaml`/`.yml`
// (`yaml`), `.toml` (`smol-toml`) — live in their own opt-in ext capabilities (arrival-chain
// `packs/ext-yaml.ts` / `ext-toml.ts`), each owning its parser, so the loader carries no external
// dep (per .claude/rules/env-quasi-packages.md — split to isolate an external dependency). Those
// capabilities register their resolver by NAME at bootstrap; `require`'s ext→name overlay resolves
// it. Known wart: that overlay is the RUNTIME face only — the editor type seam (`resolveRequireType`)
// reads this static table, so `.yaml`/`.toml` carry no lens type provider and hover as `unknown`
// (see `defaultResolvers`).
const DATA_PARSERS: Record<string, (text: string) => unknown> = {
  ".json": (text) => JSON.parse(text),
  ".ndjson": (text) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line)),
};

/** Project a parsed value onto its JSON shape (Dates → ISO strings, drops undefined) so a required
 *  data file enters the program as plain JSON-shaped data. NOT a deep clone — `structuredClone`
 *  would preserve the very non-JSON types this is meant to drop. Exported so the dep-bearing ext
 *  capabilities (`ext/yaml`, `ext/toml`) project their parsed value through the SAME projection the
 *  builtin data resolvers use — one definition, no drift. */
// eslint-disable-next-line unicorn/prefer-structured-clone -- JSON projection, not a clone
export const normalizeToJson = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

/** Shape a required DATA value into the program's world: arrays → scheme LISTS (Pair
 *  chains) at EVERY depth, plain objects rebuilt with shaped values (then wrapped as
 *  member-readable records by `jsToScheme`), scalars boxed by `jsToScheme`.
 *
 *  The loader's OWN data contract, done explicitly — NOT delegated to `jsToScheme`, whose
 *  rosetta boundary makes a borrowed JS array a VECTOR (so `(append (require "x.json") …)`
 *  would throw "Expecting nil or pair got js-array"). The loader is not a borrowed-host
 *  boundary — it is WHERE a data file is parsed INTO scheme, and required data is consumed
 *  with list idioms (`car`/`append`/destructuring folds), so arrays list-ify HERE, eagerly
 *  (a data file is finite and read once per run — the single-flight cache holds the shaped
 *  value). Exported for `require`'s declaration (loader-capability.ts), which shapes a
 *  `kind: "value"` result through this. */
export function dataToScheme(v: unknown): SchemeVal {
  if (Array.isArray(v)) {
    let tail: SchemeVal = nil;
    for (let i = v.length - 1; i >= 0; i--) tail = new APair(dataToScheme(v[i]), tail);
    return tail;
  }
  if (v !== null && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
    const shaped: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) shaped[k] = dataToScheme(val);
    return jsToScheme(CONSTANT_CTX, shaped);
  }
  return jsToScheme(CONSTANT_CTX, v);
}

// ── value → lens TS type ──────────────────────────────────────────────────────
//
// Synthesize the TS type string the lens gives `(require "data.json")`. Mirrors
// the runtime wrap (`jsToScheme`): a JS array becomes a scheme LIST (`List<T>`), a
// plain object an accessible record (`{ "k": T; … }`), scalars the branded base
// types. Pure + recursive with depth/breadth guards so a pathological blob
// degrades to `unknown` instead of emitting a megabyte of types. The output is
// the lens dialect (`SStr`/`SNum`/`SBool`/`List`), the same vocabulary rosetta
// `type:` strings are written in.

const TS_TYPE_MAX_DEPTH = 8;
const TS_TYPE_MAX_KEYS = 200;

/** Union the distinct element types of an array (order-preserving, deduped). */
function unionElementTypes(items: readonly unknown[], depth: number): string {
  const seen = new Set<string>();
  for (const item of items) {
    seen.add(valueToTsType(item, depth + 1));
    if (seen.size > 24) return "unknown"; // too many distinct shapes — give up cleanly
  }
  if (seen.size === 0) return "unknown"; // empty array — element type unknown
  return [...seen].join(" | ");
}

/** Project a parsed (JSON-shaped) value onto its lens TS type string. */
export function valueToTsType(value: unknown, depth = 0): string {
  if (depth > TS_TYPE_MAX_DEPTH) return "unknown";
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return "SStr";
    case "number":
      return "SNum";
    case "boolean":
      return "SBool";
    default:
      break;
  }
  if (Array.isArray(value)) {
    const elem = unionElementTypes(value, depth);
    return `List<${elem.includes(" | ") ? `(${elem})` : elem}>`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > TS_TYPE_MAX_KEYS) return "unknown";
    if (entries.length === 0) return "{}";
    const fields = entries.map(([k, v]) => `${JSON.stringify(k)}: ${valueToTsType(v, depth + 1)}`);
    return `{ ${fields.join("; ")} }`;
  }
  return "unknown";
}

/** The default extension registry: the `.scm` BUILTIN + the DEP-FREE data formats.
 *
 *  `.scm` is the one true builtin (the evaluator + recursive `require` — an intrinsic, never a
 *  registered extension). The dep-free data formats (`.json`/`.ndjson`/`.txt`) stay here for TWO
 *  reasons: (1) a bare loader (CLI `--file` mode, an env rooting no ext capability) still resolves
 *  them at runtime; (2) — load-bearing — they carry the LENS TYPE PROVIDER (`type`), which the
 *  editor seam (`resolveRequireType`) reads off THIS static table. Their runtime face is also
 *  re-registered by the `ext/json` / `ext/ndjson` / `ext/txt` capabilities; when one is rooted,
 *  `require`'s by-name overlay uses the capability verb and this entry is the fallback — identical
 *  value (same `normalizeToJson`), no divergence.
 *
 *  Dep-bearing formats are NOT builtins: `.yaml`/`.yml` (`ext/yaml`), `.toml` (`ext/toml`), `.hbs`
 *  (`ext/handlebars`), `.prompt` (`ext/prompt`) each own their dep. That sheds the loader's external
 *  deps — at the cost that `.yaml`/`.toml` hover as `unknown` in the lens (the by-name registry has
 *  no type channel; see the data-parsers note above). `.hbs`/`.prompt` never had a type provider. */
export function defaultResolvers(): Map<string, ExtensionHandler> {
  // Data files share ONE parser per extension across both faces: `resolve`
  // parses + normalizes to the runtime value, `type` parses + synthesizes the
  // editor shape. Same `DATA_PARSERS[ext]` on both sides — the registration is
  // the single source, so the lens shape can never drift from the runtime value.
  const dataHandlers = Object.keys(DATA_PARSERS).map((ext): [string, ExtensionHandler] => [
    ext,
    {
      resolve: (contents) => ({
        kind: "value",
        value: normalizeToJson(DATA_PARSERS[ext]!(String(contents))),
      }),
      type: (source) => {
        try {
          return valueToTsType(normalizeToJson(DATA_PARSERS[ext]!(source)));
        } catch {
          return null; // unparseable mid-edit — no shape, lens falls back to unknown
        }
      },
    },
  ]);
  return new Map<string, ExtensionHandler>([
    // Pass the module path as `source` so a throw inside this file reads as
    // `path:line` in the scheme stack (L3).
    [
      ".scm",
      { resolve: async (contents, { path }) => ({ kind: "load", forms: await parse(String(contents), path) }) },
    ],
    ...dataHandlers,
    [".txt", { resolve: (contents) => ({ kind: "value", value: String(contents) }), type: () => "SStr" }],
    // No entry for the dep-bearing formats (`.hbs`/`.yaml`/`.toml`/`.prompt`): a bare loader
    // rooting none of their capabilities has no fallback here, so requiring one is a clean
    // no-resolver error — which IS the scoping guarantee (you must root the owning capability).
  ]);
}

/** Longest registered suffix that the basename ends with (extensions begin with
 *  `.`, so the match is dot-bounded). Terminal — one handler, no chaining. Exported for
 *  `require`'s own declaration (loader-capability.ts), which falls through to this when
 *  the by-name registry overlay has no binding for the path's resolver. */
export function pickHandler(path: string, resolvers: Map<string, ExtensionHandler>): ExtensionHandler | undefined {
  const base = path.slice(path.lastIndexOf("/") + 1);
  let best: { ext: string; handler: ExtensionHandler } | undefined;
  for (const [ext, handler] of resolvers) {
    if (base.length > ext.length && base.endsWith(ext) && (!best || ext.length > best.ext.length)) {
      best = { ext, handler };
    }
  }
  return best?.handler;
}

/** The editor seam: synthesize the TS type for `(require "path")` by routing the
 *  file's source through the SAME registry the runtime resolves with — so a
 *  custom extension registered with a `type` provider teaches the lens too. The
 *  studio calls this per data file and pushes the resulting `{ path → tsType }`
 *  to the lens. Returns `null` when no handler claims the path or its handler has
 *  no `type` provider (a `.scm` library, an opaque blob) — the lens then emits
 *  no `require` overload and the value stays `unknown`. */
export function resolveRequireType(loader: Loader, path: string, source: string): string | null {
  const handler = pickHandler(path, loader.resolvers);
  if (handler?.type === undefined) return null;
  try {
    return handler.type(source, { path });
  } catch {
    return null; // a throwing provider must never break the editor — degrade to unknown
  }
}

/** Wrap a legacy `path → source` resolver (CLI `--file` mode) as a Loader. */
export function loaderFromResolver(resolver: RequireResolver): Loader {
  return {
    resolve: (specifier, fromDir) => joinPath(fromDir, specifier),
    read: (path) => resolver(path),
    resolvers: defaultResolvers(),
  };
}

/** The minimal read surface {@link makeFsLoader} needs. node:fs's `fs.promises`
 *  and plexus-vfs's `createFsClient(vfs).promises` both satisfy it as-is (both
 *  expose `readFile(path)`); a browser FileSystem-Access-API directory handle
 *  adapts with a tiny shim. `read` returns bytes OR text — the resolvers `String()`
 *  text files and the binary path stays `Uint8Array`. */
export interface FsReadLike {
  readFile(path: string): MaybePromise<string | Uint8Array>;
}

/**
 * Build a {@link Loader} over any read-capable filesystem — the generic-fs seam
 * that lets a program's `(require …)` resolve against node:fs, plexus-vfs, the
 * browser FileSystem Access API, or any `{ readFile }` shape, with no Plexus and
 * no `Project` in sight.
 *
 * Paths are root-relative POSIX keys (the same jail `resolve` enforces). A
 * root-relative fs (plexus-vfs, an in-project vfs) takes `.promises` directly;
 * a whole-disk fs roots the key itself, e.g. node:fs:
 *   `makeFsLoader({ readFile: (p) => fs.promises.readFile(nodePath.join(root, p)) })`.
 */
export function makeFsLoader(fs: FsReadLike): Loader {
  return {
    resolve: (specifier, fromDir) => joinPath(fromDir, specifier),
    read: (path) => fs.readFile(path),
    resolvers: defaultResolvers(),
  };
}

