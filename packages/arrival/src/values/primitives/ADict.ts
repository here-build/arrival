/**
 * ADict — the native, immutable open-key map (`{…}` literal / `(dict …)`). Replaces
 * AJSObject in the dict role: AJSObject re-boxes every field it reads through
 * jsToScheme (correct for a genuinely-foreign JS object, wrong for a dict whose
 * entries are already-evaluated SchemeValues with real provenance — re-boxing them
 * would silently drop that provenance).
 *
 * Keyed by DictKey OBJECTS (a symbol or string), not folded strings, so a key keeps
 * its own provenance exactly like a value does — `indexByName` is the structural
 * resolver that collapses fold-name collisions (`:a` and `"a"` are the same slot)
 * back onto one canonical key object, since `Map`'s own key equality is reference
 * identity.
 *
 * ALSO the `{…}` reader-literal carrier — the datum face of a dict literal IS an ADict, the same
 * in-class pattern AVector uses for `[…]` (`evalElements` + payload-of-forms): a reader-minted node
 * carries `literalForms` and answers the cached `(dict …)` application from
 * `arrival/tagless-final/lower` in code position; under `quote` the node is itself the readable
 * datum — a real ADict whose static-key entries are the raw, unevaluated forms. The grammar that
 * mints these nodes lives in `reader/dict-grammar.ts` (spec: `reader/__tests__/polyglot/README.md`).
 *
 * AJSObject is untouched and keeps its actual job: boxing objects that are
 * genuinely foreign, with no prior Scheme lineage to lose — it has exited the
 * dict-literal syntax business entirely.
 */
import { CLASS } from "../../well-known-symbols.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { egressContainerProxy } from "../../membrane/egress-proxy.js";
import { APair } from "./APair.js";
import { ASymbol } from "./ASymbol.js";
import { ACharacter } from "./ACharacter.js";
import { AString } from "./AString.js";
import { nil } from "./ANil.js";
import { type MembraneExit, type SchemeValue } from "../types.js";
import { type SeenMap, structuralEqual } from "../structural-equal.js";
import { attestDeep, freshIfSingleton, isAttested } from "../attestation.js";
import { is_promise } from "../../eval/guards.js";
import { isSettleChain, settleEntry } from "./pending-entry.js";
// Runtime import cycle (benign — the same shape AJSObject/AJSArray document): jsToScheme
// is a hoisted `export function`, called only inside `get()` at runtime (settling a
// pending entry), never at module eval.
import { jsToScheme } from "../../membrane/rosetta.js";
import type { SourceLocation } from "../../errors.js";

/** Code-position lowering cache (arrival/tagless-final/lower) for `{…}` dict-literal
 *  nodes — the `(dict …)` application built once per node and re-answered on every
 *  subsequent eval of the SAME node (shared AST — a `{…}` literal inside a loop body
 *  must not re-cons the spine every iteration). WeakMap, not an instance field: keeps
 *  the cache off the dict's own payload (mirrors AVector's `LOWERED_LITERAL`) and off
 *  the `#`-private-slot tslib helper this workspace's `importHelpers: true` needs.
 *  GC-correct — entry disappears with the node. Mirrors AJSObject.ts's own lowered-
 *  literal cache. */
const LOWERED_LITERAL = new WeakMap<ADict, APair<SchemeValue, SchemeValue>>();

export type DictKey = ASymbol | AString | ACharacter;

/** A reader-minted `{…}` dict-literal node: an ADict whose `literalForms` is
 *  present. Named type for consumers that need to spell the narrowed shape (the
 *  grammar's own return type, cross-package AST walkers) — `ADict.isDictLiteral`
 *  is the runtime guard that produces it. */
export type DictLiteralNode = ADict & { literalForms: readonly SchemeValue[] };

/** A key's fold-name — the string identity `:a` and `"a"` share. Not a validating
 *  parse: `pairs` must already carry a `DictKey`; this only strips a keyword's `:`.
 *  Exported so the few other key-name folds in the codebase (reader/dict-grammar.ts's
 *  `staticDictKey`, evaluator.ts's `foldSubstitutedDictKey`) can call this instead of
 *  reimplementing the same strip, where their own shape already narrowed to a DictKey. */
export function foldKeyName(key: DictKey): string {
  if (key instanceof ASymbol) {
    const name = typeof key.__name__ === "string" ? key.__name__ : String(key.valueOf());
    return name.startsWith(":") ? name.slice(1) : name;
  }
  return key.valueOf();
}

/** True iff a plain object is dict-SHAPED — the same disambiguation `readMember`
 *  (membrane.ts) uses: `Object.prototype` or null proto, never an array. Lets a
 *  genuinely foreign, dict-shaped `AJSObject` (a tool result, say) still answer
 *  `dict?`/print as a dict without being an `ADict` — used by `dict?`
 *  (env/r7rs/equality.ts) and `notCallableError` (eval/evaluator.ts). */
export function isDictShaped(source: unknown): boolean {
  if (typeof source !== "object" || source === null || Array.isArray(source)) return false;
  const proto = Object.getPrototypeOf(source);
  return proto === Object.prototype || proto === null;
}

export class ADict extends AValue {
  static [CLASS] = "dict";
  readonly kind = "dict" as const;

  /** `{…}` reader-literal marker: the FLAT, validated form sequence (keys then values,
   *  alternating — an unquote-form key lives ONLY here, having no static entry in `byKey`).
   *  Present ⇒ this node is a reader-minted dict literal (the data/code duality is the preamble's
   *  concept; the grammar is `reader/dict-grammar.ts`); absent on a `dict`-constructed or
   *  quasiquote-folded runtime dict. Reader-minted only; set post-construction, never a
   *  constructor param — the `pairs`-based constructor stays the one calling convention every
   *  producer uses. Mirrors AVector's `evalElements`, sans boolean: a dict's "code needs
   *  evaluating" signal doubles as the forms payload, since — unlike a vector — the literal's
   *  UNQUOTE-KEY forms have no home in the static entries at all. */
  literalForms?: readonly SchemeValue[];

  /** The class's own dict-literal detection — the dual data/code nature is ADict's
   *  self-knowledge (mirrors `AVector.isVector`'s flag-idiom, not a free function's).
   *  Dispatch: the evaluator's quasiquote walk and code-position lowering both key off
   *  this; everything else treats the node as the plain data dict its face presents. */
  static isDictLiteral(v: unknown): v is DictLiteralNode {
    return v instanceof ADict && v.literalForms !== undefined;
  }

  /** The canonical store — key OBJECTS, not folded strings. Entries and keys are
   *  already-evaluated SchemeValues, so there is normally nothing to box; a
   *  Promise-valued entry is held INERT as a lazy pending cell (pending-entry.ts) and
   *  settles in place on first read — the only writes after construction are that
   *  settlement memoization (chain → settled box), never a semantic mutation. */
  private readonly byKey: Map<DictKey, SchemeValue | Promise<SchemeValue>>;

  /** Fold-name → canonical key object — the fast path every string-keyed reader
   *  (`@`, `dict-ref`) actually uses. */
  private readonly indexByName: Readonly<Record<string, DictKey>>;

  /** `pairs` must already carry unique fold-names — duplicate resolution is each
   *  producer's own policy, decided before this constructor runs, exactly as it
   *  trusts `Record`/array shape today. */
  constructor(
    pairs: ReadonlyArray<readonly [DictKey, SchemeValue | Promise<SchemeValue>]>,
    provenance = EMPTY_PROVENANCE,
    location?: SourceLocation,
  ) {
    super(provenance, location);
    const byKey = new Map<DictKey, SchemeValue | Promise<SchemeValue>>();
    const indexByName: Record<string, DictKey> = Object.create(null);
    for (const [key, value] of pairs) {
      const name = foldKeyName(key);
      Error.invariant(
        !(name in indexByName),
        `ADict: duplicate fold-name "${name}" reached the constructor — the caller must resolve duplicates first`,
      );
      indexByName[name] = key;
      byKey.set(key, value);
    }
    this.byKey = byKey;
    this.indexByName = Object.freeze(indexByName);
  }

  /** The only accessor reachable from `@`/`dict-ref` today — those primitives only
   *  ever have a plain string in hand. Missing key → nil, matching AJSObject's
   *  existing dict-ref convention.
   *
   *  A Promise-valued entry is a LAZY PENDING CELL: the first read mints one settle
   *  chain (stored back in the slot, so concurrent readers share it); settlement
   *  replaces the slot with the settled box — later reads are synchronous. The settled
   *  value boxes with THIS dict's provenance (raw JS inherits the container's lineage,
   *  the Option-C discipline; an already-AValue with the same/empty stamp passes by
   *  identity through jsToScheme's fast path). */
  get(name: string): SchemeValue | Promise<SchemeValue> {
    const key = this.indexByName[name];
    if (key === undefined) return nil;
    const entry = this.byKey.get(key);
    if (entry === undefined) return nil;
    // Pluck inheritance (values/attestation.ts stamp site 2, same contract as
    // AJSObject.get): an attested container's plucked field passes attested. The
    // entries were minted BEFORE any `s/*` assertion could touch the container, so
    // identity-preserving return alone would hand back unattested boxes.
    // `freshIfSingleton` first — shared flyweights never attest, their clone does.
    const pluck = (v: SchemeValue): SchemeValue => (isAttested(this) ? attestDeep(freshIfSingleton(v)) : v);
    if (is_promise(entry)) {
      // A re-read during pendency finds the already-minted chain — return it, never
      // wrap a second one (pending-entry.ts's ONE-settle-chain contract).
      if (isSettleChain(entry)) return entry;
      const cell = settleEntry(
        entry,
        (settled) => pluck(jsToScheme(CONSTANT_CTX, settled, {}, this.provenance)),
        (boxed) => this.byKey.set(key, boxed),
      );
      this.byKey.set(key, cell);
      return cell;
    }
    return pluck(entry);
  }

  /** Distinguishes "key absent" from "key present, value is legitimately nil" —
   *  `.get()` alone can't (both answer `nil`). Used by `hasMember` (membrane.ts). */
  has(name: string): boolean {
    return name in this.indexByName;
  }

  keys(): string[] {
    return Object.keys(this.indexByName);
  }

  /** The canonical key objects, provenance intact — for a future key-preserving
   *  accessor (e.g. a `dict-keys` returning real symbols instead of fresh ones).
   *  Not wired to any Scheme primitive yet. */
  keyObjects(): readonly DictKey[] {
    return Object.values(this.indexByName);
  }

  withProvenance(p: ReadonlySet<number>): ADict {
    const d = new ADict([...this.byKey.entries()], p, this.location);
    // Same-identity re-stamp: a `{…}` literal node stays a `{…}` literal node
    // (mirrors AVector.withProvenance re-stamping `evalElements`).
    d.literalForms = this.literalForms;
    return d;
  }

  // Code-position lowering (eval/evaluator.ts "code-position lowering"): a `{…}`
  // reader dict-literal node (`literalForms` present) lowers ONCE, cached, to the
  // equivalent `(dict …)` application — CODE position gets Clojure-style element
  // evaluation BY CONSTRUCTION (the lowering is then evaluated through the ordinary
  // apply path, so membrane marshaling / heap charging / provenance all ride
  // unchanged). A plain, non-literal ADict (`dict`-constructed or quasiquote-folded —
  // `literalForms` absent) answers null: self-evaluating, no lowering. Mirrors
  // AJSObject.ts's own `arrival/tagless-final/lower` — same WeakMap cache pattern
  // as AVector's twin.
  ["arrival/tagless-final/lower"](): APair<SchemeValue, SchemeValue> | null {
    if (this.literalForms === undefined) return null;
    let lowered = LOWERED_LITERAL.get(this);
    if (lowered === undefined) {
      // Same non-empty-spine guarantee as AVector's twin (a `dict` head is always
      // prepended) — narrowed here to match what's actually built.
      lowered = APair.fromArray(CONSTANT_CTX, [new ASymbol("dict"), ...this.literalForms], false) as APair<
        SchemeValue,
        SchemeValue
      >;
      LOWERED_LITERAL.set(this, lowered);
    }
    return lowered;
  }

  /** R9 lazy egress — the ONE crossing protocol, keyed on `exit`. Folded plain string
   *  keys; values unwrap lazily on first read; same dict → same proxy (egress-proxy.ts
   *  owns the tracker and the write doors). A pending entry egresses as a Promise OF the
   *  unwrapped value — the JS consumer awaits it.
   *
   *  Bare (no `exit`, serialization): the settled box continues through its OWN
   *  `arrival/toJS()`; identity is per-box, forever.
   *
   *  Membrane (`exit` from rosetta's egressAValue — its sole builder): the settled box
   *  continues through `exit.element` — the full recursive crossing under the pinned scope
   *  (exit.element's withRegionScope is sync save/restore inside the microtask continuation,
   *  correctly reinstalled at settle time); identity is per (box, mode, scope). BENIGN
   *  double-dispatch, by design (do not "fix"): the proxy's materializeElement also passes
   *  the pending PROMISE itself through exit.element, where schemeToJsImpl's Promise FFI
   *  passthrough returns it unchanged — the real projection is this .then continuation. */
  ["arrival/toJS"](exit?: MembraneExit): Record<string, unknown> {
    return egressContainerProxy(
      this,
      "object",
      {
        keys: () => this.keys(),
        read: (name) => {
          const entry = this.get(name);
          if (!is_promise(entry)) return entry;
          return exit
            ? entry.then((boxed) => exit.element(boxed))
            : entry.then((boxed) => (boxed instanceof AValue ? boxed["arrival/toJS"]() : boxed));
        },
      },
      exit ? { membrane: exit } : undefined,
    ) as Record<string, unknown>;
  }

  // Print protocol — a real `(dict :k v ...)` repr; neither prior dict representation
  // printed as a dict at all (`#<js-object>` either way).
  ["arrival/print"](): string {
    const parts = this.keys().map((name) => `:${name} ${String(this.get(name))}`);
    return `(dict${parts.length ? " " + parts.join(" ") : ""})`;
  }

  // Setoid — same set of fold-names, values `equal?`-recursive at each name. Compares at the
  // fold-name level, not the key-object level: `(dict :a 1)` and `(dict "a" 1)` fold to the
  // same slot and stay equal; the richer DictKey identity only matters for provenance, not
  // for `equal?`. (AJSObject's Setoid is reference identity, so a `{:a 1}` literal and a
  // `(dict :a 1)` compared differently before this — two spellings of the same shape.)
  ["arrival/tagless-final/equals"](other: unknown, seen?: SeenMap): boolean {
    if (!(other instanceof ADict)) return false;
    const ownNames = this.keys();
    const otherNames = other.keys();
    if (ownNames.length !== otherNames.length) return false;
    for (const name of ownNames) {
      if (!(name in other.indexByName)) return false;
      if (!structuralEqual(this.get(name), other.get(name), seen)) return false;
    }
    return true;
  }

  // Keyed member read — the `:key` keyword accessor's `apply` (ASymbol.ts) hands its own
  // symbol here; the membrane's `readMember` face hands its normalized string. Either way
  // the RECEIVER folds: a string is already a fold-name, a DictKey folds through
  // `foldKeyName`. `AJSObject`/`AJSArray` implement the same trio over their own reads.
  // A Promise-valued entry answers its pending cell (Promise of the settled box) — the
  // async dispatch seams await it; sync after settlement.
  ["arrival/tagless-final/get"](key: SchemeValue | string): SchemeValue | Promise<SchemeValue> {
    return this.get(typeof key === "string" ? key : foldKeyName(key as DictKey));
  }

  ["arrival/tagless-final/has"](key: SchemeValue | string): boolean {
    return this.has(typeof key === "string" ? key : foldKeyName(key as DictKey));
  }

  ["arrival/tagless-final/keys"](): string[] {
    return this.keys();
  }
}
