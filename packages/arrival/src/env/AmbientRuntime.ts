import { type ResolverSpec, type SchemeEnv } from "../common/scheme-env.js";
import type { EOF } from "../values/primitives/EOF.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import type { Macro } from "../eval/Macro.js";
import type { AProcedure, SchemeValue } from "../values/types.js";
import { createRosettaWrapper, type RosettaFunction } from "../membrane/rosetta.js";
import type { Syntax } from "../eval/Syntax.js";
import invariant from "tiny-invariant";
import { fromJS, isSchemeValue } from "../membrane/membrane.js";
import { quote } from "../values/values-repr.js";
import { APair } from "../values/primitives/APair.js";
import type { RunContext } from "../run/RunContext.js";
import { rosettaTypesOf } from "./env-registries.js";
import { unboundVariableError } from "../unbound-variable.js";
import { RawCrossingError } from "../errors.js";
import { INTEROP_BOUNDARY } from "../membrane/interop-access.js";

// -------------------------------------------------------------------------
// :: Type definitions for AmbientRuntime bindings
// -------------------------------------------------------------------------

/** A name usable to look up values in an environment: string, symbol, ASymbol, or AString. */
export type BindingName = string | symbol | ASymbol | AString;

/** Anything storable in an environment: SchemeValues plus runtime types (Macro, Syntax, etc). */
export type AmbientValue = SchemeValue | AProcedure | Macro | Syntax | EOF | AmbientRuntime | RegExp;

// -------------------------------------------------------------------------
// :: Member enumeration — own string keys + own symbols of a binding record,
// :: the leaf helper list() (and allBoundNames through it) builds on.
// -------------------------------------------------------------------------

/** Own string keys + own symbols of a binding record — what list() enumerates. */
function ownProps(obj: object): (string | symbol)[] {
  return [...(Object.keys(obj) as (string | symbol)[]), ...Object.getOwnPropertySymbols(obj)];
}

/**
 * The RAW frame minters — module-internal (deliberately NOT barrel-exported; same
 * discipline as {@link bindValue}), the ONE way a frame is born: the constructor
 * arm is not on the public type. Declared as `let` + assigned inside each
 * class's static block (the only scope a protected constructor is callable from).
 * Production birth goes through {@link mintFrame} (subtype-preserving child) or a
 * null-parent call here (an isolated root); the storage-law tests reach these raws
 * directly to build exact chain shapes (e.g. a PLAIN leaf under a resolving root).
 */
export let mintPlainFrame!: (
  name?: string | symbol,
  bindings?: Record<string | symbol, AmbientValue>,
  parent?: AmbientRuntime | null,
) => AmbientRuntime;
export let mintResolvingFrame!: (
  name?: string | symbol,
  bindings?: Record<string | symbol, AmbientValue>,
  parent?: AmbientRuntime | null,
) => ResolvingAmbient;

/**
 * The low-level lexical FRAME-STORAGE primitive: a `__name__`/`__env__` binding
 * record with a `__parent__` link. One `__parent__`-linked chain is a scope.
 *
 * It is the storage the evaluator's resolution model wraps — NOT the model itself:
 *   - {@link LexicalScope} (eval/LexicalScope.ts) wraps an AmbientRuntime as the
 *     lexical-binding chain (let/lambda/letrec/… frames a program introduces).
 *   - {@link Capabilities} (eval/Capabilities.ts) wraps the assembled base
 *     (builtins/preludes/host resolvers) a run is armed with.
 *   - {@link Resolver} (eval/Resolver.ts) composes the two — `scope.lookup ??
 *     capabilities.lookup` — and is the single object the evaluator threads
 *     (`EvalContext.resolver`). `resolver.env` is the underlying lexical frame.
 *
 * Fallback resolvers live ONLY on {@link ResolvingAmbient} (below); a plain
 * `AmbientRuntime` frame's `_lookupWithResolvers` is own-bindings → parent, no middle
 * leg. Only the baked capability roots (`global_env`/`user_env`, env-roots.ts) ever
 * register resolvers in production, so the let/lambda/letrec frames a program introduces
 * carry no resolver array and pay no empty lookup-miss loop. Polymorphic dispatch still
 * lets a plain lexical frame chaining up to a `ResolvingAmbient` root (`__parent__`-linked)
 * consult that root's resolvers — the walk is correct end-to-end. GLASS mode (a
 * caller-supplied custom env chain) stays resolver-capable at whichever layer was
 * constructed as `ResolvingAmbient`.
 *
 * INTERNAL-ONLY: not on the public surface (see index.ts). Cross-package consumers
 * type against the structural `SchemeEnv` contract (common/scheme-env.ts), never
 * this concrete class — so the name "AmbientRuntime" is an impl detail under the
 * Resolver/LexicalScope/Capabilities model, deliberately NOT renamed to "Scope"
 * (which {@link LexicalScope} owns) or "Frame".
 *
 * MONADIC FROM JS — the HERMETIC-ENVIRONMENT ruling (docs/environments.md §HERMETIC).
 * No public birth surface: no `inherit()`/`merge()` method, no bindings-record/parent
 * constructor arm; frame birth is the module-internal
 * {@link mintFrame}/{@link mintPlainFrame}/{@link mintResolvingFrame} (the same
 * not-barrel-exported discipline as {@link bindValue} — the assembly machinery, the
 * evaluator, and the replay ingress reach them; nothing else does).
 */
export class AmbientRuntime {
  // Interop boundary: AmbientRuntime sits outside the AValue/ArrivalError families
  // the FAMILY RULEs in interop-access.ts cover, so it carries its own explicit
  // stamp (inherited by ResolvingAmbient through ordinary static inheritance).
  static [INTEROP_BOUNDARY] = true;
  // Module-dup-robust brand for `isAmbientRuntime` below — a plain STRING key
  // (not a `Symbol.for`/class-identity check), so it survives module duplication
  // (Vite dev serving a module at `?t=<hmr>`/`/@fs`/`.vite/deps` as a DISTINCT
  // module instance makes `instanceof AmbientRuntime` spuriously fail across
  // copies — see `isAmbientRuntime`'s own doc comment).
  static ["arrival/is-environment"] = true;

  protected constructor(
    // `string | symbol`: a merge-frame's identity IS `Symbol.for("merge")`
    // (Syntax.__merge_env__), and LexicalScope.kind compares it by symbol-IDENTITY
    // — coercing to string would break hygiene. Display sites (toString, the
    // Resolver/Capabilities reprs, the StackFrame name) wrap it in `String(...)`.
    public __name__: string | symbol = "anonymous",
    public __env__: Record<string | symbol, AmbientValue> = {},
    public __parent__: AmbientRuntime | null = null,
  ) {}

  /** The module-internal constructor escape — a static block is the ONE scope a
   *  protected constructor stays callable from, so the raw minter below is captured
   *  here and the class's public type carries no construction arm. */
  static {
    mintPlainFrame = (name, bindings, parent) => new AmbientRuntime(name, bindings, parent);
  }

  list(): (string | symbol)[] {
    return ownProps(this.__env__);
  }

  /**
   * Every name bound anywhere up the `__parent__` chain from this scope, de-duplicated
   * (a name shadowed by a closer layer appears once). Unsorted — the caller imposes any
   * ordering/filtering.
   */
  allBoundNames(): (string | symbol)[] {
    const names = new Set<string | symbol>();
    for (let env: AmbientRuntime | null = this; env; env = env.__parent__) {
      for (const name of env.list()) names.add(name);
    }
    return [...names];
  }

  /**
   * Resolve a name within one env layer before yielding to its parent. Own bindings win
   * over the parent (a closer module shadows a deeper dependency); the resolver leg
   * lives only on {@link ResolvingAmbient}, so a plain frame is own → parent, full stop.
   */
  _lookupWithResolvers(name: string | symbol, ctx?: RunContext): AmbientValue | undefined {
    if (Object.hasOwn(this.__env__, name as string)) {
      return this.__env__[name as string];
    }

    return this.__parent__?._lookupWithResolvers(name, ctx);
  }

  toString(): string {
    return `#<environment:${String(this.__name__)}>`;
  }

  /**
   * The read face — an INVARIANT DOOR: storage is inside the membrane (§HERMETIC),
   * every writer boxes at its own boundary before {@link bindValue}, so a raw JS
   * scalar surfacing on a read means a writer bypassed the membrane (a direct `__env__`
   * poke, a cast-through `mintFrame(parent, name, bindings)` record) — teach and refuse,
   * never silently re-box under the run-neutral ctx.
   *
   * The APair arm survives: a stored pair is cycle-marked + quoted on the way out so a
   * host-read (or hygiene's `lookupSettled` copy) hands back DATA the evaluator won't
   * re-evaluate — read-settling of an already-scheme value, not membrane coercion.
   */
  get(symbol: BindingName, options: { throwError?: boolean; ctx?: RunContext } = {}): AmbientValue | undefined {
    // `:key` keyword accessors aren't special-cased here: a `:`-prefixed symbol is never
    // a binding, so it falls through to `_lookupWithResolvers` where the polyglot
    // capability's `keyword-accessor` resolver (membrane.ts) maps it to the `@`-alias
    // pluck — exactly like the `c[ad]+r` catchall. One catchall path.
    const { throwError = true, ctx } = options;

    let name: string | symbol = symbol as string | symbol;
    if (symbol instanceof ASymbol || symbol instanceof AString) {
      name = symbol.valueOf();
    }

    // Direct lookup for the literal symbol (handles names like %as.data)
    const directValue = this._lookupWithResolvers(name, ctx);
    if (directValue !== undefined) {
      if (directValue instanceof APair) {
        directValue.mark_cycles();
        return quote(directValue);
      }
      assertNotRawInStorage(directValue, name, `environment ${String(this.__name__)}`);
      return directValue;
    }

    if (throwError) {
      // The PLAIN unbound wall + typo suggestions from THIS chain's actual vocabulary
      // (§HERMETIC: no curated name tables — teaching about well-known-but-absent names
      // is declared capability data, the `symbol.notImplemented` doors in env/*-stubs /
      // r7rs/host / srfi-1, resolved by this walk like any binding; see unbound-variable.ts).
      throw unboundVariableError(name.toString(), this.allBoundNames());
    }
    return undefined;
  }

  has(name: string): boolean {
    return Object.hasOwn(this.__env__, name);
  }
}

/**
 * The raw-scalar predicate both storage doors share: the JS leaf types (string/number/
 * bigint/boolean) that must never surface from inside the membrane. Everything else
 * storable is either a scheme value, a sanctioned carve-out (fn/Error — see
 * {@link bindValue}), or a structural runtime type (Macro/Syntax/AmbientRuntime/RegExp/
 * EOF) — none of which are "raw JS crossed unboxed."
 */
function isRawJsScalar(value: unknown): value is string | number | bigint | boolean {
  const t = typeof value;
  return t === "string" || t === "number" || t === "bigint" || t === "boolean";
}

/**
 * INVARIANT DOOR (P5-style — teach, don't ban): a raw JS scalar surfacing from
 * environment storage means some writer bypassed the storage membrane. Values enter
 * the interpreter ONLY as capabilities or overrides (§HERMETIC); inside the membrane
 * every binding is a boxed scheme value. Fires on the READ so the message can name the
 * binding — the fix is always at the WRITER.
 */
function assertNotRawInStorage(value: unknown, name: string | symbol, where: string): void {
  if (isRawJsScalar(value)) throw new RawCrossingError("storage", String(name), typeof value, where);
}

/**
 * The RESOLVER-BOUNDARY door — same predicate, resolver-shaped teaching: a fallback
 * resolver ({@link ResolverSpec}) answers lookups the env did not bind, and its
 * contract is to hand back a BOXED scheme value (minted under the resolving read's
 * `ctx` when one is threaded, run-neutrally when it declares `pure`) or a membrane
 * primitive — never a raw JS scalar for the evaluator to consume contract-free.
 * Shared by the live walk ({@link ResolvingAmbient}) and the sealed chain
 * (eval/CompiledResolutionChain.ts).
 */
export function assertResolvedBinding(value: unknown, name: string | symbol, resolverId: string): void {
  if (isRawJsScalar(value)) throw new RawCrossingError("resolver", String(name), typeof value, resolverId);
}

/**
 * The ONE storage write — module-internal, deliberately NOT barrel-exported and NOT a
 * method (the HERMETIC-ENVIRONMENT ruling, §HERMETIC: no JS-side write surface — no
 * `AmbientRuntime.set` method, no `SchemeEnv.set` contract member, the same cut as the
 * retired `defineRosetta` public method). The writers that legitimately remain are all
 * inside the membrane:
 *
 *   • the EVALUATOR's frame binds — scheme `define`/let/lambda/letrec/catch, called
 *     directly from evaluator.ts (the `Resolver.define`/`LexicalScope.define` methods
 *     left the public types in the monadic-birth ruling);
 *   • CAPABILITY assembly — `common/capability.ts`'s apply (every symbol kind) and
 *     `common/symbols/define-bake.ts`'s Pass-2 binds;
 *   • {@link bindRosetta} below (the retired-`defineRosetta` wiring);
 *   • the REPLAY playback frame (provenance/replay.ts, via bindRosetta).
 *
 * CARVE-OUTS, with their live consumers named:
 *   • `function` — {@link bindRosetta}'s wrapper storage (`createRosettaWrapper`'s
 *     output is a bare scheme-calling-convention fn) and the legacy SymbolDeclaration
 *     arm's activation-bound fns (capability.ts). Quarantined legacy: new callable
 *     kinds bind first-class ANativeProcedures instead.
 *   • `Error` — the evaluator's catch-frame bind of a raised condition object
 *     (evaluator.ts's catch-frame `bindValue(catchResolver.env, varName, errorValue)`): R7RSError extends
 *     the host `Error`, NOT AValue, so `isSchemeValue` misses it — reachable
 *     via any `(guard (e ...) (raise (error ...)))` round-trip.
 *   • the `fromJS` tail — BAKE-TIME boxing for the raw-value authoring arms
 *     (capability.ts's `{ value }` defs, `require`-resolved leaves). Pre-run by
 *     construction (assembly happens before any run exists), so the run-neutral mint
 *     inside `fromJS` is the doc-blessed bootstrap case, not a ctx drop.
 */
export function bindValue(env: AmbientRuntime, name: BindingName, value: AmbientValue): void {
  let storedValue: AmbientValue;

  if (isSchemeValue(value)) {
    storedValue = value;
  } else if (typeof value === "function" || value instanceof Error) {
    // The two carve-outs (see the doc above) — stored verbatim, never fromJS-wrapped.
    storedValue = value;
  } else {
    storedValue = fromJS(value) as AmbientValue;
  }

  let key: string | symbol;
  if (name instanceof ASymbol) {
    key = name.__name__;
  } else if (name instanceof AString) {
    key = name.valueOf();
  } else {
    key = name;
  }
  env.__env__[key as string] = storedValue;
}

/**
 * The BAKED-ROOT specialization of {@link AmbientRuntime} — the only place fallback
 * resolvers live. Only two production producer classes register here (§PRELUDE): the
 * kernel's phase-gated prelude-scope resolver (`common/kernel.ts`'s `assembleEnv`,
 * via the `registerResolver` duck-type probe) and pack-declared
 * `EnvCapability.resolvers` (`common/capability.ts`). Both apply targets are,
 * and must stay, `ResolvingAmbient` instances: `env-roots.ts`'s
 * `global_env`/`user_env`, and any env minted off one of those via the
 * module-internal {@link mintFrame} (e.g. `generator-exec.ts`'s per-call
 * `exec-capabilities` base) — `mintFrame` dispatches on the parent's runtime class,
 * so a capability-augmented base built on top of `user_env` stays resolver-capable
 * without the caller doing anything special.
 *
 * Plain lexical frames (let/lambda/letrec/… — the evaluator's `mintFrame` children,
 * `defaultLexicalRoot`) are deliberately NOT `ResolvingAmbient`: only the baked
 * capability base is "ambient" middleware territory; the lexical chain a program
 * introduces is cut from it. A GLASS caller (custom `{ env }`) that wants a layer
 * of its own chain to answer via resolver must build that layer as a
 * `ResolvingAmbient` explicitly — the current walk otherwise stays unchanged (a
 * resolver-less layer in a glass chain just falls straight through to its parent,
 * same as any other name miss).
 */
export class ResolvingAmbient extends AmbientRuntime implements SchemeEnv {
  private readonly __resolvers__: ResolverSpec[] = [];

  /** The module-internal constructor escape — see the base class's static block. */
  static {
    mintResolvingFrame = (name, bindings, parent) => new ResolvingAmbient(name, bindings, parent);
  }

  /** Register a fallback resolver. Resolvers are tried in order when normal lookup fails. */
  registerResolver(resolver: ResolverSpec): this {
    // Fail LOUD on a malformed resolver — a silent push would only surface later as a
    // "cannot read 'resolve'" crash at lookup time (symptom of a module-eval-time TDZ
    // capture, see polyglot.ts).
    invariant(
      resolver != null && typeof resolver.resolve === "function" && typeof resolver.id === "string",
      "registerResolver: resolver must have a string id and a resolve() function",
    );
    if (!this.__resolvers__.some((r) => r.id === resolver.id)) {
      this.__resolvers__.push(resolver);
    }
    return this;
  }

  /** Remove a registered resolver by id — the kernel's SEAL hook: the bake-scoped
   *  `preludeOnly` overlay registers for the C3 loop's duration and unregisters
   *  here, so no spent machinery survives assembly on any env. No-op for an
   *  unknown id. */
  unregisterResolver(id: string): this {
    const at = this.__resolvers__.findIndex((r) => r.id === id);
    if (at !== -1) this.__resolvers__.splice(at, 1);
    return this;
  }

  /** Seal-time read for the chain compiler (eval/CompiledResolutionChain.ts): the
   *  registered resolver specs in registration (= C3 apply) order. Live view — the
   *  compiler snapshots position at seal; callers must not mutate. */
  resolverSpecs(): readonly ResolverSpec[] {
    return this.__resolvers__;
  }

  /**
   * The full direct-bindings → resolvers → parent precedence contract: a module's
   * explicit binding wins over its own lazy resolver
   * (a pinned override can't be undone by a catch-all fallback in the same layer), and
   * BOTH win over the parent (a closer module shadows a deeper dependency). A resolver
   * returns `undefined` to mean "not mine, keep looking" — never a found nil.
   */
  override _lookupWithResolvers(name: string | symbol, ctx?: RunContext): AmbientValue | undefined {
    if (Object.hasOwn(this.__env__, name as string)) {
      return this.__env__[name as string];
    }

    for (const resolver of this.__resolvers__) {
      const result = resolver.resolve(String(name), ctx);
      if (result !== undefined) {
        // Boxed-at-the-resolver's-boundary contract (§HERMETIC): a raw-scalar answer
        // doors here, at the probe, so BOTH read faces (this live walk and the sealed
        // chain) refuse before raw JS reaches the evaluator.
        assertResolvedBinding(result, name, resolver.id);
        return result as AmbientValue;
      }
    }

    return this.__parent__?._lookupWithResolvers(name, ctx);
  }
}

/**
 * The ONE frame-birth door — module-internal, deliberately NOT barrel-exported and NOT
 * a method (the HERMETIC-ENVIRONMENT ruling extended to birth, §HERMETIC: a public
 * `inherit()`/`merge()` would be capability composition in disguise, so neither exists).
 * Subtype-preserving: a
 * `ResolvingAmbient` parent mints a resolver-capable child (the per-assembly
 * `exec-capabilities` base off `user_env` stays a machinery target), a plain parent
 * mints a plain lexical frame — dispatch on the parent's runtime class, in one place.
 *
 * The live callers, all inside the membrane:
 *   • ROOT LAYERING — `env-roots.ts` (`user_env` off `global_env`) and
 *     `inference-env.ts` (the inference identity boundary);
 *   • ASSEMBLY — `generator-exec.ts`'s per-assembly `exec-capabilities` base (inside
 *     the designed door `assembleAmbient`; the mint is that door's internal step);
 *   • the EVALUATOR's frame chain — `Resolver.child` / the merge frame
 *     (`env/macros/macros.ts`, bindings record shared BY REFERENCE — the merge-frame
 *     contract) / `LexicalScope.child` — the LATTER is also how provenance replay
 *     mints its own per-wire/per-playback frames above `hermetic-env.ts`'s vocabulary
 *     scope (`gamma.ts`'s `applyWireInEnv`, `replay.ts`'s playback frame): Stage C Cut
 *     3 rebuilt hermetic replay over the self-hosted vocabulary path, so those
 *     modules no longer call this function directly — they go through
 *     `LexicalScope.child`, same as any other session-scoped frame birth.
 */
export function mintFrame(
  parent: ResolvingAmbient,
  name?: string | symbol,
  bindings?: Record<string, AmbientValue>,
): ResolvingAmbient;
export function mintFrame(
  parent: AmbientRuntime,
  name?: string | symbol,
  bindings?: Record<string, AmbientValue>,
): AmbientRuntime;
export function mintFrame(
  parent: AmbientRuntime,
  name: string | symbol = `child of ${String(parent.__name__) || "unknown"}`,
  bindings: Record<string, AmbientValue> = {},
): AmbientRuntime {
  return parent instanceof ResolvingAmbient
    ? mintResolvingFrame(name, bindings, parent)
    : mintPlainFrame(name, bindings, parent);
}

/**
 * The retired `AmbientRuntime.prototype.defineRosetta` PUBLIC method's wiring, kept alive
 * ONLY for its two remaining producers: `capability.ts`'s legacy `SymbolDeclaration`
 * bind arm and `replay.ts`'s playback-frame op registration (both still author bare-fn
 * `{ fn, ... }` verbs, never `env.defineRosetta` itself — see the ledger's "defineRosetta
 * legacy arm authoring form" row for why that authoring SHAPE survives while this method
 * doesn't). Module-internal — not barrel-exported, not part of the `SchemeEnv` contract;
 * a new call site is a regression onto the retired public API
 * (env-capability-authoring skill's migration recipes are the way in).
 *
 * `env` is a real `AmbientRuntime` now (the hermetic cut): with `SchemeEnv.set` gone,
 * capability.ts's apply narrows its structural env to the concrete class at the top
 * (an instanceof DOOR, never a cast) before any bind fires, and replay.ts's playback
 * frame always was one — so the old widest-common-shape `{ set }` parameter has no
 * remaining non-AmbientRuntime caller. The wrapper is stored through {@link bindValue}
 * (its `function` carve-out — this is the carve-out's named consumer).
 */
export function bindRosetta(env: AmbientRuntime, name: string, config: RosettaFunction): void {
  const wrapper = createRosettaWrapper(config);
  bindValue(env, name, wrapper);
  // `config.pure` is consumed INSIDE createRosettaWrapper (the runtime mint gate,
  // `mintsPoint = pure !== true`) — no static side-table records it; the
  // static classifier reads the declared `.provenanceRole` off baked bound values
  // instead (provenance/lineage-classifier-from-env.ts). Legacy-registered names
  // carry no role and fall to the classifier's `undefined` default.
  if (config.type !== undefined) rosettaTypesOf(env).set(name, config.type);
}

/**
 * Brand check for a concrete arrival AmbientRuntime — the module-dup-robust replacement for
 * `x instanceof AmbientRuntime`. In the browser (Vite dev serves a module at `?t=<hmr>`,
 * `/@fs`, and `.vite/deps` as DISTINCT module instances) an env built by one copy of the
 * class is NOT `instanceof` another copy's class, so an instanceof guard spuriously
 * rejects a real frame (`AmbientShapeError`). The static `["arrival/is-environment"] = true`
 * marker is keyed by a plain STRING — universal across module copies (unlike class
 * identity, or even a module-local `Symbol`) — and it's inherited by `ResolvingAmbient`
 * through ordinary static-property inheritance, so reading it off the value's
 * constructor recognizes any real frame regardless of which module instance minted it.
 */
export function isAmbientRuntime(value: unknown): value is AmbientRuntime {
  if (typeof value !== "object" || value === null) return false;
  const ctor: unknown = Reflect.get(value, "constructor");
  return typeof ctor === "function" && Reflect.get(ctor, "arrival/is-environment") === true;
}
