// loader-extensions — the file-type resolver registry behind `(require/register-extension)`.
//
// A file-type "extension" is not a verb-pack to assemble — it is a resolver, and the only
// thing it needs is a function `(contents, filepath) → value`. So registering one is just
// mutating a table, keyed by file-suffix → the NAME of the resolver verb that handles it.
//
// Two deliberate design choices:
//
//   • BY-NAME, late-bound per env. The table stores the resolver verb's NAME, not its value.
//     `require`, on hitting a `.X` file, looks the name up in the CURRENT env and calls it.
//     So a resource-armed resolver (`.prompt` → `prompt/compile`, which closes over the
//     infer resource) picks up the *calling* env's resource — no captured closure — and an env
//     that never rooted the owning capability simply has no binding for the name, so requiring
//     that extension errors. Global vocabulary, per-scope capability.
//
//   • PRELUDE-ONLY registration.
//     `require/register-extension` is a `preludeOnly: true` MACRO (loader-capability.ts):
//     MACRO so the resolver name is UNEVALUATED — write
//       (require/register-extension ".prompt" ext/prompt/resolve)
//     not a quoted string forced by "if I write the bare symbol it evaluates to the
//     function, and String(fn) becomes the registry key". It is NEVER bound into the runtime
//     env. A running program therefore CANNOT teach the loader a new file type mid-run.
//
// STAGE C CUT 3b (docs/plans/stage-c-corpse-deletion.md) — ONE registry, ONE set of
// primitives: every run (the self-hosted vocabulary path, the exec default and now the ONLY
// path) registers into THIS RUN'S OWN `LoaderRunResources.extensionResolvers` bag
// (loader-capability.ts) — a fresh, empty `Map` per RunContext, populated only from a prelude
// (§PRELUDE), never leaking across runs. The retired LEGACY AMBIENT path's process-global
// `RESOLVERS` table (and its convenience wrappers `registerExtension`/`lookupExtensionResolver`/
// `legacyExtensionRegistry`) died with the ambient path itself — `loaderRegistryOf`
// (loader-capability.ts) no longer has a fallback arm to route to.
//   `makeRegisterExtensionMacro`'s caller (loader-capability.ts) resolves `ctx.runCtx`'s OWN
//   per-run bag — `registerExtensionIn`/`lookupExtensionResolverIn` are the shared primitives
//   both the registration macro and `require`'s lookup run through, so the conflict door
//   (`ExtensionSuffixConflictError`) and the longest-suffix match are unaffected by this cut.

import { ExtensionSuffixConflictError } from "../errors.js";
import { Macro } from "../eval/Macro.js";
import { ANil } from "../values/primitives/ANil.js";
import { nil } from "../values/primitives/ANil.js";
import { APair } from "../values/primitives/APair.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import type { SchemeValue } from "../values/types.js";
import type { RunContext } from "../run/RunContext.js";
import invariant from "tiny-invariant";

/** ext-suffix (e.g. `".prompt"`) → the NAME of the resolver verb that handles it. The per-run
 *  (vocabulary-path) bag's shape (`LoaderRunResources.extensionResolvers`, loader-capability.ts). */
export type ExtensionResolverRegistry = Map<string, string>;

/** Coerce a name argument (string, AString, ASymbol, or (quote SYMBOL)) to the bound verb name. */
function resolverNameOf(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof AString) return String(raw.valueOf());
  if (raw instanceof ASymbol) return raw.literal();
  // (quote name) — designed surface still accepts a quoted symbol.
  if (raw instanceof APair) {
    const head = raw.car;
    if (head instanceof ASymbol && head.literal() === "quote" && raw.cdr instanceof APair) {
      const body = raw.cdr.car;
      if (body instanceof ASymbol) return body.literal();
      if (body instanceof AString) return String(body.valueOf());
    }
  }
  return String(raw);
}

/** Suffix form → leading-dot string (string literal or symbol `.prompt` / `prompt`). */
function suffixOf(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof AString) return String(raw.valueOf());
  if (raw instanceof ASymbol) return raw.literal();
  return String(raw);
}

/** Normalize a suffix to a leading-dot form (`"hbs"` and `".hbs"` both → `".hbs"`). */
function normalizeSuffix(ext: string): string {
  return ext.startsWith(".") ? ext : `.${ext}`;
}

/** Register a file-suffix → resolver-verb-name mapping INTO `registry` (either THIS run's
 *  `LoaderRunResources.extensionResolvers` bag or the legacy process-global table — the
 *  caller's choice, see this module's header). Idempotent for an identical mapping; a
 *  conflicting name for an already-registered suffix is a legible throw (never silent
 *  last-write-wins — two capabilities claiming `.hbs` differently is a real configuration
 *  bug) — the SAME door regardless of which registry this is, and the mechanism the
 *  diamond-DAG / re-registration law suites pin against. */
export function registerExtensionIn(registry: ExtensionResolverRegistry, ext: unknown, resolverName: unknown): void {
  const suffix = normalizeSuffix(suffixOf(ext));
  const name = resolverNameOf(resolverName);
  const existing = registry.get(suffix);
  ExtensionSuffixConflictError.invariant(existing === undefined || existing === name, suffix, existing ?? name, name);
  registry.set(suffix, name);
}

/** The resolver verb name for a path, by LONGEST matching suffix (so `.spec.json` can beat
 *  `.json`), read out of `registry`. Returns `undefined` when no registered extension matches —
 *  the caller decides whether that's an error or a fall-through to a builtin (`.scm`). */
export function lookupExtensionResolverIn(registry: ExtensionResolverRegistry, path: string): string | undefined {
  let best: string | undefined;
  let bestLen = -1;
  for (const [suffix, name] of registry) {
    if (path.endsWith(suffix) && suffix.length > bestLen) {
      best = name;
      bestLen = suffix.length;
    }
  }
  return best;
}

/**
 * The MACRO body of `require/register-extension` — shared by bootstrap (capability symbols)
 * and mid-run (`require/extension`'s discarded prelude child). Args are UNEVALUATED forms:
 *   (require/register-extension ".prompt" ext/prompt/resolve)
 *   (require/register-extension ".prompt" "ext/prompt/resolve")  ; string still ok
 *   (require/register-extension ".prompt" 'ext/prompt/resolve)   ; quote still ok
 * Side-effects the registry `resolveRegistry(ctx.runCtx)` names; expands to nil (effect form).
 * `resolveRegistry` is the caller's (loader-capability.ts's) decision of WHICH registry this
 * particular invocation's `runCtx` implies — see this module's header for the full model.
 * `ctx.runCtx` rides `MacroInvokeContext` (the evaluator threads it at every macro-expand site,
 * `evaluator.ts`'s `evalArgs.runCtx`), so this macro reaches it WITHOUT ever going through
 * `makeCallCtx` (macros are `TF_EXPAND`-dispatched, never `this.resources`-bearing).
 */
export function makeRegisterExtensionMacro(resolveRegistry: (runCtx: RunContext) => ExtensionResolverRegistry): Macro {
  return new Macro(
    "require/register-extension",
    function (rest: SchemeValue, ctx: { runCtx: RunContext }) {
      invariant(rest instanceof APair, "require/register-extension: expected (suffix resolver-name)");
      const suffixForm = rest.car;
      invariant(rest.cdr instanceof APair, "require/register-extension: missing resolver-name");
      const nameForm = rest.cdr.car;
      invariant(rest.cdr.cdr instanceof ANil || rest.cdr.cdr == null, "require/register-extension: expected exactly 2 args");
      registerExtensionIn(resolveRegistry(ctx.runCtx), suffixForm, nameForm);
      return nil;
    },
    "registers a file extension resolver used by require (assembly time only; unevaluated resolver name; per-run)",
  );
}
