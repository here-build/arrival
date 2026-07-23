/**
 * `@inhuman.tools/arrival/loader` — the arrival-scheme `(require …)` module system,
 * a subpath quasi-package of the core (per .claude/rules/env-quasi-packages.md: no
 * external runtime deps, co-versioned with the interpreter — so it lives IN, as
 * `./loader`, not a separate package).
 *
 * EXPLICIT two-story allowlist (export restructure, docs/plans/stage-c-corpse-deletion.md
 * §"Export restructure" — replaces the old "re-exported whole" `export *`):
 *   • the ARM — `arrivalLoaderCapability` (the declarative face — the one EnvCapability an
 *     assembling consumer roots), `Loader`, `makeFsLoader`/`FsReadLike` (the fs-backed
 *     default), `loaderFromResolver`/`RequireResolver` (a bare-resolver-function loader).
 *   • the EXT-AUTHOR surface — `ExtensionHandler`/`ContentResolver`/`RequireTypeProvider`/
 *     `ResolverResult` (a custom file-type resolver's own shape), `normalizeToJson`/
 *     `valueToTsType`/`resolveRequireType` (the shared projections every data-format
 *     extension reuses so `.toml`/`.yaml`/… agree with `.json`), `SchemeForm`/`MaybePromise`
 *     (riders those signatures need).
 *
 * `arrivalLoaderCapability` is the declarative face — the one EnvCapability an assembling
 * consumer roots; the sibling modules carry the machinery. fs IS the intent to support
 * `(require)`: a loader-derivable env (fs or a pre-built loader) arms the verb, its absence
 * withholds it entirely — see loader-capability.ts.
 *
 * A "custom loader" teaches `(require …)` a new file type. Three registration surfaces,
 * ordered by reach; each documented where it lives:
 *   1. A capability prelude calling `(require/register-extension ".x" x/resolve)` — THE
 *      designed surface, a by-name resolver GRANT (never user data). See loader-extensions.ts
 *      (module-internal; not part of this subpath's surface — a prelude never imports TS).
 *   2. `configuration.extensionRegistry` — a host-armed pack map letting the program opt a
 *      whole extension PACK in mid-run via `(require/extension :name)`. See loader-capability.ts.
 *   3. `configuration.loader` — a pre-built `Loader` (wins over fs) carrying custom
 *      `ExtensionHandler`s directly; the one seam that also teaches the EDITOR a `(require)`
 *      type. See loader.ts (`ExtensionHandler`, `RequireTypeProvider`).
 *
 * OFF this subpath (module-internal, `env/vocabulary.ts`/`loader-capability.ts`'s own
 * machinery, reached by relative import): `runResolverOf` (REWORK-PENDING — llm-plane-
 * arrival-env's prompt.ts still reaches it via the old wide barrel; noted, not fixed, in the
 * Stage-C export-restructure report), `runEnvOf`, `dataToScheme`, `dirOf`, `defaultResolvers`,
 * `pickHandler`, and the whole `loader-extensions.ts` registry (`ExtensionResolverRegistry`,
 * `registerExtensionIn`, `lookupExtensionResolverIn`, `makeRegisterExtensionMacro`).
 *
 * Design doc: docs/package-specific/arrival-chain/require-import-loader.md.
 */
export {
  type Loader,
  type FsReadLike,
  makeFsLoader,
  type RequireResolver,
  loaderFromResolver,
  type ExtensionHandler,
  type ContentResolver,
  type RequireTypeProvider,
  type ResolverResult,
  normalizeToJson,
  valueToTsType,
  resolveRequireType,
  type SchemeForm,
  type MaybePromise,
} from "./loader.js";
export { arrivalLoaderCapability } from "./loader-capability.js";
