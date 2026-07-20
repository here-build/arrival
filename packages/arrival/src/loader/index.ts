/**
 * `@inhuman.tools/arrival/loader` — the arrival-scheme `(require …)` module system,
 * a subpath quasi-package of the core (per .claude/rules/env-quasi-packages.md: no
 * external runtime deps, co-versioned with the interpreter — so it lives IN, as
 * `./loader`, not a separate package). Public surface = the three modules below,
 * re-exported whole.
 *
 * `arrivalLoaderCapability` (loader-capability.ts) is the declarative face — the one
 * EnvCapability an assembling consumer roots; the sibling modules carry the machinery.
 * fs IS the intent to support `(require)`: a loader-derivable env (fs or a pre-built
 * loader) arms the verb, its absence withholds it entirely — see loader-capability.ts.
 *
 * A "custom loader" teaches `(require …)` a new file type. Three registration surfaces,
 * ordered by reach; each documented where it lives:
 *   1. A capability prelude calling `(require/register-extension ".x" x/resolve)` — THE
 *      designed surface, a by-name resolver GRANT (never user data). See loader-extensions.ts.
 *   2. `configuration.extensionRegistry` — a host-armed pack map letting the program opt a
 *      whole extension PACK in mid-run via `(require/extension :name)`. See loader-capability.ts.
 *   3. `configuration.loader` — a pre-built `Loader` (wins over fs) carrying custom
 *      `ExtensionHandler`s directly; the one seam that also teaches the EDITOR a `(require)`
 *      type. See loader.ts (`ExtensionHandler`, `RequireTypeProvider`).
 *
 * Design doc: docs/package-specific/arrival-chain/require-import-loader.md.
 */
export * from "./loader.js";
export * from "./loader-extensions.js";
export * from "./loader-capability.js";
