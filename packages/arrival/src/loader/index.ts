/**
 * Internal loader barrel (relative imports inside this package). Public consumers use
 * `@inhuman.tools/arrival/capabilities/loader` (or the `./capabilities` barrel).
 *
 * Two-story allowlist:
 *   • ARM — `arrivalLoaderCapability`, `Loader`, `makeFsLoader`/`FsReadLike`,
 *     `loaderFromResolver`/`RequireResolver`
 *   • EXT-AUTHOR — `ExtensionHandler`/`ContentResolver`/`RequireTypeProvider`/
 *     `ResolverResult`, `contentsToText`/`normalizeToJson`/`parseJsonc`/`valueToTsType`/
 *     `resolveRequireType`, `SchemeForm`/`MaybePromise` (riders those signatures need).
 *
 * `arrivalLoaderCapability` is the declarative face — the one EnvCapability an assembling
 * consumer roots; sibling modules carry the machinery. A loader-derivable env (fs or a
 * pre-built loader) arms the `(require)` verb; its absence withholds it entirely — see
 * loader-capability.ts.
 *
 * A "custom loader" teaches `(require …)` a new file type. Three registration surfaces,
 * ordered by reach:
 *   1. A capability prelude calling `(require/register-extension ".x" x/resolve)` — THE
 *      designed surface, a by-name resolver GRANT (never user data). See
 *      loader-extensions.ts (module-internal; a prelude never imports TS).
 *   2. `configuration.extensionRegistry` — host-armed pack map; the program opts a whole
 *      extension PACK in mid-run via `(require/extension :name)`. See loader-capability.ts.
 *   3. `configuration.loader` — a pre-built `Loader` (wins over fs) carrying custom
 *      `ExtensionHandler`s; the one seam that also teaches the EDITOR a `(require)` type.
 *      See loader.ts (`ExtensionHandler`, `RequireTypeProvider`).
 *
 * Module-internal (not this subpath; relative import only): `runResolverOf`, `runEnvOf`,
 * `dataToScheme`, `dirOf`, `defaultResolvers`, `pickHandler`, and the whole
 * `loader-extensions.ts` registry.
 *
 * Design doc retired (superseded by require-and-load-typed-loaders; see arrival/packages/arrival/docs/design-history/).
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
  contentsToText,
  normalizeToJson,
  parseJsonc,
  valueToTsType,
  resolveRequireType,
  type SchemeForm,
  type MaybePromise } from "./loader.js";
export { arrivalLoaderCapability } from "./loader-capability.js";
