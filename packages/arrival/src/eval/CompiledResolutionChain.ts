/**
 * CompiledResolutionChain — the SEALED, ambient form of a baked capability base.
 *
 * This class **is** "BakedBase" — the immutable, no-write-surface product of a bake.
 * No separate `BakedBase` wrapper type exists: this artifact has zero mutators
 * (frozen maps + resolver steps, `lookup`/`toString` only), so the type-level
 * distinction from the mutable `AmbientRuntime` (lexical) frame it seals FROM is real —
 * `Capabilities.globalRoot`/`refFrame` (assembled mode) return THIS object as the
 * hygiene sentinel (see Capabilities.ts).
 *
 * Assembly (the BAKE) writes onto a live env chain: packs bind natives in C3 order,
 * preludes evaluate against the chain-so-far, `preludeOnly` bindings ride the kernel's
 * bake-scoped overlay (dropped at seal — kernel.ts). At the SEAL, this module compiles
 * that chain into a frozen artifact:
 *
 *   Per-layer semantics is own-bindings → own-resolvers (registration order) →
 *   parent — a PRECEDENCE CONTRACT (AmbientRuntime.ts). Flattening the layer chain yields
 *   `[map_L0, r_L0…, map_L1, r_L1…, …]`; because the bake froze every map, adjacent maps
 *   with no resolver between them MERGE at seal into one flat Map (child-wins union) —
 *   sound by immutability, order-preserving by construction. A resolver in layer Lᵢ
 *   splits the merge exactly at its position.
 *
 *   DEGENERATE case (zero live resolvers — today's in-repo reality: no pack declares
 *   `spec.resolvers`, and the kernel's prelude overlay unregisters at seal): the whole
 *   chain compiles to ONE flat Map and `lookup` is a single `Map.get` — faster than the
 *   per-layer `Object.hasOwn` walk + resolver loop + recursion it replaces.
 *
 * WRITE-WINDOW: the artifact has no write surface — post-seal writes to the underlying
 * env are outside the contract. REPL accumulation rides the mutable session frame
 * ABOVE the chain (generator-exec's `defaultLexicalRoot`), never the ambient artifact.
 * GLASS callers (custom `{ env }`) keep the live env walk by definition — glass envs
 * don't bake; this module never sees them.
 *
 * CONTENT ADDRESS: `hash` is a deterministic composition of the merged vocabulary
 * (sorted names) + resolver ids/purity in step position — the coarse program+epoch
 * identity the PROVENANCE track's "baked-env hash" slot consumes. Binding-VALUE hashing
 * (natives are JS-backed) is DEFERRED — cross-deploy chain reuse needs a ruling first;
 * two deploys with the same vocabulary shape currently share a hash.
 */
import { assertResolvedBinding, type AmbientRuntime, type AmbientValue, ResolvingAmbient } from "../AmbientRuntime.js";
import type { RunContext } from "../run/RunContext.js";

/**
 * A resolver step in the compiled chain — the genuine runtime middleware contract.
 * `pure` is a DECLARED flag (P16 honesty — the alarm catches contradictions, not
 * lies): `pure: true` promises name-stable results (same name ⇒ same value forever),
 * which licenses memoization through this step; default `false` (safe — a dynamic
 * middleware may start answering tomorrow).
 */
export class CompiledResolver {
  /** Promotion memo for PURE hits — consulted before THIS STEP, never
   *  before the whole chain: an EARLIER impure resolver may start answering a name
   *  tomorrow and must keep winning, so the memo may only shortcut the step it
   *  promotes for. Sound because every step BEFORE this one is a frozen map or its
   *  own (re-probed) resolver. Preserves the identity contract: `(eq? x x)` holds
   *  for a synthesized callable across lookups (the cxrCache shape, generalized).
   *  Lives on the step, GC'd with the chain — never on frames. */
  private readonly memo: Map<string | symbol, AmbientValue> | undefined;

  constructor(
    readonly id: string,
    readonly resolve: (name: string, ctx?: RunContext) => unknown,
    readonly pure: boolean,
  ) {
    this.memo = pure ? new Map() : undefined;
  }

  /** The step probe the chain walk calls: memo (pure only) → resolve → promote.
   *  `ctx` is the resolving read's RunContext (threaded from the evaluator's lookup;
   *  absent on run-less reads). NOTE the memo/ctx interplay: a `pure` step's hits are
   *  served across runs, so a pure resolver's contract is to mint RUN-NEUTRALLY — the
   *  memo never re-stamps (see `ResolverSpec.resolve`'s doc, common/scheme-env.ts). */
  probe(name: string | symbol, ctx?: RunContext): AmbientValue | undefined {
    const promoted = this.memo?.get(name);
    if (promoted !== undefined) return promoted;
    const hit = this.resolve(String(name), ctx);
    if (hit === undefined) return undefined;
    // Boxed-at-the-resolver's-boundary contract — same door as the live walk
    // (ResolvingAmbient._lookupWithResolvers): raw JS never enters resolution.
    assertResolvedBinding(hit, name, this.id);
    this.memo?.set(name, hit as AmbientValue);
    return hit as AmbientValue;
  }
}

/** One chain step: a merged frozen map, or an interleaved resolver probe. */
type ResolutionStep = ReadonlyMap<string | symbol, AmbientValue> | CompiledResolver;

export class CompiledResolutionChain {
  /** Maps pre-merged at seal, resolvers in their C3-position. */
  readonly steps: readonly ResolutionStep[];
  /** Content address (see the module header — vocabulary-shape identity, value hashing deferred). */
  readonly hash: string;
  /** The merged STATIC vocabulary (MCP discovery / allBoundNames) — resolver-synthesized
   *  names are not enumerable and deliberately absent. */
  readonly names: ReadonlySet<string | symbol>;

  /** Set iff the chain is the degenerate zero-resolver form — `lookup` = one `Map.get`. */
  private readonly flat: ReadonlyMap<string | symbol, AmbientValue> | undefined;
  /** Negative miss-cache (memoizing "unbound") — sound iff EVERY resolver is pure,
   *  computed once at seal: one impure resolver disables it globally (a
   *  dynamic middleware may start answering tomorrow). Omitted in the zero-resolver
   *  form (a flat-map miss is already one `Map.get`). Lives ON the chain (realm-shared,
   *  GC'd with it), never on frames. */
  private readonly misses: Set<string | symbol> | undefined;

  constructor(steps: readonly ResolutionStep[]) {
    this.steps = steps;
    const names = new Set<string | symbol>();
    let resolverCount = 0;
    let allPure = true;
    for (const step of steps) {
      if (step instanceof CompiledResolver) {
        resolverCount++;
        allPure &&= step.pure;
      } else {
        for (const key of step.keys()) names.add(key);
      }
    }
    this.names = names;
    const [first] = steps;
    const degenerate = resolverCount === 0 && steps.length === 1 && !(first instanceof CompiledResolver);
    this.flat = degenerate ? first : undefined;
    this.misses = resolverCount > 0 && allPure ? new Set() : undefined;
    this.hash = hashSteps(steps);
  }

  /** The composed base lookup — `undefined` on a miss, no synth (the keyword/cxr synth
   *  layer stays in Resolver.resolve, ABOVE this). `ctx` = the resolving read's
   *  RunContext, forwarded to resolver steps only (map probes need no run identity). */
  lookup(name: string | symbol, ctx?: RunContext): AmbientValue | undefined {
    const flat = this.flat;
    if (flat !== undefined) return flat.get(name); // the degenerate fast path: ONE Map.get
    if (this.misses?.has(name)) return undefined;
    for (const step of this.steps) {
      const hit = step instanceof CompiledResolver ? step.probe(name, ctx) : step.get(name);
      if (hit !== undefined) return hit;
    }
    this.misses?.add(name);
    return undefined;
  }

  toString(): string {
    return `#<compiled-resolution-chain:${this.hash}:${this.steps.length} step(s)>`;
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

/** FNV-1a over the canonical step composition — deterministic, realm-independent. */
function hashSteps(steps: readonly ResolutionStep[]): string {
  const parts: string[] = ["crc-v0"];
  for (const step of steps) {
    if (step instanceof CompiledResolver) {
      parts.push(`resolver:${step.id}:${step.pure}`);
    } else {
      parts.push(`map:${[...step.keys()].map(canonicalName).toSorted(byCodeUnit).join(",")}`);
    }
  }
  const canonical = parts.join("|");
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Compile a sealed env chain into its ambient artifact. Walks `base → … → root`
 * child-first; per layer, own bindings precede own resolvers precede the parent —
 * the exact precedence contract the live walk implements (AmbientRuntime.ts), so the
 * module-composition ordering pins bind this step order by construction.
 */
export function compileResolutionChain(base: AmbientRuntime): CompiledResolutionChain {
  const steps: ResolutionStep[] = [];
  /** Layers whose maps are pending merge (child-first). */
  let pending: AmbientRuntime[] = [];

  const flushMerged = (): void => {
    if (pending.length === 0) return;
    const merged = new Map<string | symbol, AmbientValue>();
    // Deepest layer first so a CLOSER layer's entry overwrites — child-wins union.
    for (let i = pending.length - 1; i >= 0; i--) {
      const record = pending[i].__env__;
      for (const key of Object.keys(record)) merged.set(key, record[key]);
      for (const sym of Object.getOwnPropertySymbols(record)) merged.set(sym, record[sym]);
    }
    pending = [];
    // An empty span between two resolvers contributes nothing — skip it (but keep the
    // one map of an empty zero-resolver chain, so `flat` always exists in that form).
    if (merged.size === 0 && steps.length > 0) return;
    steps.push(merged);
  };

  for (let layer: AmbientRuntime | null = base; layer !== null; layer = layer.__parent__) {
    pending.push(layer);
    const specs = layer instanceof ResolvingAmbient ? layer.resolverSpecs() : [];
    if (specs.length > 0) {
      flushMerged(); // this layer's own bindings precede its resolvers
      for (const spec of specs) {
        steps.push(new CompiledResolver(spec.id, (name, ctx) => spec.resolve(name, ctx), spec.pure === true));
      }
    }
  }
  flushMerged();
  if (steps.length === 0) steps.push(new Map());

  return new CompiledResolutionChain(steps);
}

// ── The seal registry ────────────────────────────────────────────────────────────────
//
// ONE chain per baked base (realm-shared memo, GC'd with the env). Assembly call sites
// (generator-exec's `ensureBaseAssembled` / `assembleCapabilityBase`) call this at bake
// end — the explicit SEAL; `Capabilities.assembled` calls it too, so an assembled base
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
