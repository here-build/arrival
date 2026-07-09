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

export type DictKey = ASymbol | AString | ACharacter;

/** A key's fold-name — the string identity `:a` and `"a"` share. Not a validating
 *  parse: `pairs` must already carry a `DictKey`; this only strips a keyword's `:`.
 *  Exported so the few other key-name folds in the codebase (dict-literal.ts's
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

  /** The canonical store — key OBJECTS, not folded strings. Frozen at construction;
   *  entries and keys are already-evaluated SchemeValues, so there is nothing to box. */
  private readonly byKey: ReadonlyMap<DictKey, SchemeValue>;

  /** Fold-name → canonical key object — the fast path every string-keyed reader
   *  (`@`, `dict-ref`) actually uses. */
  private readonly indexByName: Readonly<Record<string, DictKey>>;

  /** `pairs` must already carry unique fold-names — duplicate resolution is each
   *  producer's own policy, decided before this constructor runs (see
   *  native-dict-provenance.md's Error paths), exactly as it trusts `Record`/array
   *  shape today. */
  constructor(ctx: RunContext, pairs: ReadonlyArray<readonly [DictKey, SchemeValue]>, provenance = EMPTY_PROVENANCE) {
    super(ctx, provenance);
    const byKey = new Map<DictKey, SchemeValue>();
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
   *  existing dict-ref convention. */
  get(name: string): SchemeValue {
    const key = this.indexByName[name];
    return key === undefined ? nil : (this.byKey.get(key) ?? nil);
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
   *  dict → same proxy (egress-proxy.ts owns the tracker and the write doors). */
  ["arrival/toJS"](): Record<string, unknown> {
    return egressContainerProxy(this, "object", {
      keys: () => this.keys(),
      read: (name) => this.get(name),
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

  // Keyed read — the `:key` keyword accessor's `apply` (ASymbol.ts, keyword-tagless-
  // apply.md) hands its own symbol here, not a pre-folded string; `AJSObject`
  // implements this the same way, over its own `.get`.
  ["arrival/tagless-final/get"](key: SchemeValue): SchemeValue {
    return this.get(foldKeyName(key as DictKey));
  }
}
