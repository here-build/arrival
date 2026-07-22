/**
 * The phase PRODUCTS of `exec` as first-class values — the six phases, each with a product
 * where one exists:
 *
 *   (1) parse            → {@link ParsedProgram}
 *   (2) assemble ambient → {@link AssembledAmbient}   (constructed by generator-exec's
 *                          `assembleAmbient` — the evalScheme arming lives THERE, so this
 *                          module never imports the exec entry: the import edge is one-way,
 *                          generator-exec → exec-phases, no cycle)
 *   (2.5, optional)      → {@link validateAgainstAmbient} / {@link classifyProgram}
 *                          (pure functions over the phase-1 + phase-2 products)
 *   (3) instantiate      → {@link ExecInstance}        (scope + meter + resolver)
 *   (4) execute          → the per-form loop (stays in generator-exec — it IS the evaluator
 *                          drive, not a product)
 *   (5) dispose          → `AssembledAmbient.dispose()` — ownership rule lives in
 *                          generator-exec's `execState` (the pipeline's OWN step)
 *   (6) return           → `ExecState` (the two-tier cut)
 *
 * GLASS (`{ env }`) gets NO phase products: a glass caller holds a live frame, not an Env —
 * exec makes no claims about it, so there is nothing to productize.
 *
 * Export home: the `/env` subpath (src/env/index.ts), NOT the barrel.
 */

import { AmbientRuntime, type AmbientValue } from "../env/AmbientRuntime.js";
import { AmbientShapeError } from "../errors.js";
import { Capabilities } from "./Capabilities.js";
import { LexicalScope } from "./LexicalScope.js";
import { Resolver } from "./Resolver.js";
import type { CompiledResolutionChain } from "./CompiledResolutionChain.js";
import type { AssembledEnv } from "../common/kernel.js";
import type { Activation, EnvCapability, LoweredPack, SymbolDeclaration } from "../common/capability.js";
import type { DegradedCapability } from "../common/degradation.js";
import type { SchemeEnv } from "../common/scheme-env.js";
import type { AEntity, ProvenanceRole } from "../common/symbols/_bake.js";
import { resolveMetadata, staticMetadata } from "../common/symbols/metadata.js";
import { validateProgram, type Diagnostic } from "../static-validation/validate-program.js";
import { vocabularyFromChain } from "../static-validation/vocabulary.js";
import { classifierFromEnv } from "../provenance/lineage-classifier-from-env.js";
import { classify, type LineageNode } from "../provenance/lineage.js";
import { makeRunContext, type RunContext } from "../run/RunContext.js";
import type { DisplaySink, NoteSink } from "../run/note-sink.js";
import type { RunCache } from "../run/run-cache.js";
import type { EffectLog } from "../run/effect-log.js";
import type { ReadGuard } from "../run/read-guard.js";
import type { SchemeValue } from "../values/types.js";
import { parse as readerParse } from "../reader/parse.js";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — ParsedProgram
// ─────────────────────────────────────────────────────────────────────────────

/** Phase 1 — pure reader output + late-stamped analysis slots. */
export interface ParsedProgram {
  /** Location-bearing top-level forms (APair LOCATION spans survive). */
  readonly forms: readonly SchemeValue[];
  /** The original text, when parsed from a string. */
  readonly source?: string;
  /** Which READER mode produced it — an identity fact of the program, stamped at parse.
   *  (The RUN-time strict mode stays `ExecOptions.strict` → `runCtx` — one option, two
   *  declared landings, no hidden third.) */
  readonly strict: boolean;
  /** Stamped by a validate pass (phase 2.5), not by parse — validation needs the ambient's
   *  vocabulary. Optional + append-only: a ParsedProgram is valid without ever validating. */
  readonly diagnostics?: readonly Diagnostic[];
  /** RESERVED for the provenance track's program-identity work — a declared home so the
   *  field lands in one place when that work arrives. */
  readonly programHash?: string;
}

/** Phase 1, callable: parse `code` into a {@link ParsedProgram}. A pre-parsed
 *  `SchemeValue` wraps as a one-form program (the same acceptance `exec` has always had).
 *  `source` (a filename / module path) stamps every produced location, as with `parse`. */
export async function parseProgram(
  code: string | SchemeValue,
  opts: { strict?: boolean; source?: string } = {},
): Promise<ParsedProgram> {
  const strict = opts.strict ?? false;
  if (typeof code !== "string") return { forms: [code], strict };
  const forms = await readerParse(code, opts.source, strict);
  return { forms, source: code, strict };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — AssembledAmbient
// ─────────────────────────────────────────────────────────────────────────────

/** One catalog entry — a baked declaration's def-level facts unified with its resolved
 *  metadata. Def-level facts stay def-level: `doc`/`type`/`provenance`/`preludeOnly` are
 *  contract-derived and spec-owned; `metadata` is the extension bag. The READ surface
 *  unifies them without moving them. */
export interface SymbolDescription {
  /** The bound name (capability `symbolPrefix` applied). */
  readonly name: string;
  readonly kind: AEntity["kind"];
  /** The OWNING capability's name (nearest roster winner under C3 last-write-wins). */
  readonly capability: string;
  readonly doc?: string;
  readonly type?: string;
  readonly provenance?: ProvenanceRole;
  readonly preludeOnly?: boolean;
  /** The resolved metadata record — static fields verbatim; dynamic fields resolved
   *  against the owning capability's activation, per read, no memo. */
  readonly metadata: Record<string, unknown>;
  /** Which metadata keys resolved DYNAMICALLY on this read — the consumer's
   *  "session-generated" flag source. */
  readonly dynamicKeys: readonly string[];
}

/** Phase 2 — the assembled ambient as a value: the composition, minus the mutable scope
 *  (`topScope` is phase 3's). The ambient is session/realm-scoped and shared across concurrent
 *  runs while scope+meter stay per-run — the lifetime split of docs/execution.md §HERMETIC, made
 *  a type fact. Mint via `assembleAmbient` (generator-exec); reuse via `exec(code, { ambient })`
 *  — CALLER-owned there (exec will not dispose it). */
export interface AssembledAmbient extends AsyncDisposable {
  /** The ORDER / identity roster — the capabilities this ambient was assembled from. */
  readonly capabilities: readonly EnvCapability[];
  /** The composed bootstrap — settled by the time `assembleAmbient` returns; carried as
   *  a promise so the field's shape survives a future lazier constructor unchanged. */
  readonly ready: Promise<AssembledEnv<SchemeEnv>>;
  /** The SEALED resolution chain (BakedBase) — ask-one-by-one, no write surface. */
  readonly chain: CompiledResolutionChain;
  /** Every capability that lowered degraded (assembly-ordered; empty when none). */
  readonly degraded: readonly DegradedCapability[];
  /** Pack-name → activation — the metadata read channel. */
  readonly activations: ReadonlyMap<string, Activation<any, any>>;
  /** Default per-run allocation budget POLICY for runs on this ambient — a DEFAULT, not the
   *  meter: the meter is per-run, minted at phase 3; `ExecOptions.heapBudget` wins per call. */
  readonly heapBudget?: number;
  /** Phase 5 — kernel pack disposers (LIFO) + every lowered pack's resource wind-down.
   *  Idempotent (single-flight). The REALM-DEFAULT ambient's dispose is a documented
   *  no-op — realm-scoped by design, never torn down. */
  dispose(): Promise<void>;
  /** One sealed-chain probe — the capability half of a run's composed resolution. */
  lookup(name: string | symbol): AmbientValue | undefined;
  /** The ambient's enumerable vocabulary (resolver-synthesized names absent, per the
   *  chain's own contract). */
  names(): ReadonlySet<string | symbol>;
  /** Describe one baked-declared symbol — def-level facts + metadata resolved against the
   *  owning capability's activation. `undefined` for names the roster's baked declarations
   *  don't cover (legacy-form symbols, base-stdlib bindings). */
  describeSymbol(name: string): Promise<SymbolDescription | undefined>;
  /** The full baked-declaration catalog, roster-ordered (deps-first / C3 apply order,
   *  nearer capability winning a name clash — matching assembly's last-write-wins). */
  catalog(): Promise<readonly SymbolDescription[]>;
}

/** The internals exec needs but the public product does not expose: the ambient surfaces
 *  `lookup`/`names`/`describeSymbol`/`catalog`, never the concrete frame class. Keyed by
 *  ambient identity. */
interface AmbientInternals {
  readonly base: AmbientRuntime;
  readonly lowered: readonly LoweredPack[];
}

/** The brand lives ON the ambient object under a PROCESS-GLOBAL registered symbol, never in a
 *  module-local side-table. A module-local WeakMap (or even a `globalThis`-pinned one) is
 *  fragile: a bundler can duplicate this module across the `@inhuman.tools/arrival` main entry
 *  (`exec`) and the `/env` subpath (`assembleAmbient`), and Vite dev serves `exec-phases.js?t=…`
 *  as a FRESH module instance on every HMR — each copy gets its own WeakMap, so the brand
 *  `assembleAmbient` set is invisible to the `exec`-side check and every run doors. `Symbol.for`
 *  resolves to the same symbol across every module copy, and the internals ride the object
 *  itself, so any copy reads what any copy wrote — the value carries its own proof. Non-enumerable
 *  so it stays off `Object.keys`/spread/JSON — the internals never leak. */
const ASSEMBLED_INTERNALS = Symbol.for("@inhuman.tools/arrival/assembled-ambient-internals");

/** Stamp the internals onto a freshly-assembled ambient (called by `assembleAmbient`'s builder). */
export function brandAssembledAmbient(ambient: AssembledAmbient, base: AmbientRuntime, lowered: readonly LoweredPack[]): void {
  Object.defineProperty(ambient, ASSEMBLED_INTERNALS, {
    value: { base, lowered } satisfies AmbientInternals,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

/** The base env behind an ambient — exec's own seam (`Capabilities.assembled(base)`,
 *  the shadow classifier). Throws a teaching door for a hand-rolled object: the phase-2
 *  product is minted by `assembleAmbient`, not duck-typed. */
export function ambientBase(ambient: AssembledAmbient): AmbientRuntime {
  // `Reflect.get` returns `any` — assigned to the typed local without a cast; the door below
  // rejects a hand-rolled object that never carried the branded internals.
  const found: AmbientInternals | undefined = Reflect.get(ambient, ASSEMBLED_INTERNALS);
  if (found === undefined) {
    throw new AmbientShapeError(
      "exec",
      "`ambient` must be a product of assembleAmbient() (or ExecState.ambient) — " +
        "a hand-rolled object satisfying the shape carries no assembled base to resolve through",
    );
  }
  return found.base;
}

/** Every lowered pack in an assembly's closure (roots + deps, identity-deduped) that
 *  carries the resource lifecycle — the wind-down walk for phase 5. */
function loweredClosure(roots: readonly LoweredPack[]): LoweredPack[] {
  const seen = new Set<object>();
  const out: LoweredPack[] = [];
  const visit = (pack: LoweredPack): void => {
    if (seen.has(pack)) return;
    seen.add(pack);
    for (const dep of pack.deps ?? []) {
      // A capability's deps are themselves capability-lowered (lower() recurses);
      // a plain kernel pack has no windDown and is skipped structurally.
      if (typeof (dep as Partial<LoweredPack>).windDown === "function") visit(dep as LoweredPack);
    }
    out.push(pack);
  };
  for (const r of roots) visit(r);
  return out;
}

/** Construct the phase-2 product from an assembly's parts. Internal to the package —
 *  `assembleAmbient` (generator-exec) is the public mint. `disposable: false` marks the
 *  realm-default ambient (dispose = documented no-op; realm-scoped by design). */
export function makeAssembledAmbient(args: {
  base: AmbientRuntime;
  capabilities: readonly EnvCapability[];
  assembled: AssembledEnv<SchemeEnv>;
  lowered: readonly LoweredPack[];
  chain: CompiledResolutionChain;
  heapBudget?: number;
  disposable: boolean;
}): AssembledAmbient {
  const { base, capabilities, assembled, lowered, chain, heapBudget, disposable } = args;
  let namesMemo: ReadonlySet<string | symbol> | undefined;
  // Single-flight, idempotent dispose — `await using` callers and exec's `finally` can
  // race/double-call without double teardown.
  let disposed: Promise<void> | undefined;
  const dispose = (): Promise<void> =>
    (disposed ??= (async () => {
      if (!disposable) return; // the realm default — never torn down, by design
      await assembled.dispose(); // kernel pack disposers, LIFO
      // Resource wind-down over the whole lowered closure (roots + deps): windDown is
      // PAUSE semantics (a later touch re-spawns), so this is safe even if the ambient
      // object is inspected afterward — but post-dispose reuse is off-contract.
      for (const pack of loweredClosure(lowered)) await pack.windDown();
    })());

  const ambient: AssembledAmbient = {
    capabilities,
    ready: Promise.resolve(assembled),
    chain,
    degraded: assembled.degraded,
    activations: assembled.activations,
    heapBudget,
    dispose,
    [Symbol.asyncDispose]: dispose,
    lookup: (name) => chain.lookup(name),
    names: () => (namesMemo ??= chain.names),
    describeSymbol: async (name) => {
      const entry = rosterEntries(capabilities).get(name);
      if (entry === undefined) return undefined;
      return describeEntry(name, entry, assembled.activations);
    },
    catalog: async () => {
      const out: SymbolDescription[] = [];
      for (const [name, entry] of rosterEntries(capabilities)) {
        out.push(await describeEntry(name, entry, assembled.activations));
      }
      return out;
    },
  };
  brandAssembledAmbient(ambient, base, lowered);
  return ambient;
}

// ── The roster walk behind describeSymbol/catalog ────────────────────────────────────
//
// A capability's baked declarations are enumerated from its SPEC (record-form `symbols`,
// prefix applied); a BUILDER-form `symbols` is computed against the assembly's own
// activation (`activations`; the builder's type contract is activation-only and pure, so a
// describe-time re-invocation reads the same record `lower()` computed). Legacy-form entries
// (bare fn / rosetta-config / `{value}`) carry no `kind` and are skipped — they describe
// through their own transport channel (arrival-mcp's annotation lift) until the legacy arm retires.

interface RosterEntry {
  readonly capability: string;
  readonly def: AEntity;
}

const isBakedEntity = (def: SymbolDeclaration): def is AEntity =>
  typeof def === "object" && def !== null && "kind" in def && typeof (def as { kind: unknown }).kind === "string";

/** Deps-first / self-last walk (matching C3 apply precedence): a nearer capability's
 *  entry OVERWRITES a dep's on a name clash — same last-write-wins the assembly binds. */
function rosterEntries(capabilities: readonly EnvCapability[]): Map<string, RosterEntry> {
  const out = new Map<string, RosterEntry>();
  const seen = new Set<EnvCapability>();
  const visit = (cap: EnvCapability): void => {
    if (seen.has(cap)) return;
    seen.add(cap);
    for (const dep of cap.spec.deps ?? []) visit(dep);
    const symbols = cap.spec.symbols;
    if (symbols === undefined || typeof symbols === "function") {
      // Builder form: enumerable only through the lowered activation — handled by the
      // describe layer via `activations`; without a spec-level record there is nothing
      // static to walk here. (The hermetic-symbols Phase B retires the builder form;
      // until then a builder-armed capability's verbs are absent from the catalog —
      // the same LIMIT `EnvCapability.exports()` documents.)
      return;
    }
    const prefix = cap.spec.symbolPrefix ?? "";
    for (const [name, def] of Object.entries(symbols)) {
      if (isBakedEntity(def)) out.set(prefix + name, { capability: cap.name, def });
    }
  };
  for (const cap of capabilities) visit(cap);
  return out;
}

async function describeEntry(
  name: string,
  entry: RosterEntry,
  activations: ReadonlyMap<string, Activation<any, any>>,
): Promise<SymbolDescription> {
  const { def } = entry;
  const activation = activations.get(entry.capability);
  // With an activation: full per-read resolution (lazily, per read, no memo). Without one
  // (an ambient assembled before/without this capability's lowering — shouldn't happen for a
  // roster capability, but stay honest): static subset only.
  const { resolved, dynamicKeys } =
    activation !== undefined
      ? await resolveMetadata(def.metadata, activation)
      : { resolved: staticMetadata(def.metadata), dynamicKeys: [] as readonly string[] };
  return {
    name,
    kind: def.kind,
    capability: entry.capability,
    doc: "doc" in def ? def.doc : undefined,
    type: "type" in def ? def.type : undefined,
    provenance: "provenance" in def ? def.provenance : undefined,
    preludeOnly: "preludeOnly" in def ? def.preludeOnly : undefined,
    metadata: resolved,
    dynamicKeys,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2.5 — the pure passes over (program, ambient)
// ─────────────────────────────────────────────────────────────────────────────

/** Static validation as a callable phase-boundary op: parsed forms × the ambient's sealed
 *  chain (+ the session scope's names) → the COMPLETE Diagnostic list, ZERO side effects
 *  fired — validation without executing. exec's `staticValidation: "on"` path calls exactly
 *  this and throws on error-tier. */
export function validateAgainstAmbient(
  program: ParsedProgram,
  ambient: AssembledAmbient,
  scope?: LexicalScope,
): readonly Diagnostic[] {
  const scopeEnv = scope?.env;
  const vocabulary = vocabularyFromChain(ambient.chain, {
    scopeNames: scopeEnv?.allBoundNames(),
    scopeLookup: scopeEnv === undefined ? undefined : (name) => scopeEnv.get(name, { throwError: false }),
    degraded: ambient.degraded,
  });
  return validateProgram(program.forms, vocabulary);
}

/** Shadow classification as a phase-2.5 op: one static lineage skeleton per form, built
 *  against the POST-AUGMENTATION base. A `{ capabilities }` run's capability-declared
 *  provenance roles are then visible by construction — the only base that exists to hand the
 *  classifier is the augmented one. */
export function classifyProgram(program: ParsedProgram, baseEnv: AmbientRuntime): LineageNode[] {
  const classifier = classifierFromEnv(baseEnv);
  return program.forms.map((form) => classify(form, classifier));
}

/** The ambient-native classifier door: `classifierFromEnv` over an ambient's
 *  post-augmentation base, without exposing the base frame. External consumers that
 *  classified against a held instance env (`classifierFromEnv(sandboxedEnv, …)`)
 *  assemble/hold an ambient and read the classifier here. */
export function classifierFromAmbient(ambient: AssembledAmbient): ReturnType<typeof classifierFromEnv> {
  return classifierFromEnv(ambientBase(ambient));
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — ExecInstance
// ─────────────────────────────────────────────────────────────────────────────

/** Phase 3 — one run's armament. Cheap, per-exec: the ambient is shared; scope is
 *  caller-passed (REPL continuity) or obtained; ONLY `runCtx` is always fresh (per-run) — the
 *  per-run home of docs/execution.md §HERMETIC. */
export interface ExecInstance {
  readonly ambient: AssembledAmbient;
  readonly scope: LexicalScope;
  readonly runCtx: RunContext;
  readonly resolver: Resolver;
}

/** Phase 3, callable: "instantiate" = OBTAIN, not necessarily mint — the caller supplies
 *  the scope (exec's default path passes its realm-cached accumulating root; a REPL
 *  session passes its own); the run context is minted fresh UNLESS the caller supplies
 *  `runCtx` (a REPL session reusing the ONE RunContext it spawned for its whole session,
 *  the Stage-2 capability-resource lifetime rides — docs/execution.md §HERMETIC). `heapBudget`
 *  resolves per-run option → ambient policy → unbounded, and is IGNORED when `runCtx` is
 *  reused (a reused RunContext already carries its own meter — re-deriving one here would
 *  silently fork the budget mid-session). */
export function instantiate(
  ambient: AssembledAmbient,
  opts: {
    scope: LexicalScope;
    strict?: boolean;
    heapBudget?: number;
    freezeRosettaReturns?: boolean;
    signal?: AbortSignal;
    cache?: RunCache;
    effects?: EffectLog;
    reads?: ReadGuard;
    notes?: NoteSink;
    display?: DisplaySink;
    /** Reuse an existing RunContext (REPL continuity) instead of minting a fresh one — see
     *  `ExecOptions.runCtx` (generator-exec.ts) for the full contract and ownership rule. */
    runCtx?: RunContext;
  },
): ExecInstance {
  const runCtx =
    opts.runCtx ??
    makeRunContext({
      strict: opts.strict ?? false,
      heapBudget: opts.heapBudget ?? ambient.heapBudget,
      freezeRosettaReturns: opts.freezeRosettaReturns,
      signal: opts.signal,
      cache: opts.cache,
      effects: opts.effects,
      reads: opts.reads,
      // The AMBIENT path mints its runCtx HERE, not in generator-exec's `env` branch — the branch
      // every real session takes (the MCP runner passes `ambient`). `notes`/`display` must ride it
      // or the model-facing channels arrive empty on the ambient path.
      notes: opts.notes,
      display: opts.display,
    });
  const resolver = new Resolver(opts.scope.env, Capabilities.assembled(ambientBase(ambient)));
  return { ambient, scope: resolver.scope, runCtx, resolver };
}
