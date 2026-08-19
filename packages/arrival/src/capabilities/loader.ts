// `@inhuman.tools/arrival/capabilities/loader` — the `(require …)` module system:
// the EnvCapability arm + the ext-author / host Loader surface.
// Not in BASE_ROSTER — arm when the host wants require; absence withholds the verb.
//
// Allowlist:
//   • ARM — `arrivalLoaderCapability`, `Loader`, `makeFsLoader`/`FsReadLike`,
//     `loaderFromResolver`/`RequireResolver`
//   • EXT-AUTHOR — `ExtensionHandler`/`ContentResolver`/`RequireTypeProvider`/
//     `ResolverResult`, `contentsToText`/`normalizeToJson`/`parseJsonc`/`valueToTsType`/
//     `resolveRequireType`, `SchemeForm`/`MaybePromise` (home: `src/types/utility.ts`), `runResolverOf`
export type { MaybePromise } from "../types/utility.js";
export { parseJsonc } from "../loader/parse-jsonc.js";
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
  valueToTsType,
  resolveRequireType,
  type SchemeForm,
  runResolverOf,
} from "../loader/loader.js";
export { arrivalLoaderCapability } from "../loader/loader-capability.js";
