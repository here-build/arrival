/**
 * CompiledResolutionChain — the SEALED, ambient form of a baked capability base.
 *
 * This class **is** "BakedBase" — the immutable, no-write-surface product of a bake.
 * No separate `BakedBase` wrapper type exists: this artifact has zero mutators
 * (a frozen `Map`, `lookup`/`toString` only), so the type-level
 * distinction from the mutable `AmbientRuntime` (lexical) frame it seals FROM is real —
 * `Capabilities.globalRoot`/`refFrame` (assembled mode) return THIS object as the
 * hygiene sentinel (see Capabilities.ts).
 *
 * Assembly (the BAKE) writes onto a live env chain: packs bind natives in C3 order,
 * preludes evaluate against the chain-so-far, `preludeOnly` bindings ride the kernel's
 * bake-scoped overlay (a `ResolvingAmbient.registerResolver` middleware, torn down via
 * `unregisterResolver` in a `finally` before `assembleEnv` resolves — kernel.ts). At the
 * SEAL, this module compiles the frame chain into a frozen artifact: every layer's
 * `__env__` record, merged child-wins into ONE flat `Map` — this IS the whole
 * compilation, because by the time a base reaches seal, the kernel's own overlay has
 * already unregistered and no capability declares a resolver of its own (the
 * capability-facing `EnvCapability.resolvers`/`ResolverSpec` contract was retired —
 * see docs/environments.md's revision history — leaving `ResolvingAmbient`'s resolver
 * primitive alive ONLY for the kernel's transient bake-overlay, which never survives to
 * this point). `compileResolutionChain` asserts that invariant rather than silently
 * dropping a live resolver it can no longer represent.
 *
 * WRITE-WINDOW: the artifact has no write surface — post-seal writes to the underlying
 * env are outside the contract. REPL accumulation rides the mutable session frame
 * ABOVE the chain (generator-exec's `defaultLexicalRoot`), never the ambient artifact.
 * GLASS callers (custom `{ env }`) keep the live env walk by definition — glass envs
 * don't bake; this module never sees them.
 *
 * CONTENT ADDRESS: `hash` is a deterministic composition of the merged vocabulary
 * (sorted names) — the coarse program+epoch identity the PROVENANCE track's
 * "baked-env hash" slot consumes. Binding-VALUE hashing (natives are JS-backed) is
 * DEFERRED — cross-deploy chain reuse needs a ruling first; two deploys with the same
 * vocabulary shape currently share a hash.
 */
import invariant from "tiny-invariant";
import { type AmbientRuntime, type AmbientValue, ResolvingAmbient } from "../env/AmbientRuntime.js";
import type { RunContext } from "../run/RunContext.js";

export class CompiledResolutionChain {
  /** The one merged, frozen map every lookup reads — the degenerate (= only-occurring)
   *  form the layered chain always compiles to now that no live resolver survives to
   *  seal. Exposed as a single-element tuple (`steps`) for callers/tests that still
   *  introspect the chain's step shape. */
  readonly steps: readonly [ReadonlyMap<string | symbol, AmbientValue>];
  /** Content address (see the module header — vocabulary-shape identity, value hashing deferred). */
  readonly hash: string;
  /** The merged vocabulary (MCP discovery / allBoundNames). */
  readonly names: ReadonlySet<string | symbol>;

  private readonly flat: ReadonlyMap<string | symbol, AmbientValue>;

  constructor(flat: ReadonlyMap<string | symbol, AmbientValue>) {
    this.flat = flat;
    this.steps = [flat];
    this.names = new Set(flat.keys());
    this.hash = hashFlatMap(flat);
  }

  /** The composed base lookup — `undefined` on a miss. `ctx` is accepted for call-site
   *  symmetry with the live resolver walk (`AmbientRuntime._lookupWithResolvers`) but
   *  unused here: a flat map has no run-dependent middleware to thread it through. */
  lookup(name: string | symbol, _ctx?: RunContext): AmbientValue | undefined {
    return this.flat.get(name);
  }

  toString(): string {
    return `#<compiled-resolution-chain:${this.hash}:1 step(s)>`;
  }
}

/** Canonical name form for the content address: strings as-is, symbols marked. */
function canonicalName(key: string | symbol): string {
  return typeof key === "string" ? key : `#sym:${String(key.description ?? "")}`;
}

/** Locale-independent, code-unit-wise comparator — the content address must be
 *  byte-stable across realms and locales (localeCompare is neither). */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** FNV-1a over the canonical, sorted vocabulary — deterministic, realm-independent. */
function hashFlatMap(flat: ReadonlyMap<string | symbol, AmbientValue>): string {
  const canonical = ["crc-v0", [...flat.keys()].map(canonicalName).toSorted(byCodeUnit).join(",")].join("|");
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Compile a sealed env chain into its ambient artifact. Walks `base → … → root`
 * child-first, merging every layer's OWN bindings into ONE flat map (a closer layer's
 * entry overwrites — child-wins union, matching the live walk's own-bindings
 * precedence). Asserts, per layer, that no live resolver remains registered — the
 * kernel's bake-overlay is the only production registrant, and it tears down before
 * `assembleEnv` resolves (kernel.ts's `finally`), so a resolver surviving to seal means
 * some caller registered one directly (or reached this function mid-bake) and the
 * artifact this module produces cannot represent it.
 */
export function compileResolutionChain(base: AmbientRuntime): CompiledResolutionChain {
  const layers: AmbientRuntime[] = [];
  for (let layer: AmbientRuntime | null = base; layer !== null; layer = layer.__parent__) layers.push(layer);

  const merged = new Map<string | symbol, AmbientValue>();
  // Deepest layer first so a CLOSER layer's entry overwrites — child-wins union.
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (layer instanceof ResolvingAmbient) {
      invariant(
        layer.resolverSpecs().length === 0,
        `compileResolutionChain: layer "${String(layer.__name__)}" still has ${layer.resolverSpecs().length} ` +
          `live resolver(s) registered at seal time — the sealed chain has no resolver-interleaving ` +
          `representation (retired with the capability-facing ResolverSpec contract); the kernel's own ` +
          `bake-overlay must unregister before assembly resolves.`,
      );
    }
    const record = layer.__env__;
    for (const key of Object.keys(record)) merged.set(key, record[key]);
    for (const sym of Object.getOwnPropertySymbols(record)) merged.set(sym, record[sym]);
  }

  return new CompiledResolutionChain(merged);
}

// ── The seal registry ────────────────────────────────────────────────────────────────
//
// ONE chain per baked base (realm-shared memo, GC'd with the env). The vocabulary-path
// assembly call sites call this at bake end — the explicit SEAL — so an assembled base
// reaching the exec seam by any route resolves through the same artifact.
const sealedChains = new WeakMap<AmbientRuntime, CompiledResolutionChain>();

export function sealResolutionChain(base: AmbientRuntime): CompiledResolutionChain {
  let chain = sealedChains.get(base);
  if (chain === undefined) {
    chain = compileResolutionChain(base);
    sealedChains.set(base, chain);
  }
  return chain;
}
