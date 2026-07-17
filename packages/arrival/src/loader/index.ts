/**
 * `@inhuman.tools/arrival/loader` — the arrival-scheme `(require …)` module system,
 * a subpath quasi-package of the core (per .claude/rules/env-quasi-packages.md:
 * no external runtime deps, co-versioned with the interpreter — so it lives IN,
 * as `./loader`, not as a separate package). Public surface = the three modules
 * below, re-exported whole. `arrivalLoaderCapability` (loader-capability.ts) is
 * the declarative face — the one EnvCapability an assembling consumer roots; the
 * sibling modules carry the machinery.
 *
 * If `fs` is provided, that IS the explicit intent to support `(require)` (V's
 * ruling): `exec(src, { capabilities: [arrivalLoaderCapability], config: { fs } })`
 * arms the verb; no fs (and no pre-built loader) withholds it entirely.
 *
 * ── Registering custom loaders ────────────────────────────────────────────────
 *
 * A "custom loader" teaches `(require …)` a new file type. There are three
 * production-grade registration surfaces, ordered by how far the new type reaches:
 *
 * 1. **A capability prelude calling `(require/register-extension ".x" 'x/resolve)`**
 *    — THE designed surface. The registry (loader-extensions.ts) maps a file
 *    suffix to the NAME of a resolver verb; the verb itself is a symbol the
 *    registering capability declares. `require`, on hitting a `.x` file, resolves
 *    that name against the CURRENT run's composed resolver (late-bound, per env) and
 *    calls it as `(resolver-verb contents {path})`; it must return a
 *    `ResolverResult` (loader.ts): `{ kind: "value" | "eval" | "load", … }` —
 *    data files return `value`, callable files return `eval` forms yielding a
 *    scheme lambda (THE CALLABLE RULE, loader.ts), scheme libraries return `load`.
 *    `require/register-extension` is `preludeOnly: true` — callable ONLY from a
 *    capability's prelude during assembly (and from a pack applied mid-run via
 *    `require/extension`), never from user code: a resolver is a capability
 *    GRANT, not user data. See `ext/yaml` / `ext/toml`
 *    (second-foundation/arrival-ext-*) for the reference shape: the capability
 *    OWNS its parser dep, declares the resolver verb, and its one-line prelude
 *    registers the suffix.
 *
 * 2. **`configuration.extensionRegistry`** — a host-armed
 *    `Map<name, EnvPack<RunEnv>>` enabling `(require/extension :name)`: the
 *    program itself opts a whole pre-registered extension PACK (verbs + prelude,
 *    which may itself call `require/register-extension`) into the live env
 *    mid-run. Absent registry ⇒ the verb is absent (capability withholding by
 *    absence).
 *
 * 3. **`configuration.loader`** — a pre-built `Loader` (wins over `fs`) whose
 *    `resolvers` table carries custom `ExtensionHandler`s directly
 *    (`{ resolve, type? }`). The one seam that also teaches the EDITOR: a
 *    handler's `type` provider (`RequireTypeProvider`) feeds the lens the TS type
 *    of `(require "x.ext")` — the by-name registry (1) has no type channel, so a
 *    handler that wants hover types registers here.
 */
export * from "./loader.js";
export * from "./loader-extensions.js";
export * from "./loader-capability.js";
