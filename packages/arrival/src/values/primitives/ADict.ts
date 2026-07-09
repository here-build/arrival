/**
 * ADict — the native, immutable open-key map (`{…}` literal / `(dict …)`). Replaces
 * AJSObject in the dict role: AJSObject re-boxes every field it reads through
 * jsToScheme (correct for a genuinely-foreign JS object, wrong for a dict whose
 * entries are already-evaluated SchemeValues with real provenance — see
 * docs/working-proposals/native-dict-provenance.md for the traced bug this retires).
 *
 * Keyed by DictKey OBJECTS (a symbol or string), not folded strings, so a key keeps
 * its own provenance exactly like a value does — `indexByName` is the structural
 * resolver that collapses fold-name collisions (`:a` and `"a"` are the same slot)
 * back onto one canonical key object, since `Map`'s own key equality is reference
 * identity.
 *
 * AJSObject is untouched and keeps its actual job: boxing objects that are
 * genuinely foreign, with no prior Scheme lineage to lose.
 */
import { CLASS } from "../../well-known-symbols.js";
import { type RunContext } from "./RunContext.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { egressContainerProxy } from "../egress-proxy.js";
import { ASymbol } from "./ASymbol.js";
import { ACharacter } from "./ACharacter.js";
import { AString } from "./AString.js";
import { nil } from "./ANil.js";
import { type SchemeValue } from "../types.js";
import { type SeenMap, structuralEqual } from "../structural-equal.js";
import { is_promise } from "../../eval/guards.js";
import { isSettleChain, settleEntry } from "./pending-entry.js";
// Runtime import cycle (benign — the same shape AJSObject/AJSArray document): jsToScheme
// is a hoisted `export function`, called only inside `get()` at runtime (settling a
// pending entry), never at module eval.
import { jsToScheme } from "../../rosetta.js";

export type DictKey = ASymbol | AString | ACharacter;

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
   *  producer's own policy, decided before this constructor runs (see
   *  native-dict-provenance.md's Error paths), exactly as it trusts `Record`/array
   *  shape today. */
  constructor(
    ctx: RunContext,
    pairs: ReadonlyArray<readonly [DictKey, SchemeValue | Promise<SchemeValue>]>,
    provenance = EMPTY_PROVENANCE,
  ) {
    super(ctx, provenance);
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
    if (is_promise(entry)) {
      // A re-read during pendency finds the already-minted chain — return it, never
      // wrap a second one (pending-entry.ts's ONE-settle-chain contract).
      if (isSettleChain(entry)) return entry;
      const cell = settleEntry(
        entry,
        (settled) => jsToScheme(this.ctx, settled, {}, this.provenance),
        (boxed) => this.byKey.set(key, boxed),
      );
      this.byKey.set(key, cell);
      return cell;
    }
    return entry;
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
    return new ADict(this.ctx, [...this.byKey.entries()], p);
  }

  /** R9 lazy egress: folded plain string keys, values unwrapping through their own
   *  `arrival/toJS` on first read — observationally a plain read-only object; same
   *  dict → same proxy (egress-proxy.ts owns the tracker and the write doors). A
   *  pending entry egresses as a Promise OF the unwrapped JS value (the settle chain
   *  continued through the box's own `arrival/toJS`) — the JS consumer awaits it. */
  ["arrival/toJS"](): Record<string, unknown> {
    return egressContainerProxy(this, "object", {
      keys: () => this.keys(),
      read: (name) => {
        const entry = this.get(name);
        return is_promise(entry)
          ? entry.then((boxed) => (boxed instanceof AValue ? boxed["arrival/toJS"]() : boxed))
          : entry;
      },
    }) as Record<string, unknown>;
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
