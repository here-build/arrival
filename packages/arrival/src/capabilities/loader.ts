// `@inhuman.tools/arrival/capabilities/loader` — the `(require …)` module system:
// the EnvCapability arm + the ext-author / host Loader surface.
// Not in BASE_ROSTER — arm when the host wants require; absence withholds the verb.
//
// Allowlist:
//   • ARM — `arrivalLoaderCapability`, `Loader`, `makeFsLoader`/`FsReadLike`,
//     `loaderFromResolver`/`RequireResolver`
//   • EXT-AUTHOR — `ExtensionHandler`/`ContentResolver`/`RequireTypeProvider`/
//     `ResolverResult`, `normalizeToJson`/`parseJsonc`/`valueToTsType`/
//     `resolveRequireType`, `SchemeForm`/`MaybePromise`
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
  parseJsonc,
  valueToTsType,
  resolveRequireType,
  type SchemeForm,
  type MaybePromise,
} from "../loader/loader.js";
export { arrivalLoaderCapability } from "../loader/loader-capability.js";
