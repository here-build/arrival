// kernel.ts — capability-DAG assembly for arrival environments. Env-agnostic core: closure +
// cycle detection, identity dedup, C3 linearization, and the apply loop with LIFO disposal +
// per-pack apply timeout.
//
// A pack is a named, dependency-carrying, async capability contribution to an env. Environments
// are assembled by C3-linearizing the pack DAG and applying each pack once. The dep edge IS the
// capability grant; the DAG is the authoring form, the assembled env is the flat runtime form.
//
// C3 linearization = Python MRO (Barrett, Cassels, Haahr et al., "A Monotonic Superclass
// Linearization for Dylan", OOPSLA 1996; cited not invented).
//
// Design: docs/working-proposals/env-pack-capability-dag-2026-06-13.md

/** A capability contribution to an env. Identity = (name, config). `deps` are the DAG edges. */
export interface EnvPack<E = unknown> {
  readonly name: string;
  readonly deps?: readonly EnvPack<E>[];
  /** Host-injected arming for THIS pack (inferPack.config = the InferFn, mcpPack.config = the
   *  resolver). Two same-name packs with non-equal config in one assembly = AssembleConfigConflictError. */
  readonly config?: unknown;
  /** Runs once, after all deps, in C3 order. May await import / defineRosetta / ctx.onDispose.
   *  MUST contribute symbols via the env's membrane-wrapping API, never a bare host closure (§8). */
  apply(env: E, ctx: PackContext<E>): void | Promise<void>;
}

/** The narrow surface a `preludeOnly` symbol's BINDING lands on. Deliberately just `.set`:
 *  capability.ts's bindTarget only ever writes. In BOOTSTRAP assembly this is the kernel's own
 *  Map-backed shim (see `assembleEnv`); in MID-RUN application (§1.4) it is a real, discarded
 *  child scope the caller constructs — a `SchemeEnv` satisfies this structurally. */
export interface PreludeBindTarget {
  set(name: string, value: unknown): unknown;
}

export interface PackContext<E = unknown> {
  /** Register a teardown thunk; run LIFO by AssembledEnv.dispose(). */
  onDispose(fn: () => void | Promise<void>): void;
  /** The C3 linearization this pack sits in (highest precedence first) — debug/audit. */
  readonly order: readonly string[];
  /** The scope a `preludeOnly` symbol routes its BINDING onto instead of the runtime env.
   *
   *  BOOTSTRAP (`assembleEnv`): ALWAYS present — the kernel's own bake-scoped overlay (see the
   *  block comment above `assembleEnv`). Resolvable only while the assembly's C3 loop (the bake)
   *  is open; DROPPED at seal — including for closures a prelude defined (a closure walks the
   *  live chain at call time, and the overlay is gone post-assembly). That IS the `preludeOnly`
   *  contract: assembly-time-only, not run-within-prelude-scope.
   *
   *  MID-RUN (`RuntimeAssembler.require`, §1.4): caller-supplied — a discarded child `C'` of
   *  the live env (arrival-scheme-env-loader's `arrivalLoaderCapability`, `require/extension`'s
   *  declaration). Undefined when that caller passes none. */
  readonly preludeScope?: PreludeBindTarget;
  /** The scope a capability's `prelude` TEXT is evaluated AGAINST — distinct from
   *  `preludeScope` (the bind target):
   *    - BOOTSTRAP: left undefined; capability.ts falls back to evaluating against `env` = R,
   *      so prelude `define`s land in R (fact 1 of the design doc §1.3) while `preludeOnly`
   *      lookups are answered by the kernel's phase-gated resolver on the base.
   *    - MID-RUN (§1.4): `preludeScope` = `preludeEvalScope` = a discarded CHILD `C'` of the
   *      live env. Re-parenting a LIVE env is unsafe (concurrent lookups), so the prelude is
   *      evaluated IN `C'` instead: lookups miss `C'` → hit `liveEnv` → base, and `C'` (with any
   *      prelude `define`s) is simply dropped when `require()` returns — the deliberate mid-run
   *      asymmetry (a mid-run pack's prelude cannot contribute runtime bindings). */
  readonly preludeEvalScope?: E;
}

export interface AssembledEnv<E = unknown> {
  readonly env: E;
  /** The C3 linearization, highest precedence (roots) first. */
  readonly order: readonly string[];
  dispose(): Promise<void>;
}

// Errors (teaching, errors-as-doors) live in errors.ts (the single error home); re-exported here
// so the /env subpath still surfaces the assembly errors to consumers (arrival-chain).
import {
  AssembleConfigConflictError,
  AssembleCycleError,
  AssembleLinearizationError,
  AssemblePackError,
  AssemblePackTimeoutError,
} from "../errors.js";
export {
  AssembleConfigConflictError,
  AssembleCycleError,
  AssembleLinearizationError,
  AssemblePackError,
  AssemblePackTimeoutError,
};

const packTimeoutMs = (): number => Number(process.env.ASSEMBLE_PACK_TIMEOUT_MS) || 30_000;

/** Structural-or-identity config equality: reference-equal (functions, resolvers) OR deep-equal
 *  for plain data. Functions are never structurally equal — only the same reference dedups. */
function configEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "function" || typeof b === "function") return false; // identity-only
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => configEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** DFS the dep DAG from roots: collect packs by name, detect cycles (3-color), check config dedup. */
function closure<E>(roots: readonly EnvPack<E>[]): Map<string, EnvPack<E>> {
  const byName = new Map<string, EnvPack<E>>();
  const GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (pack: EnvPack<E>): void => {
    const seen = byName.get(pack.name);
    if (seen !== undefined && !configEqual(seen.config, pack.config)) throw new AssembleConfigConflictError(pack.name);
    if (color.get(pack.name) === BLACK) return; // already fully visited
    if (color.get(pack.name) === GRAY) {
      const from = stack.indexOf(pack.name);
      throw new AssembleCycleError([...stack.slice(from), pack.name]);
    }
    color.set(pack.name, GRAY);
    stack.push(pack.name);
    byName.set(pack.name, pack);
    for (const dep of pack.deps ?? []) visit(dep);
    stack.pop();
    color.set(pack.name, BLACK);
  };

  for (const r of roots) visit(r);
  return byName;
}

/** C3 linearization (Python MRO) over the deduped pack graph. Returns names, highest precedence
 *  first. `merge` repeatedly takes a "good head" (a head appearing in no list's tail). */
function c3Linearize<E>(roots: readonly EnvPack<E>[], byName: Map<string, EnvPack<E>>): string[] {
  const memo = new Map<string, string[]>();

  const lin = (name: string): string[] => {
    const cached = memo.get(name);
    if (cached) return cached;
    const pack = byName.get(name)!;
    // Dedupe dep NAMES: two same-name deps (or a pack listing one dep twice) are one node after
    // identity-dedup, so the linearization lists must carry it once — else the [deps] list holds a
    // duplicate that has no valid C3 "good head" (it appears in its own tail).
    const deps = [...new Set((pack.deps ?? []).map((d) => d.name))];
    const lists: string[][] = [...deps.map((d) => lin(d)), [...deps]];
    const merged = merge(lists, name);
    const result = [name, ...merged];
    memo.set(name, result);
    return result;
  };

  // A synthetic top depending on all roots gives the total order; drop the synthetic head.
  const rootNames = [...new Set(roots.map((r) => r.name))];
  const top = merge([...rootNames.map((n) => lin(n)), [...rootNames]], "<assembly-root>");
  return dedupeStable(top);
}

/** A "good head" for C3 merge: the first list-head that appears in no list's TAIL (non-head
 *  position). Returns undefined when none exists (an inconsistent hierarchy). */
function findGoodHead(work: string[][]): string | undefined {
  for (const list of work) {
    const candidate = list[0];
    const inSomeTail = work.some((l) => l.slice(1).includes(candidate));
    if (!inSomeTail) return candidate;
  }
  return undefined;
}

function merge(lists: string[][], owner: string): string[] {
  const out: string[] = [];
  const work = lists.map((l) => [...l]).filter((l) => l.length > 0);
  while (work.length > 0) {
    const head = findGoodHead(work);
    if (head === undefined) throw new AssembleLinearizationError(owner);
    out.push(head);
    for (let i = work.length - 1; i >= 0; i--) {
      if (work[i][0] === head) work[i].shift();
      if (work[i].length === 0) work.splice(i, 1);
    }
  }
  return out;
}

function dedupeStable(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names)
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  return out;
}

function withTimeout<T>(p: Promise<T> | T, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AssemblePackTimeoutError(name, ms)), ms);
  });
  return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(timer));
}

/** Shared core for both assemblers: closure + cycle-detect + dedup + C3 linearization. Returns
 *  the apply order (highest precedence first) and the deduped packs by name. */
function linearize<E>(roots: readonly EnvPack<E>[]): { order: string[]; byName: Map<string, EnvPack<E>> } {
  const byName = closure(roots);
  const order = c3Linearize(roots, byName);
  return { order, byName };
}

function makeCtx<E>(
  order: string[],
  preludeOpts: { preludeScope?: PreludeBindTarget; preludeEvalScope?: E } = {},
): { ctx: PackContext<E>; runDisposers: () => Promise<void> } {
  const disposers: Array<() => void | Promise<void>> = [];
  const ctx: PackContext<E> = {
    onDispose: (fn) => disposers.push(fn),
    order,
    preludeScope: preludeOpts.preludeScope,
    preludeEvalScope: preludeOpts.preludeEvalScope,
  };
  const runDisposers = async () => {
    for (let i = disposers.length - 1; i >= 0; i--) {
      try {
        await disposers[i]();
      } catch {
        /* best-effort teardown */
      }
    }
  };
  return { ctx, runDisposers };
}

// ── The kernel-internal, BAKE-SCOPED prelude overlay (bootstrap assembly) ────────────────────
//
// ENV T2 (docs/working-proposals/environment-resolution-chain.md §1): assembly IS the bake —
// the one-time phase that evaluates capability preambles against the chain-so-far. The kernel
// owns `preludeOnly` binding + resolution per-assembly, with no env re-parenting:
//
//   • bindings land in a per-assembly `Map` behind `ctx.preludeScope` (a `.set`-only shim —
//     capability.ts's bindTarget only writes);
//   • a resolver registered ON THE BASE ENV answers lookups from that Map for the duration of
//     the C3 loop ONLY. Resolvers are consulted at every layer of a chain walk
//     (`Environment._lookupWithResolvers`: own bindings → resolvers → parent), so a prelude
//     evaluated against R — or any child scope chaining through the base — resolves the symbol
//     exactly like the old overlay-parent did;
//   • at the SEAL (the `finally` — success OR failure) the overlay is DROPPED: the resolver is
//     unregistered wherever the base supports it (`ResolvingEnvironment` does), so no spent
//     machinery survives assembly on any env — T1's "dead weight bounded by assemblies-per-env"
//     ceases to exist. A structural host offering `registerResolver` but no `unregisterResolver`
//     keeps the sealed-flag fallback (the resolver stays registered but answers nothing) —
//     same contract, old residue. Post-seal the name is a plain unbound-variable everywhere —
//     INCLUDING from prelude-defined closures, which walk the live chain at call time.
//     `preludeOnly` therefore means ASSEMBLY-TIME-ONLY. This is the contract, not a gap: a
//     prelude that must bridge a preludeOnly value to runtime captures the VALUE at assembly
//     time (`(define x (the-prelude-verb …))`), never the verb.
//
// Everything is a per-assembly closure (concurrent assemblies never share state); only the id
// uniquifier below is module-level, so two overlapping assemblies over the SAME base register
// distinct resolver ids (Environment.registerResolver dedups by id).

/** The structural face of a resolver-capable base (mirrors scheme-env.ts's `SchemeEnv.
 *  registerResolver`/`ResolverSpec` WITHOUT importing them — the kernel stays env-agnostic;
 *  a non-scheme `E` simply never gets the resolver and Map-bound symbols stay unreachable).
 *  `unregisterResolver` is optional: present ⇒ the bake overlay is removed at seal (zero
 *  residue); absent ⇒ the sealed-flag fallback silences it instead. */
interface ResolverHostLike {
  registerResolver(resolver: { readonly id: string; resolve(name: string): unknown }): unknown;
  unregisterResolver?(id: string): unknown;
}
const isResolverHost = (base: unknown): base is ResolverHostLike =>
  typeof (base as { registerResolver?: unknown } | null | undefined)?.registerResolver === "function";

let bakeOverlaySeq = 0;

/**
 * Assemble `base` into a capability-scoped env by resolving the pack DAG — the BAKE phase
 * (ENV T2, design §1). Async by construction. Applies each pack once in C3 order
 * (least-precedence first ⇒ last-write-wins matches C3). On any apply failure, runs disposers
 * collected so far (LIFO) and rejects — no half-built env escapes.
 *
 * `ctx.preludeScope` is ALWAYS provided — the kernel-internal, bake-scoped prelude overlay
 * (see the block comment above), dropped at seal. Mid-run application
 * (`RuntimeAssembler.require`) keeps its caller-supplied `preludeScope`/`preludeEvalScope`
 * override (§1.4) — that path applies onto a LIVE env, where the discarded-child topology is
 * the safe one.
 *
 * The kernel stays env-agnostic, so the SEALED ARTIFACT — the `CompiledResolutionChain`
 * (eval/CompiledResolutionChain.ts) — is compiled by the scheme-side assembly call sites
 * (generator-exec's `ensureBaseAssembled`/`assembleCapabilityBase` call
 * `sealResolutionChain(base)` right after this resolves).
 */
export async function assembleEnv<E>(base: E, roots: readonly EnvPack<E>[]): Promise<AssembledEnv<E>> {
  const { order, byName } = linearize(roots);
  // Per-assembly closure: the overlay Map + sealed flag live and die with THIS call.
  let sealed = false;
  const preludeMap = new Map<string, unknown>();
  let overlayHost: ResolverHostLike | undefined;
  let overlayId: string | undefined;
  const preludeScope: PreludeBindTarget = {
    set: (name, value) => {
      // Register the overlay resolver lazily, on the FIRST preludeOnly binding — an assembly
      // with none (the overwhelmingly common case) leaves the base env untouched.
      if (overlayId === undefined && isResolverHost(base)) {
        overlayHost = base;
        overlayId = `kernel/bake-overlay#${bakeOverlaySeq++}`;
        overlayHost.registerResolver({
          id: overlayId,
          resolve: (lookupName) => (sealed ? undefined : preludeMap.get(lookupName)),
        });
      }
      preludeMap.set(name, value);
      return value;
    },
  };
  const { ctx, runDisposers } = makeCtx<E>(order, { preludeScope });
  try {
    for (const name of order.toReversed()) {
      const pack = byName.get(name)!;
      try {
        await withTimeout(pack.apply(base, ctx), packTimeoutMs(), name);
      } catch (error) {
        await runDisposers();
        if (error instanceof AssemblePackTimeoutError) throw error;
        throw new AssemblePackError(name, error);
      }
    }
  } finally {
    // THE SEAL (design §1): after the C3 loop (success or failure) the bake-scoped overlay
    // is dropped — preludeOnly symbols are unreachable, and where the base supports
    // unregistration no resolver remains registered at all (zero residue).
    sealed = true;
    if (overlayId !== undefined) overlayHost?.unregisterResolver?.(overlayId);
    preludeMap.clear();
  }
  return { env: base, order, dispose: runDisposers };
}

/** A live-env assembler for RUNTIME pack application — the `(require/extension :name)` path. Where
 *  `assembleEnv` builds a fresh env once at construction, this applies registered packs onto an
 *  ALREADY-LIVE env mid-run, idempotently and single-flight (a second require of the same pack — or a
 *  concurrent one from a parallel HOF arm — awaits the one in-flight apply, never re-applies). Each
 *  pack's deps are applied first in C3 order, and a pack reached two ways applies once. Disposers are
 *  collected for a single LIFO `dispose()` tied to the env's teardown. */
export interface RuntimeAssembler<E = unknown> {
  /** Apply `pack` (and any not-yet-applied deps) to the live env, in C3 order. Idempotent.
   *  `opts.preludeScope`/`opts.preludeEvalScope`, when passed, are threaded onto every applied
   *  pack's `ctx` for THIS require() call only — see `PackContext.preludeScope` /
   *  `.preludeEvalScope` + the mid-run design note in
   *  docs/package-specific/arrival-scheme/prelude-only-symbols-and-composable-prompt-2026-07-02.md §1.4
   *  (a scheme-aware caller seeds a discarded CHILD scope here — the live env can't be handed to
   *  bootstrap's phase-gated machinery mid-run, and it must not accumulate prelude defines). */
  require(pack: EnvPack<E>, opts?: { preludeScope?: PreludeBindTarget; preludeEvalScope?: E }): Promise<void>;
  /** Tear down every runtime-applied pack, LIFO (reverse of apply order). */
  dispose(): Promise<void>;
}

export function createRuntimeAssembler<E>(env: E): RuntimeAssembler<E> {
  // name → the in-flight-or-settled apply promise. Presence = APPLYING|APPLIED (single-flight key);
  // a rejecting apply deletes its entry so a later require may retry (FAILED → APPLYING).
  const applied = new Map<string, Promise<void>>();
  const disposers: Array<() => void | Promise<void>> = [];

  // todo replace with DefaultedMap
  const applyOne = (
    name: string,
    pack: EnvPack<E>,
    order: readonly string[],
    preludeOpts: { preludeScope?: PreludeBindTarget; preludeEvalScope?: E },
  ): Promise<void> => {
    const existing = applied.get(name);
    if (existing) return existing; // idempotent + single-flight (no await between get and set below)
    const ctx: PackContext<E> = {
      onDispose: (fn) => disposers.push(fn),
      order,
      preludeScope: preludeOpts.preludeScope,
      preludeEvalScope: preludeOpts.preludeEvalScope,
    };
    // The async IIFE turns a SYNCHRONOUS throw in apply() into a rejection so the catch handles it
    // uniformly (a bare `pack.apply(...)` would throw before withTimeout was even called).
    const p = (async () => withTimeout(pack.apply(env, ctx), packTimeoutMs(), name))().catch((error) => {
      applied.delete(name); // FAILED: drop so a re-require retries; the pack's own disposers ran via ctx
      if (error instanceof AssemblePackTimeoutError) throw error;
      throw new AssemblePackError(name, error);
    });
    applied.set(name, p);
    return p;
  };

  return {
    require: async (pack: EnvPack<E>, opts: { preludeScope?: PreludeBindTarget; preludeEvalScope?: E } = {}): Promise<void> => {
      const { order, byName } = linearize([pack]);
      // Apply least-precedence (deps) first, matching construction's last-write-wins order.
      for (const name of order.toReversed()) {
        await applyOne(name, byName.get(name)!, order, opts);
      }
    },
    dispose: async (): Promise<void> => {
      for (let i = disposers.length - 1; i >= 0; i--) {
        try {
          await disposers[i]();
        } catch {
          /* best-effort teardown */
        }
      }
    },
  };
}
