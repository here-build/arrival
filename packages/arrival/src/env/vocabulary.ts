// vocabulary.ts — Stage B1 (docs/plans/stage-b-runcontext-absorbs-assembly.md): the VOCABULARY
// artifact. `buildVocabulary` walks a capability-set + shared config bag ONCE, deps-first (C3),
// minting every symbol via the SAME per-kind bind dispatch `common/capability.ts`'s now-retired
// `lower().apply()` used to run (Stage C Cut 4 moved that bind loop here, as `processCapability`
// below — byte-equivalent dispatch, reusing capability.ts's exported helpers: `contractOf`,
// `missingRequiresConfig`/`requiresConfigNeeds`/`requiresConfigReason`,
// `collectRequiresConfigDegraded`/`mergeDegraded`, the alias/declarative/native/rosetta/door/
// keyword/value per-kind dispatch, `associateCapability`, `bindCapabilityDefines`'s Pass-2 bake)
// — but writes into a plain, freezable `Map` artifact instead of binding onto a live env frame.
//
// WHY A LIVE SCRATCH FRAME STILL EXISTS (`bakeEnv`, below): `bindCapabilityDefines` (Pass 2)
// evaluates REAL scheme source (`evalScheme(scope, "(define tmp <body>)")`) and reads the result
// back via `scope.get(tempName)` — an actual interpreter round-trip, not a pure computation, and
// the classifier it runs (`env.get(op, {throwError:false})`) reads whatever's ALREADY bound.
//
// STAGE C CUT 2 — SELF-CONTAINED, NOT `user_env`-parented: `bakeEnv` is a NULL-ROOTED scratch
// frame (`mintResolvingFrame`, no parent) — it resolves against THIS BUILD's own static core, not
// the legacy realm base. This is safe because the caller now folds `BASE_ROSTER` (env/base-
// roster.ts) into `capabilities` BEFORE calling `buildVocabulary` (see `generator-exec.ts`'s
// `execStateViaVocabulary`): the base stdlib is an ordinary member of THIS tuple's own C3 closure,
// baked deps-first in the SAME loop below, so by the time a dependent capability's `symbol.define`
// bakes, every name it may reference — its own declared `deps`, OR a base-roster name available
// "for free" (define-bake.ts's `KEYWORD_SYNTAX_BASELINE` allowlist) — is ALREADY a direct
// binding on `bakeEnv` (mirrored in by every earlier capability's own Pass 1 + Pass 2, below).
// Nothing about a live parent-chain fallback is needed or wanted: the cornerstone (ambient ≠
// lexical/global scope) forbids parenting this bake artifact on `user_env` at all — `bakeEnv`
// mirrors every bind (Pass 1 AND Pass 2) into it AS WELL AS into the Vocabulary's own maps, so
// scheme evaluation sees exactly what THIS tuple's own C3 walk has bound by this point — then
// discards the scratch frame once the build finishes (nothing about it survives; the Vocabulary
// maps are the only artifact).
//
// MEMO: keyed on the FULL transitive closure (deps included, not just the caller's root list) —
// two calls whose closures land on the same capability OBJECTS (regardless of root-list order or
// whether a dep was listed explicitly) hit the SAME cached build. Nested `WeakMap`s, one level per
// capability in the closure's OWN-NAME-sorted order (a canonical, order-insensitive path — sorting
// is safe because the closure walk itself already rejects two DIFFERENT objects sharing a name),
// terminated by a `WeakMap` keyed on the shared config object's IDENTITY (a documented default —
// see the design draft's "resolved questions" — a fresh-but-deep-equal config bag simply builds an
// unshared second Vocabulary, never wrongly shares one). The memo stores the in-flight PROMISE, not
// the settled value, so concurrent callers of the same tuple await the SAME build.
//
// LEGACY `{ fn }` CAPABILITIES (McpEnvCapability's authoring shape) are OUT OF SCOPE for this
// artifact — refused outright (see `VocabularyLegacyCapabilityError`, below); callers decide
// whether a given capability set is vocabulary-eligible BEFORE calling this. (Stage C Cut 4:
// there is no other home for a `{ fn }` capability anymore — `lower()`/`assembleEnv` are both
// retired — so a legacy capability reaching here has nowhere production-sanctioned left to go
// until the postponed MCP rework gives it one.)

import { z } from "zod";
import invariant from "tiny-invariant";

import {
  EnvCapability,
  contractOf,
  isAliasDef,
  isDeclarativeDef,
  isSymbolSpec,
  missingRequiresConfig,
  requiresConfigNeeds,
  requiresConfigReason,
  collectRequiresConfigDegraded,
  mergeDegraded,
  type SymbolDeclaration,
} from "../common/capability.js";
import { buildDegradationInfo, collectDegraded, type DegradedCapability } from "../common/degradation.js";
import { bindCapabilityDefines } from "../common/symbols/define-bake.js";
import type {
  AEntity,
  DefineSymbolDef,
  DefineSyntaxSymbolDef,
  NativeSymbolDef,
  RosettaSymbolDef,
  SequenceSymbolDef,
  TaglessGuardSymbolDef,
  TaglessSymbolDef,
} from "../common/symbol.js";
import type { AliasSymbolDef } from "../common/symbols/alias.js";
import type { PreludeBindTarget } from "../common/kernel.js";
import { linearizeDag } from "../common/dag-linearize.js";
import type { EvalSchemeInto } from "../common/scheme-env.js";
import { associateCapability } from "../run/CallCtx.js";
import { AKernelKeyword } from "../values/AKernelKeyword.js";
import { ANativeProcedure, ARosettaProcedure, DoorProcedure } from "../values/primitives/ACallable.js";
import {
  AliasTargetError,
  AssembleCycleError,
  AssembleLinearizationError,
  SymbolKeyMismatchError,
  VocabularyCapabilityConflictError,
  VocabularyLegacyCapabilityError,
} from "../errors.js";
import { bindValue, mintResolvingFrame, type AmbientValue, type ResolvingAmbient } from "./AmbientRuntime.js";

/** One symbol vocabulary, built ONCE per (capability-set, config) tuple — see the module
 *  header. Every content is either an immutable minted value or a baked closure over the
 *  frozen `map`/`preludeOnly` — the FV-law sharing proof (define-bake.ts) — so the WHOLE
 *  artifact is safe to share, by reference, across every `RunContext` built from this tuple. */
export interface Vocabulary {
  /** The runtime vocabulary — every non-preludeOnly bound name, C3 last-write-wins. */
  readonly map: ReadonlyMap<string, AmbientValue>;
  /** Assembly-time-only names (docs/environments.md §PRELUDE) — resolvable from a capability's
   *  OWN prelude text, never from the runtime map. Populated here (B1); read by `env/assemble-run
   *  .ts`'s per-run prelude pass (B2), which overlays this map onto the prelude scope ALONGSIDE
   *  the main map — never onto the user-facing resolution chain. */
  readonly preludeOnly: ReadonlyMap<string, AmbientValue>;
  /** Every capability that lowered degraded, C3 order (root-first) — the same fold order the
   *  retired `AssembledEnv.degraded` (kernel.ts, pre Stage-C-Cut-4) used to build. */
  readonly degraded: readonly DegradedCapability[];
  /** Every `.spec.prelude` in this tuple's closure, DEPS-FIRST (matches `collectPrelude`'s own
   *  order), deduped by capability IDENTITY (a diamond DAG contributes its prelude once) —
   *  COLLECTED here (B1); EXECUTED per-run by `env/assemble-run.ts`'s `assembleRun` (B2), whose
   *  single pass over this already-deduped array IS the single-execution-per-run law — see that
   *  module's own doc. */
  readonly preludes: readonly { readonly capability: EnvCapability; readonly text: string }[];
  /** This tuple's validated per-capability configuration — capability OBJECT → its
   *  `configuration` bag, feeding `RunContext.capabilityConfigurations` directly
   *  (`env/assemble-run.ts`'s `assembleRun` — the retired ambient-path table this replaced
   *  used to build the same shape from an `AssembledEnv`, pre Stage-C Cut 3b). */
  readonly configsByCapability: ReadonlyMap<object, unknown>;
}

// ── The memo — nested WeakMap by (closure, sorted by name) → config identity ────────────────
//
// See the module header for the full rationale. `MemoNode` is a plain internal tree; nothing
// here is exported — `buildVocabulary` is the only door.
interface MemoNode {
  readonly children: WeakMap<EnvCapability, MemoNode>;
  readonly byConfig: WeakMap<object, Promise<Vocabulary>>;
}
const freshNode = (): MemoNode => ({ children: new WeakMap(), byConfig: new WeakMap() });
const rootMemo: MemoNode = freshNode();
/** WeakMap keys must be objects — this stands in for `config === undefined` in the terminal
 *  `byConfig` map (a fixed, never-collected sentinel; a real config bag can never equal it by
 *  reference). */
const NO_CONFIG_SENTINEL: object = {};

/** Locale-independent, code-unit-wise comparator — same rationale as
 *  `CompiledResolutionChain.ts`'s `byCodeUnit`: the memo path must be deterministic across
 *  realms/locales, and capability names are never equal here (the closure walk itself rejects
 *  two distinct objects sharing a name — see `onRevisit` below), so this is a total order. */
function byName(a: EnvCapability, b: EnvCapability): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

function memoized(
  sortedClosure: readonly EnvCapability[],
  config: object | undefined,
  build: () => Promise<Vocabulary>,
): Promise<Vocabulary> {
  let node = rootMemo;
  for (const cap of sortedClosure) {
    let child = node.children.get(cap);
    if (child === undefined) {
      child = freshNode();
      node.children.set(cap, child);
    }
    node = child;
  }
  const key = config ?? NO_CONFIG_SENTINEL;
  let promise = node.byConfig.get(key);
  if (promise === undefined) {
    promise = build();
    node.byConfig.set(key, promise);
  }
  return promise;
}

// ── The map-backed `PreludeBindTarget` — mirrors EVERY bind into `bakeEnv` too (see the module
// header's "why a live scratch frame still exists"). ──────────────────────────────────────────
function makeBindTarget(
  mainMap: Map<string, AmbientValue>,
  preludeOnlyMap: Map<string, AmbientValue>,
  bakeEnv: ResolvingAmbient,
): (def: AEntity) => PreludeBindTarget {
  return (def) => ({
    set: (name: string, value: unknown) => {
      bindValue(bakeEnv, name, value as AmbientValue);
      // Read back the STORED (possibly `fromJS`-wrapped) value — the same raw `__env__` read
      // `compileResolutionChain` itself does, not the read-time `.get()` (which quotes a stored
      // APair for host consumption; the vocabulary map must hold what a chain lookup would).
      const stored = bakeEnv.__env__[name];
      const target = "preludeOnly" in def && def.preludeOnly ? preludeOnlyMap : mainMap;
      target.set(name, stored);
      return stored;
    },
  });
}

/** Bind directly into both the main map and `bakeEnv` — the two kinds capability.ts's own apply
 *  loop binds WITHOUT routing through `bindTarget` (kernel keywords, `symbol.value`'s tail
 *  case) — see that file's per-kind dispatch for why. */
function bindDirect(mainMap: Map<string, AmbientValue>, bakeEnv: ResolvingAmbient, name: string, value: unknown): void {
  bindValue(bakeEnv, name, value as AmbientValue);
  mainMap.set(name, bakeEnv.__env__[name]);
}

/** Process ONE capability's `symbols` record into the shared maps — Pass 1 (every non-define
 *  kind) then Pass 2 (`bindCapabilityDefines`'s define/defineSyntax bake), byte-equivalent
 *  dispatch to `common/capability.ts`'s retired `lower().apply()` per-kind loop (Stage C Cut 4
 *  moved the bind loop here), reusing its exported
 *  helpers (see the module header). Returns this capability's own merged degraded entry, if
 *  any. */
async function processCapability(
  cap: EnvCapability,
  config: object | undefined,
  mainMap: Map<string, AmbientValue>,
  preludeOnlyMap: Map<string, AmbientValue>,
  bakeEnv: ResolvingAmbient,
  evalScheme: EvalSchemeInto,
): Promise<{ configuration: Record<string, unknown>; degraded: DegradedCapability | undefined }> {
  const capabilityName = cap.name;
  const spec = cap.spec;
  const symbolsRec = (spec.symbols ?? {}) as Record<string, SymbolDeclaration>;

  // Deliverable 5 — legacy `{ fn }` capabilities never reach the vocabulary path.
  for (const [verb, rawDef] of Object.entries(symbolsRec)) {
    if (isSymbolSpec(rawDef)) throw new VocabularyLegacyCapabilityError(capabilityName, verb);
  }

  const schema = spec.configuration ? z.object(spec.configuration as Record<string, z.ZodTypeAny>) : z.object({});
  const configuration = schema.parse(config ?? {}) as Record<string, unknown>;
  // The requiresConfig auto-door below fires unconditionally (D2, common/degradation.ts) — no
  // mode gate, no missing-keys tally to thread in (the retired "forbid"/"doors" MODE and its
  // informational `missingKeys`/`active` fields died with the Tier 1 trails cleanup: zero readers).
  const degradation = buildDegradationInfo(capabilityName);

  const bind = makeBindTarget(mainMap, preludeOnlyMap, bakeEnv);
  const defineEntries: [string, DefineSymbolDef | DefineSyntaxSymbolDef][] = [];
  const ownNames = new Set<string>();

  for (const [name, rawDef] of Object.entries(symbolsRec)) {
    ownNames.add(name);

    // symbol.alias dissolution — same substitute-then-fall-through as capability.ts's loop.
    let def: SymbolDeclaration = rawDef;
    const viaAlias = isAliasDef(rawDef);
    if (viaAlias) {
      const targetDef = symbolsRec[(rawDef as AliasSymbolDef).target];
      if (targetDef === undefined) {
        throw new AliasTargetError(capabilityName, name, (rawDef as AliasSymbolDef).target, "missing-target");
      }
      if (isAliasDef(targetDef)) {
        throw new AliasTargetError(capabilityName, name, (rawDef as AliasSymbolDef).target, "chained-alias");
      }
      def = targetDef;
    }

    if (isDeclarativeDef(def)) {
      if (def.kind === "define" || def.kind === "define-syntax") {
        defineEntries.push([name, def]);
        continue;
      }
      // "macro": bind the raw transformer as-is (routes through `bind` for preludeOnly).
      bind(def).set(name, def.macro);
      continue;
    }

    if (def instanceof ANativeProcedure) {
      const contract = def.contract as NativeSymbolDef | SequenceSymbolDef | TaglessSymbolDef | TaglessGuardSymbolDef;
      if (!viaAlias && contract.name !== name) throw new SymbolKeyMismatchError(capabilityName, name, contract.name);
      if (contract.kind === "native") {
        const missingNative = missingRequiresConfig(contract.requiresConfig, configuration);
        if (missingNative !== undefined) {
          bind(contract).set(
            name,
            new DoorProcedure(
              degradation.door(name, requiresConfigNeeds(missingNative), requiresConfigReason(missingNative, contract.doc)),
            ),
          );
          continue;
        }
        associateCapability(def, cap, cap.nativeReadsRunResources());
        bind(contract).set(name, def);
        continue;
      }
      associateCapability(def, cap, cap.producesRunResources());
      bind(contract).set(name, def);
      continue;
    }

    if (def instanceof ARosettaProcedure) {
      const contract = def.contract as RosettaSymbolDef;
      if (!viaAlias && contract.name !== name) throw new SymbolKeyMismatchError(capabilityName, name, contract.name);
      const missingRosetta = missingRequiresConfig(contract.requiresConfig, configuration);
      if (missingRosetta !== undefined) {
        bind(contract).set(
          name,
          new DoorProcedure(
            degradation.door(name, requiresConfigNeeds(missingRosetta), requiresConfigReason(missingRosetta, contract.doc)),
          ),
        );
        continue;
      }
      associateCapability(def, cap, cap.producesRunResources());
      bind(contract).set(name, def);
      continue;
    }

    if (def instanceof DoorProcedure) {
      if (!viaAlias && def.door.name !== name) throw new SymbolKeyMismatchError(capabilityName, name, def.door.name);
      if (def.door.cause === undefined) {
        (def.door as { cause?: { owner: string; needs: readonly never[] } }).cause = { owner: capabilityName, needs: [] };
      }
      bind(def.door).set(name, def);
      continue;
    }

    if (def instanceof AKernelKeyword) {
      if (!viaAlias && def.name !== name) throw new SymbolKeyMismatchError(capabilityName, name, def.name);
      bindDirect(mainMap, bakeEnv, name, def);
      continue;
    }

    // Retirement door (bare-Fn arm) — see capability.ts's own identical guard; unreachable for
    // a type-checked capability (legacy `{fn}` records already refused above).
    invariant(
      typeof def !== "function",
      `EnvCapability "${capabilityName}": symbol "${name}" is a bare function — the bare-Fn authoring arm is retired.`,
    );

    // `symbol.value` — the one remaining minted shape, bound directly (never via `bind`).
    const valueEntity = contractOf(def);
    if (!viaAlias && valueEntity !== undefined && valueEntity.name !== name) {
      throw new SymbolKeyMismatchError(capabilityName, name, valueEntity.name);
    }
    bindDirect(mainMap, bakeEnv, name, def as AmbientValue);
  }

  if (defineEntries.length > 0) {
    await bindCapabilityDefines({
      capabilityName,
      ownNames,
      entries: defineEntries,
      deps: spec.deps ?? [],
      env: bakeEnv,
      scope: bakeEnv,
      bindTarget: bind,
      evalScheme,
    });
  }

  const degraded = mergeDegraded(
    collectDegraded(capabilityName, symbolsRec),
    collectRequiresConfigDegraded(capabilityName, symbolsRec, configuration),
  );

  return { configuration, degraded };
}

/** Build (or reuse the memoized) {@link Vocabulary} for `capabilities` armed with `config`.
 *  See the module header for the full model: C3 walk deps-first (self overwrites dep), a
 *  scratch live frame mirrors every bind so `symbol.define`'s Pass-2 bake evaluates against
 *  the SAME visibility a live `lower().apply()` would see, and the result is frozen + memoized
 *  by (closure identity, config identity). */
export async function buildVocabulary(
  capabilities: readonly EnvCapability[],
  config: object | undefined,
  evalScheme: EvalSchemeInto,
): Promise<Vocabulary> {
  const { order, byName: closureByName } = linearizeDag(capabilities, {
    onRevisit: (existing, candidate) => {
      if (existing !== candidate) throw new VocabularyCapabilityConflictError(candidate.name);
    },
    onCycle: (path) => {
      throw new AssembleCycleError(path);
    },
    onInconsistent: (owner) => {
      throw new AssembleLinearizationError(owner);
    },
  });

  const sortedClosure = [...closureByName.values()].sort(byName);
  return memoized(sortedClosure, config, () => buildFresh(order, closureByName, config, evalScheme));
}

async function buildFresh(
  order: readonly string[],
  byNameMap: ReadonlyMap<string, EnvCapability>,
  config: object | undefined,
  evalScheme: EvalSchemeInto,
): Promise<Vocabulary> {
  const mainMap = new Map<string, AmbientValue>();
  const preludeOnlyMap = new Map<string, AmbientValue>();
  const configsByCapability = new Map<object, unknown>();
  const degradedByName = new Map<string, DegradedCapability | undefined>();
  const preludes: { capability: EnvCapability; text: string }[] = [];
  // The scratch bake frame — see the module header. NULL-ROOTED (Stage C Cut 2): a capability's
  // scheme bodies (`symbol.define`, preludes) resolve against THIS build's own static core (every
  // earlier-processed capability in the SAME deps-first loop below, base roster included when the
  // caller folds it in), never a parent-chain fallback onto `user_env`. Discarded once this build
  // finishes; nothing about it survives.
  const bakeEnv: ResolvingAmbient = mintResolvingFrame("vocabulary-bake");

  // Deps-first (self overwrites dep) — mirrors `assembleEnv`'s own `order.toReversed()` apply
  // walk; each capability is processed FULLY (Pass 1 + Pass 2) before the next, so a dependent's
  // define bodies can reference a dep's already-baked defines.
  for (const name of [...order].reverse()) {
    const cap = byNameMap.get(name)!;
    const { configuration, degraded } = await processCapability(cap, config, mainMap, preludeOnlyMap, bakeEnv, evalScheme);
    configsByCapability.set(cap, configuration);
    degradedByName.set(name, degraded);
    if (cap.spec.prelude !== undefined) preludes.push({ capability: cap, text: cap.spec.prelude });
  }

  // Degraded fold order = C3 `order` itself (root-first) — matches the retired
  // `AssembledEnv.degraded`'s own fold in kernel.ts (pre Stage-C Cut 3b), NOT the
  // deps-first apply walk above.
  const degraded: DegradedCapability[] = [];
  for (const name of order) {
    const d = degradedByName.get(name);
    if (d !== undefined) degraded.push(d);
  }

  return Object.freeze({
    map: mainMap,
    preludeOnly: preludeOnlyMap,
    degraded,
    preludes,
    configsByCapability,
  });
}
