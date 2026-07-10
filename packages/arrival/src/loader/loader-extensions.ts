// loader-extensions — the file-type resolver registry behind `(require/register-extension)`.
//
// A file-type "extension" is not a verb-pack to assemble — it is a resolver, and the only
// thing it needs is a function `(contents, filepath) → value`. So registering one is just
// mutating a table, keyed by file-suffix → the NAME of the resolver verb that handles it.
//
// Two deliberate design choices (see docs/working-proposals/require-as-capability-and-
// prompt-support-2026-06-15.md §7):
//
//   • BY-NAME, late-bound per env. The table stores the resolver verb's NAME, not its value.
//     `require`, on hitting a `.X` file, looks the name up in the CURRENT env and calls it.
//     So a resource-armed resolver (`.prompt` → `prompt/compile`, which closes over the
//     infer resource) picks up the *calling* env's resource — no captured closure, no
//     cross-run leak in this process-global table — and an env that never rooted the owning
//     capability simply has no binding for the name, so requiring that extension errors.
//     Global vocabulary, per-scope capability.
//
//   • PRELUDE-ONLY registration (the interpreter nuance — read this before you're confused).
//     `require/register-extension` is a `preludeOnly: true` symbol declared by
//     `arrivalLoaderCapability` (loader-capability.ts): during BOOTSTRAP assembly it lives in
//     the kernel's phase-gated prelude scope (assembleEnv's per-assembly Map + resolver — see
//     kernel.ts), callable from every later-applied capability's prelude and gone once the C3
//     loop ends; during MID-RUN application (`require/extension`, §1.4) it is seeded onto the
//     per-call discarded child scope by `defineRegisterExtensionRosetta` below. It is NEVER
//     bound into the runtime env, so there is nothing to seal — the phase flag (bootstrap) /
//     the dropped child (mid-run) IS the seal. A running program therefore CANNOT teach the
//     loader a new file type mid-run: naming `require/register-extension` from user code is a
//     plain unbound-variable error, the ordinary consequence of the name genuinely not being in
//     scope. This is not an oversight or a missing feature — it is the wrong-state-impossible
//     guarantee: a `.prompt`/`.hbs` resolver is a CAPABILITY GRANT (it can run inference, read
//     templates), not user data, so only a capability's prelude may install one.
//     (See docs/package-specific/arrival-scheme/prelude-only-symbols-and-composable-prompt-2026-07-02.md §1.)

/** ext-suffix (e.g. `".prompt"`) → the NAME of the resolver verb that handles it. Process-
 *  global + idempotent: the same (suffix, name) re-registers as a no-op across runs (the
 *  same capabilities always register the same names); a DIFFERENT name for an already-claimed
 *  suffix is a conflict and throws. */
const RESOLVERS = new Map<string, string>();

/** Coerce a `(require/register-extension)` name argument (a quoted symbol `'handlebars/lambda`
 *  or a string) to the bound verb name. */
function resolverNameOf(raw: unknown): string {
  return typeof raw === "string" ? raw : String(raw);
}

/** Normalize a suffix to a leading-dot form (`"hbs"` and `".hbs"` both → `".hbs"`). */
function normalizeSuffix(ext: string): string {
  return ext.startsWith(".") ? ext : `.${ext}`;
}

/** Register a file-suffix → resolver-verb-name mapping. Idempotent for an identical mapping;
 *  a conflicting name for an already-registered suffix is a legible throw (never silent
 *  last-write-wins — two capabilities claiming `.hbs` differently is a real configuration
 *  bug). */
export function registerExtension(ext: unknown, resolverName: unknown): void {
  const suffix = normalizeSuffix(String(ext));
  const name = resolverNameOf(resolverName);
  const existing = RESOLVERS.get(suffix);
  if (existing !== undefined && existing !== name) {
    throw new Error(
      `require/register-extension: "${suffix}" is already handled by "${existing}", cannot reassign to "${name}". ` +
        `A file suffix maps to exactly one resolver; two capabilities are claiming it.`,
    );
  }
  RESOLVERS.set(suffix, name);
}

/** The resolver verb name for a path, by LONGEST matching suffix (so `.spec.json` can beat
 *  `.json`). Returns `undefined` when no registered extension matches — the caller decides
 *  whether that's an error or a fall-through to a builtin (`.scm`). */
export function lookupExtensionResolver(path: string): string | undefined {
  let best: string | undefined;
  let bestLen = -1;
  for (const [suffix, name] of RESOLVERS) {
    if (path.endsWith(suffix) && suffix.length > bestLen) {
      best = name;
      bestLen = suffix.length;
    }
  }
  return best;
}

/** Test-only: clear the process-global registry between cases. */
export function __resetExtensionRegistryForTest(): void {
  RESOLVERS.clear();
}
