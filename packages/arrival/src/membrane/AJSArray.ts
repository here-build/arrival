/**
 * AJSArray — the AValue term that re-presents a borrowed JS array as a vector inside the
 * Scheme value space. It carries the run ctx + provenance and its own tagless-final (vector)
 * algebra; the object sibling AJSObject is a separate term with its own algebra. See the
 * class doc below for the implements-not-extends-AVector cycle rationale.
 *
 * IMPORT CYCLE (benign): `jsToScheme` (rosetta.ts) is a hoisted `export function` declaration
 * whose module statically imports this class — so importing it here closes a runtime import
 * cycle, safe because the wrapper methods call it only at runtime and a hoisted function binding
 * is never in TDZ.
 *
 * INTEROP BOUNDARY: the member-access walk stops at this prototype (before it can reach
 * `source` or the delegated vector) via the arrival-family rule in interop-access.ts —
 * any class carrying the own `[CLASS]` brand is a boundary; no per-class stamp needed.
 */

import { CLASS } from "../well-known-symbols.js";
import { type RunContext } from "../run/RunContext.js";
import { attestDeep, freshIfSingleton, isAttested } from "../values/attestation.js";
import { AValue, EMPTY_PROVENANCE } from "../values/primitives/AValue.js";
import { withInputProvenance } from "../values/op-helpers.js";
import { AVector } from "../values/primitives/AVector.js";
import { printValue } from "../values/print.js";
import { type JSWorldArray, type SchemeValue } from "../values/types.js";
// Runtime import cycle (benign — see header): a hoisted `export function` declaration,
// called only inside wrapper methods at runtime.
import { jsToScheme } from "./rosetta.js";
import { is_promise } from "../eval/guards.js";
import { settleEntry } from "../values/primitives/pending-entry.js";
import { tf } from "../values/tagless-final.js";
import { type ANil, nil } from "../values/primitives/ANil.js";
import { AJSArrayList } from "../values/primitives/APair.js";
import { accessHas, accessKeys, accessMember, NOT_FOUND } from "./interop-access.js";
import { InteropAccessError, strictGate } from "../errors.js";
import { foldMemberName } from "./AJSObject.js";

/** Pending-cell cache for Promise-valued reads off the borrowed source (pending-entry.ts):
 *  number keys are element indices (`vector-ref`), string keys are member names (the
 *  tagless `get` trio) — two read protocols with historically different boxing, so their
 *  cells stay keyed apart even when they alias the same slot. WeakMap, not an instance
 *  field, for the same reasons as AJSObject's `entryCaches` (off the wrapper's own
 *  properties, no tslib `#`-private helper, GC-correct). Only pending reads land here —
 *  the sync read paths stay byte-identical (uncached, as before). */
// `AJSArray<any>`: the store type parameter POLICES THE INBOUND CALL and is not part of the
// value's identity, so a cache keyed on the value accepts every instantiation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pendingCells = new WeakMap<AJSArray<any>, Map<number | string, SchemeValue | Promise<SchemeValue>>>();

/**
 * A borrowed JS array, re-presented as a vector. It is an `AValue` (a sibling of
 * AJSObject) that *implements* the vector algebra — it does NOT inherit
 * `AVector`. Inheriting (`extends AVector`) would force the AVector class to be DEFINED
 * at this module's eval time, closing a module-init cycle
 * (AJSArray.ts → AVector → … → AJSArray.ts → `extends AVector(undefined)`). Implementing
 * by DELEGATION touches AVector only at RUNTIME (`new AVector` inside `vec()`), so the
 * binding need not exist yet when this module loads — the cycle stays benign, exactly
 * like every other function-body op-helpers↔AVector edge.
 *
 * The borrowed `source` boxes through the membrane ON DEMAND (`vec()` materializes once,
 * cached): reading `.length` or crossing back out to JS never copies the whole array. The
 * vector algebra (map / filter / reduce / sort) forwards to that materialized vector —
 * no duplicated logic.
 *
 * The Rosetta translation: a JS array IS an R7RS vector, so the membrane presents it as
 * one — `kind` is "vector". It used to answer car/cdr; a faithful vector has neither, so
 * `(car it)` now throws like `(car #(1 2 3))` — use `(vector->list it)`. `equals` stays
 * reference-identity, matching its opaque-view sibling AJSObject.
 * (`source` is kept as the borrowed reference so rosetta's `schemeToJs` crosses it back
 * out raw without materializing.)
 */
export class AJSArray<S extends readonly unknown[] = readonly unknown[]> extends AValue {
  static [CLASS] = "js-array";
  readonly kind = "vector" as const;

  // The borrowed source materialized into an owned vector — lazy + cached (the delegation
  // target). A plain field, NOT a #-private (the workspace's importHelpers emits a tslib
  // helper for ES #-private slots; AJSObject's entry cache is a module-level WeakMap for
  // the same reason).
  private boxedVec?: AVector;

  /**
   * `source` is typed `JSWorldArray<S>` — the hygiene law, AT THE TYPE LEVEL (values/types.ts).
   *
   * A borrowed store holds JS-WORLD VALUES ONLY: primitives, plain objects/arrays, and
   * reverse-membraned egress proxies (a Proxy over a plain target is not an AValue, so the
   * matryoshka case passes on its own merits — no exception clause needed). A caller that
   * statically holds scheme values (`SchemeValue[]`, `AValue[]`) collapses to `never` here and
   * FAILS TO COMPILE, which is the point: a type catches every violator at once, in tsc, including
   * the ones no test covers, where a runtime throw only catches the path someone happens to run.
   *
   * Why it matters, concretely: `jsToScheme` DEEP-RE-STAMPS an AValue with the provenance it is
   * handed (rosetta.ts's inbound AValue claim) unless that provenance is empty or already identical.
   * So a scheme value buried in a JS store does not merely sit there — the next time the container
   * crosses one of its elements, that element's own lineage is silently overwritten with the
   * container's. It is an unobserved flip that CORRUPTS, not just an untidy one.
   */
  constructor(
    ctx: RunContext,
    readonly source: JSWorldArray<S>,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  ) {
    super(ctx, provenance);
  }

  // Cheap read stays lazy — `.length` (and `(vector-length it)`) never boxes the array.
  get length(): number {
    this.freezeSource();
    return this.source.length;
  }

  // Materialized element array — the vector surface the printer (and asVector) read.
  get __vector__(): readonly SchemeValue[] {
    return this.vec().__vector__;
  }

  // Crosses back OUT to JS as the RAW borrowed source (not the boxed materialization) — the
  // lazy unwrap rosetta's schemeToJs reads off `.source`.
  ["arrival/toJS"](): readonly unknown[] {
    return this.source;
  }

  valueOf(): readonly unknown[] {
    return this.source;
  }

  // Returns the DEFAULT instantiation (`AJSArray<readonly unknown[]>`): the store type parameter
  // exists to POLICE THE INBOUND CALL (it is what makes a scheme-valued store fail to compile), not
  // to be tracked through the value's whole life. Re-stamping does not re-open the crossing — the
  // store was already vetted at construction — so the widened source is honest here, not a laundered
  // cast. Every consumer of a borrowed array types it bare (`AJSArray`), which is this default.
  withProvenance(p: ReadonlySet<number>): AJSArray {
    return new AJSArray(this.ctx, this.source as readonly unknown[], p);
  }

  // ── Vector algebra — DELEGATED to the materialized vector (no duplicated logic) ──
  // Return types MIRROR AVector's concrete returns: honest + precise, never the abstract
  // `AValue` (not assignable to the `SchemeValue` union the base declares). `map` is
  // box-preserving ("one algebra, every carrier") — it returns a FRESH AVector,
  // same as AVector's own map; a borrowed array's map is no longer a foreign-Functor cross-out.
  ["arrival/tagless-final/map"](
    fn: (x: SchemeValue) => SchemeValue | Promise<SchemeValue>,
    runCtx: RunContext,
  ): AVector | Promise<AVector> {
    return this.vec()[tf("map")](fn, runCtx);
  }

  ["arrival/tagless-final/filter"](
    pred: ((x: unknown) => unknown | Promise<unknown>) | RegExp,
    runCtx: RunContext,
  ): Promise<AVector> {
    return this.vec()[tf("filter")](pred, runCtx);
  }

  ["arrival/tagless-final/reduce"]<Acc>(
    fn: (element: unknown, acc: Acc) => Acc | Promise<Acc>,
    initial: Acc,
    runCtx: RunContext,
  ): Acc | Promise<Acc> {
    return this.vec()[tf("reduce")](fn, initial, runCtx);
  }

  ["arrival/tagless-final/sort"](
    comparator: ((a: unknown, b: unknown) => unknown) | undefined,
    runCtx: RunContext,
  ): AVector {
    return this.vec()[tf("sort")](comparator, runCtx);
  }

  ["arrival/tagless-final/take"](n: number, runCtx: RunContext): AVector {
    return this.vec()[tf("take")](n, runCtx);
  }

  ["arrival/tagless-final/drop"](n: number, runCtx: RunContext): AVector {
    return this.vec()[tf("drop")](n, runCtx);
  }

  ["arrival/tagless-final/take-while"](
    pred: (x: SchemeValue) => unknown | Promise<unknown>,
    runCtx: RunContext,
  ): Promise<AVector> {
    return this.vec()[tf("take-while")](pred, runCtx);
  }

  ["arrival/tagless-final/drop-while"](
    pred: (x: SchemeValue) => unknown | Promise<unknown>,
    runCtx: RunContext,
  ): Promise<AVector> {
    return this.vec()[tf("drop-while")](pred, runCtx);
  }

  // The SPINE READING of the borrowed array (see AJSArrayList's header for the chart law). Asking
  // a vector for car/cdr IS asking for its spine — so we project one, straight off the borrowed
  // `source`, O(1), no materialization.
  //
  // These used to delegate into `vec()`, which meant the most ordinary idiom in the medium —
  // `(car (some-tool …))` — boxed the ENTIRE array just to read element 0, and `(cdr …)` handed
  // back a vector slice that no `null?` could ever terminate on. The strict gate stays on the
  // CONTAINER (a borrowed array is a vector, and strict mode still refuses car/cdr on it,
  // faithfully); the projected view is a genuine pair and is never gated.
  ["arrival/tagless-final/car"](runCtx?: RunContext): SchemeValue {
    strictGate(runCtx, {
      op: "car",
      rule: "R7RS `car` requires a pair; a vector is not a pair",
      alternative: "use `(vector-ref v 0)` for the first element, or `(vector->list v)`",
    });
    this.freezeSource();
    return this.source.length > 0 ? this.elementAt(0) : nil;
  }

  ["arrival/tagless-final/cdr"](runCtx?: RunContext): AJSArrayList | ANil {
    strictGate(runCtx, {
      op: "cdr",
      rule: "R7RS `cdr` requires a pair; a vector is not a pair",
      alternative: "use vector slicing or `(vector->list v)`",
    });
    this.freezeSource();
    return AJSArrayList.at(this, 1);
  }

  // Print protocol — the same #(...) vector repr as AVector; the __vector__ getter
  // materializes the source once (cached), matching the printer's get_instances AJSArray
  // entry at quote=false.
  /** The BORROWED source's elements — raw, unboxed. Walking them costs no materialization: the
   *  collapse walk only collects provenance off values that already ARE AValues. */
  override ["arrival/provenanceChildren"](): Iterable<unknown> {
    return this.source;
  }

  ["arrival/print"](): string {
    return `#(${this.__vector__.map((el) => printValue(el)).join(" ")})`;
  }

  // Setoid — reference identity (SAME borrowed source), matching the opaque-view sibling
  // AJSObject. A borrowed foreign array is a read-only view; deep-comparing its source is
  // the deep semantics the membrane exists to avoid.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AJSArray && other.source === this.source;
  }

  // Element-count read straight off `source` (no materialize). Interim fix
  // (RULINGS.md R2): reads the CONTAINER's own flat grouping/length-fact
  // stamp (`withInputProvenance([this], count)`), never the elements' union — matches
  // APair/AVector's `length` (one algebra every carrier). A borrowed array's own
  // top-level provenance is empty by construction today (the grouping-fact mint for
  // AJSArray/ADict is a separate, already-ticketed gap — term-carrier.law.test.ts's
  // `equalsContainerHasNoGroupingFact`), so this reads as an empty-provenance boxed AExact
  // until that lands (`withInputProvenance` always boxes — never a bare count).
  ["arrival/tagless-final/length"](_runCtx?: unknown): AValue | number {
    this.freezeSource();
    return withInputProvenance([this], this.source.length);
  }

  // Vector type-predicate — a borrowed JS array answers `(vector? x)` #t (it IS a vector).
  ["arrival/tagless-final/vector?"](): boolean {
    return true;
  }

  // ── Member trio (`@`/`@?`/`@keys` + the `:key` accessor) — the borrowed-array arm of the
  // protocol AJSObject/ADict carry. Reads go through the interop policy over the RAW source
  // (own members only, boundary walk — a borrowed array's `length`/index reads are member
  // reads, not vector algebra). Semantics inherited verbatim from the membrane face's
  // former AJSArray branch: NOT_FOUND/blocked → nil; an array-valued member re-presents as
  // a borrowed AJSArray (so car/cdr work on it); other members box via jsToScheme with
  // EMPTY provenance (the face's historical choice — element reads via `vector-ref` carry
  // this container's provenance instead; that asymmetry precedes this term and is pinned
  // by the identity/lineage suites).
  ["arrival/tagless-final/get"](key: SchemeValue | string): SchemeValue | Promise<SchemeValue> {
    this.freezeSource();
    const name = foldMemberName(key);
    let raw: unknown;
    try {
      raw = accessMember(this.source, name);
    } catch (e) {
      if (e instanceof InteropAccessError) return nil;
      throw e;
    }
    if (raw === NOT_FOUND) return nil;
    if (Array.isArray(raw)) return new AJSArray(this.ctx, raw);
    // A Promise-valued member is a lazy pending cell — settled box carries the member
    // path's historical EMPTY provenance, same as the sync read below.
    if (is_promise(raw))
      return this.pendingCell(name, raw, (settled) => jsToScheme(this.ctx, settled, {}, EMPTY_PROVENANCE));
    const boxed: SchemeValue = jsToScheme(this.ctx, raw, {}, EMPTY_PROVENANCE);
    return boxed;
  }

  ["arrival/tagless-final/has"](key: SchemeValue | string): boolean {
    this.freezeSource();
    return accessHas(this.source, foldMemberName(key));
  }

  ["arrival/tagless-final/keys"](): string[] {
    this.freezeSource();
    return accessKeys(this.source);
  }

  // Indexed access — boxes JUST element k (no full materialize), the same lazy crossing as
  // `vec()` below and the AJSObject.get sibling: `jsToScheme` carrying THIS container's
  // provenance, so `(vector-ref borrowed k)` stamps the element identically to
  // `(vector->list borrowed)` (the Option-C discipline — a raw element inherits the
  // container's lineage, an already-AValue element keeps its own). `jsToScheme` is typed
  // `any` (rosetta legacy debt) but its contract is a boxed Scheme value → annotate to the
  // honest union so the `SchemeValue` return type-checks without a cast. (`fromJS` would
  // drop provenance instead, via CONSTANT_CTX/EMPTY_PROVENANCE.)
  ["arrival/tagless-final/vector-ref"](k: number): SchemeValue | Promise<SchemeValue> {
    this.freezeSource();
    const raw = this.source[k];
    // A Promise-valued element is a lazy pending cell (pending-entry.ts): first read
    // mints one settle chain, settlement caches the box — sync after settlement. The
    // settled box takes the SAME boxing as the sync path below (container provenance +
    // attestation inheritance).
    if (is_promise(raw)) return this.pendingCell(k, raw, (settled) => this.boxElement(settled));
    return this.boxElement(raw);
  }

  /** The `vector-ref` boxing discipline (shared by the sync path and the pending cell's
   *  settlement): jsToScheme carrying THIS container's provenance, attestation
   *  inheritance (stamp site 2), `freshIfSingleton` so a raw boolean surfaces as an
   *  attested clone, never the shared flyweight. */
  /**
   * THE declared membrane penetration for this container's elements — the ONE place an element of
   * a borrowed JS array crosses into the scheme world, and the only element-crossing any consumer
   * of this container may use.
   *
   * `AJSArrayList` (the spine chart over this same borrowed store) calls THIS rather than owning a
   * second boxing policy. That is V's hygiene law made structural: one store, one crossing, owned
   * by the class that owns the store (P7). A view carrying its own boxing could be pointed at any
   * array-shaped thing — which is how an earlier cut came to project it over an OWNED `AVector`,
   * whose elements are already boxed, and silently re-stamped every one of them with the
   * container's provenance.
   */
  elementAt(i: number): SchemeValue {
    this.freezeSource();
    return this.boxElement(this.source[i]);
  }

  private boxElement(raw: unknown): SchemeValue {
    // ─── THE HYGIENE LAW, ENFORCED AT THE PENETRATION POINT ──────────────────────────────────
    //
    // Each membrane penetration must be tracked and explicit: nothing here may accept both a
    // monadic AValue and a primitive JSValue at the same slot. That is the hygienic discipline
    // that makes every flip between a Scheme entity and a native JS entity OBSERVED — the only
    // way to have hygiene when the host is both the interpreter runner and a Graal-style parallel
    // world. So `source` holds the UNBOXED world only: JS primitives, plain objects/arrays, and
    // egress proxies (a reverse-membraned dict proxy, as a special case of the matryoshka-style
    // processing already done elsewhere). The proxy carve-out needs no clause of its own — an
    // egress proxy is a Proxy over a plain target, so `instanceof AValue` is already false for it.
    //
    // The check lives HERE, at the crossing, and not in the constructor on purpose. A borrowed
    // array's whole contract is that it is LAZY — `.length` and `schemeToJs` never touch the
    // elements — so an O(n) scan at construction would pay the very cost the class exists to avoid.
    // The crossing is O(1) and it is the moment the flip actually happens, which is exactly what the
    // law asks to be tracked.
    //
    // An AValue arriving here means someone pushed a SCHEME value into a JS-world store: the flip
    // went unobserved, and `jsToScheme` below would then DEEP-RE-STAMP that value with this
    // container's provenance (rosetta.ts's inbound AValue claim re-stamps unless the provenance is
    // empty or identical), silently destroying its lineage. That is not hypothetical — a spine view
    // once projected over an owned vector corrupted per-element provenance exactly this way, caught
    // only by the term-carrier law. Fail loudly instead.
    Error.invariant(
      !(raw instanceof AValue),
      "AJSArray: `source` must hold JS-world values only — an AValue here means a scheme value was " +
        "pushed into a borrowed JS store without crossing the membrane (an unobserved flip). Cross it " +
        "with `schemeToJs` first, or hold it in an AVector.",
    );
    const boxed: SchemeValue = jsToScheme(this.ctx, raw, {}, this.provenance);
    return isAttested(this) ? attestDeep(freshIfSingleton(boxed)) : boxed;
  }

  /** Mint-or-reuse the pending cell for a Promise-valued read (see `pendingCells`):
   *  the chain itself is cached so concurrent readers share ONE settlement, and the
   *  settled box overwrites it — sync-after-settled. */
  private pendingCell(
    key: number | string,
    raw: unknown,
    box: (settled: unknown) => SchemeValue,
  ): SchemeValue | Promise<SchemeValue> {
    let cells = pendingCells.get(this);
    if (cells === undefined) {
      cells = new Map();
      pendingCells.set(this, cells);
    }
    const hit = cells.get(key);
    if (hit !== undefined) return hit;
    const slot = cells;
    const cell = settleEntry(raw, box, (boxed) => slot.set(key, boxed));
    slot.set(key, cell);
    return cell;
  }

  // Freezes the borrowed source on first Scheme read so the host can't mutate it afterward —
  // prevention by construction, replacing the dev-only purity assert. Idempotent.
  // `freezeRosettaReturns: false` on the run ctx opts out (host keeps it mutable).
  private freezeSource(): void {
    if (this.ctx.freezeRosettaReturns !== false && !Object.isFrozen(this.source)) {
      Object.freeze(this.source);
    }
  }

  // Box the borrowed source into an owned AVector through the membrane, once. The vector
  // algebra above DELEGATES here — AJSArray implements the contract without inheriting it.
  // `new AVector` runs only at call time, so AVector need not be defined when THIS module
  // evaluates (the cycle-avoidance the "implements, not extends" shape buys).
  private vec(): AVector {
    this.freezeSource();
    // Box each element through jsToScheme carrying THIS borrowed container's provenance — so
    // elements inherit the crossing's lineage (parallel to AJSObject.get, which threads
    // this.provenance to its fields), and nested arrays/objects re-borrow faithfully.
    if (this.boxedVec === undefined) {
      // Attestation inheritance (stamp site 2, values/attestation.ts): the materialized
      // elements are attested iff the borrowed container is — parallel to AJSObject.get.
      // `freshIfSingleton` per element: a raw boolean boxes to the shared #t/#f flyweight
      // on the empty-provenance path, and the singletons never attest — the clone does.
      const inherit = isAttested(this);
      this.boxedVec = new AVector(
        this.ctx,
        this.source.map((v) => {
          const boxed: SchemeValue = jsToScheme(this.ctx, v, {}, this.provenance);
          return inherit ? attestDeep(freshIfSingleton(boxed)) : boxed;
        }),
        this.provenance,
      );
      if (inherit) attestDeep(this.boxedVec);
    }
    return this.boxedVec;
  }
}
