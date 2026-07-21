// kernel.ts — the IMPLEMENTATION of arrival's env-assembly machine. Env-agnostic core: closure +
// 3-color cycle detection, identity dedup, C3 linearization (the merge), and the apply loop with
// LIFO disposal + per-pack apply timeout. A pack is a named, dependency-carrying, async capability
// contribution to an env.
//
// The MODEL — what assembly is, why C3 (= Python MRO), the dep-edge-is-grant law, apply-once, and
// the DAG-authoring-form → flat-runtime-form lowering — is docs/environments.md §ASSEMBLY, the single
// authoritative statement; this file enforces it.

// Door-set degradation's `DegradedCapability`/`DegradedNeed` types are TYPE-ONLY, from the
// degradation-domain module (common/degradation.ts) — kernel stays env-agnostic (no runtime
// dependency; the import erases at compile time), and the shape is defined once, not mirrored.
import type { DegradedCapability } from "./degradation.js";
// TYPE-ONLY, same posture: the per-env binding context a capability-lowered pack exposes
// (`LoweredPack.activation`). capability.ts's own imports from this module are type-only too,
// so the cycle is purely in type space — zero runtime edge; kernel stays env-agnostic (a pack
// that carries no activation — every plain kernel pack — simply contributes nothing to the fold).
import type { Activation } from "./capability.js";

// Errors (teaching, errors-as-doors) live in errors.ts (the single error home). Imported here for
// the throw sites below; the /env barrel surfaces them to consumers by importing errors.ts DIRECTLY
// (no passthrough through this module).
import {
  AssembleConfigConflictError,
  AssembleCycleError,
  AssembleLinearizationError,
  AssemblePackError,
  AssemblePackTimeoutError,
} from "../errors.js";

/** A capability contribution to an env. Identity = (name, config). `deps` are the DAG edges. */
export interface EnvPack<E = unknown> {
  readonly name: string;
  readonly deps?: readonly EnvPack<E>[];
  /** Host-injected arming for THIS pack (inferPack.config = the InferFn, mcpPack.config = the
   *  resolver). Two same-name packs with non-equal config in one assembly = AssembleConfigConflictError. */
  readonly config?: unknown;
  /** Door-set degradation — a capability-aware `lower()` (common/capability.ts) MAY report
   *  here, eagerly, that it lowered degraded (an absent optional-enabling config key, under
   *  `degradation: "doors"`). Kernel-agnostic by construction: this field is an opaque, purely
   *  structural bag `assembleEnv` folds into `AssembledEnv.degraded` without interpreting it —
   *  a pack that never sets it (every pure-JS pack, every capability that didn't degrade)
   *  simply contributes nothing. Absent, not an empty array, when nothing degraded. */
  readonly degraded?: readonly DegradedCapability[];
  /** The per-env binding context a capability-aware `lower()` armed (see
   *  `LoweredPack.activation`, common/capability.ts) — OPTIONAL and structural: the kernel
   *  never interprets it, only folds present ones into `AssembledEnv.activations` (the
   *  phase-2 metadata read channel). Plain kernel packs never set it. */
  readonly activation?: Activation<any, any>;
  /** Runs once, after all deps, in C3 order. May await import / defineRosetta / ctx.onDispose.
   *  MUST contribute symbols via the env's membrane-wrapping API, never a bare host closure. */
  apply(env: E, ctx: PackContext<E>): void | Promise<void>;
}

/** The narrow surface a `preludeOnly` symbol's BINDING lands on. Deliberately just `.set`:
 *  capability.ts's bindTarget only ever writes. In BOOTSTRAP assembly this is the kernel's own
 *  Map-backed shim (see `assembleEnv`); in MID-RUN application it is the caller's adapter over
 *  a real, discarded child frame (loader-capability.ts wraps the module-internal `bindValue` —
 *  `SchemeEnv` itself carries no write member; docs/environments.md §HERMETIC). */
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
   *  MID-RUN (`RuntimeAssembler.require`): caller-supplied — a discarded child `C'` of the live
   *  env (@inhuman.tools/arrival/loader's `arrivalLoaderCapability`, `require/extension`'s
   *  declaration). Undefined when that caller passes none. */
  readonly preludeScope?: PreludeBindTarget;
  /** The scope a capability's `prelude` TEXT is evaluated AGAINST — distinct from
   *  `preludeScope` (the bind target):
   *    - BOOTSTRAP: left undefined; capability.ts falls back to evaluating against `env` = R,
   *      so prelude `define`s land in R while `preludeOnly` lookups are answered by the
   *      kernel's phase-gated resolver on the base.
   *    - MID-RUN: `preludeScope` = `preludeEvalScope` = a discarded CHILD `C'` of the live env.
   *      Re-parenting a LIVE env is unsafe (concurrent lookups), so the prelude is evaluated IN
   *      `C'` instead: lookups miss `C'` → hit `liveEnv` → base, and `C'` (with any prelude
   *      `define`s) is simply dropped when `require()` returns — the deliberate mid-run
   *      asymmetry (a mid-run pack's prelude cannot contribute runtime bindings). */
  readonly preludeEvalScope?: E;
}

export interface AssembledEnv<E = unknown> {
  readonly env: E;
  /** The C3 linearization, highest precedence (roots) first. */
  readonly order: readonly string[];
  /** Every capability that lowered degraded — an enumerable degraded list, folded from each
   *  applied pack's own `EnvPack.degraded`, in apply order. A host/discovery reader inspects
   *  this instead of inferring degradation from a throw or probing symbols one by one; empty
   *  when nothing degraded (including every assembly under the default `"forbid"` mode, where
   *  no capability's `Activation.degradation.active` is ever true). */
  readonly degraded: readonly DegradedCapability[];
  /** Each applied pack's activation (validated config + resource cells + degradation),
   *  keyed by pack name, apply order — folded from `EnvPack.activation`, uninterpreted
   *  (the additive posture `degraded` set). THE describe-time read channel: dynamic
   *  metadata fields resolve against exactly these objects. Packs that carry no activation
   *  contribute nothing. */
  readonly activations: ReadonlyMap<string, Activation<any, any>>;
  dispose(): Promise<void>;
}

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
// The `preludeOnly` assembly-time-only contract — bindings in a per-assembly `Map` behind
// `ctx.preludeScope`, a base-env resolver live only for the C3 loop, the seal that drops it
// (unregister where the host supports it for zero residue, a sealed-flag silencer where it does
// not), and why post-seal the name is unbound everywhere including from prelude-defined closures
// (so a bridge captures the VALUE, not the verb) — is docs/environments.md §PRELUDE. Two facts are
// local to THIS implementation:
//   • the base-env resolver is consulted at every chain layer
//     (`AmbientRuntime._lookupWithResolvers`: own bindings → resolvers → parent), so a prelude
//     evaluated against R — or any child chaining through the base — resolves the symbol exactly
//     like a real binding;
//   • everything is a per-assembly closure (concurrent assemblies share no state); only the id
//     uniquifier below is module-level, so two overlapping assemblies over the SAME base register
//     distinct resolver ids (`AmbientRuntime.registerResolver` dedups by id).

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
 * Assemble `base` into a capability-scoped env by resolving the pack DAG — the BAKE phase.
 * Async by construction. Applies each pack once, least-precedence (deepest dependency) first —
 * last-write-wins, per docs/environments.md §ASSEMBLY. On any apply failure, runs disposers collected
 * so far (LIFO) and rejects — no half-built env escapes.
 *
 * `ctx.preludeScope` is ALWAYS provided — the kernel-internal, bake-scoped prelude overlay
 * (see the block comment above), dropped at seal. Mid-run application
 * (`RuntimeAssembler.require`) keeps its caller-supplied `preludeScope`/`preludeEvalScope`
 * override — that path applies onto a LIVE env, where the discarded-child topology is the
 * safe one.
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
    // THE SEAL: after the C3 loop (success or failure) the bake-scoped overlay is dropped —
    // preludeOnly symbols are unreachable, and where the base supports unregistration no
    // resolver remains registered at all (zero residue).
    sealed = true;
    if (overlayId !== undefined) overlayHost?.unregisterResolver?.(overlayId);
    preludeMap.clear();
  }
  // Fold each applied pack's own `.degraded` into the assembly-level list, apply order
  // (highest precedence first, matching `order`) — purely structural, kernel never interprets it.
  const degraded = order.flatMap((name) => byName.get(name)!.degraded ?? []);
  // Fold each applied pack's activation (when present — capability-lowered packs only), same
  // order, same uninterpreted posture. The phase-2 metadata read channel.
  const activations = new Map<string, Activation<any, any>>();
  for (const name of order) {
    const activation = byName.get(name)!.activation;
    if (activation !== undefined) activations.set(name, activation);
  }
  return { env: base, order, degraded, activations, dispose: runDisposers };
}

/** A live-env assembler for RUNTIME pack application — the `(require/extension :name)` path
 *  (§LOADER). The mid-run single-flight contract — apply onto an ALREADY-LIVE env, a second or
 *  concurrent `require` awaiting the one in-flight apply (never re-applying), deps applied first in
 *  C3 order, a pack reached two ways applied once — is docs/environments.md §ASSEMBLY. Disposers collect
 *  for a single LIFO `dispose()` tied to the env's teardown. */
export interface RuntimeAssembler<E = unknown> {
  /** Apply `pack` (and any not-yet-applied deps) to the live env, in C3 order. Idempotent.
   *  `opts.preludeScope`/`opts.preludeEvalScope`, when passed, are threaded onto every applied
   *  pack's `ctx` for THIS require() call only — see `PackContext.preludeScope` /
   *  `.preludeEvalScope` (a scheme-aware caller seeds a discarded CHILD scope here — the live
   *  env can't be handed to bootstrap's phase-gated machinery mid-run, and it must not
   *  accumulate prelude defines). */
  require(pack: EnvPack<E>, opts?: { preludeScope?: PreludeBindTarget; preludeEvalScope?: E }): Promise<void>;
  /** Tear down every runtime-applied pack, LIFO (reverse of apply order). */
  dispose(): Promise<void>;
}

export function createRuntimeAssembler<E>(env: E): RuntimeAssembler<E> {
  // name → the in-flight-or-settled apply promise. Presence = APPLYING|APPLIED (single-flight key);
  // a rejecting apply deletes its entry so a later require may retry (FAILED → APPLYING).
  const applied = new Map<string, Promise<void>>();
  const disposers: Array<() => void | Promise<void>> = [];

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
    require: async (
      pack: EnvPack<E>,
      opts: { preludeScope?: PreludeBindTarget; preludeEvalScope?: E } = {},
    ): Promise<void> => {
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
