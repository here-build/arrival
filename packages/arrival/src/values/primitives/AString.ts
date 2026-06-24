// String wrapper — copy + in-place mutation (string-set!/string-fill!) over a
// code-point view, with provenance and Fantasy Land algebras on the instance.
// Lineage: R7RS-small §6.7 strings; the representation-blind Setoid + Functor/
// Semigroup/Monoid/Applicative are Fantasy Land (fantasyland/fantasy-land).
import { CLASS } from "../../well-known-symbols.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import type { ANumeric } from "../numbers.js";
import { markInteropBoundary } from "../../interop-access.js";
import { ACharacter } from "./ACharacter.js";
import { typecheck } from "../../utils/typecheck.js";

type StringLike = string | AString | { valueOf(): string };
type NumberLike = number | ANumeric | { valueOf(): number };
type CharLike = string | ACharacter | { valueOf(): string };

export class AString extends AValue {
  static [CLASS] = "string";
  readonly kind = "string" as const;

  __string__: string;

  constructor(
    string: ACharacter[] | StringLike,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
  ) {
    super(provenance);
    this.__string__ = Array.isArray(string)
      ? string
          .map((x, i) => {
            typecheck("SchemeString", x, "character", i + 1);
            return x.toString();
          })
          .join("")
      : string.valueOf();
  }

  get length(): number {
    // R7RS strings are sequences of Unicode code points, not UTF-16 code units.
    // Spread iterates by code point so astral chars (emoji, U+10000+) count once.
    return [...this.__string__].length;
  }

  static isString(x: unknown): x is AString | string {
    return x instanceof AString || typeof x === "string";
  }

  *[Symbol.iterator]() {
    const chars = [...this.__string__];
    for (const char of chars) {
      yield new ACharacter(char);
    }
  }

  serialize(): string {
    return this.valueOf();
  }

  freeze(): void {
    const string = this.__string__;
    delete (this as Partial<AString>).__string__;
    Object.defineProperty(this, "__string__", {
      value: string,
      // Non-configurable + non-writable so a later re-defineProperty or
      // assignment can't defeat the freeze — frozen string literals are
      // immutable per R7RS § 6.7 (string-set!/string-fill! on a literal is an
      // error). `configurable: true` previously left the door open.
      configurable: false,
      writable: false,
      enumerable: true,
    });
  }

  get(n: NumberLike): string {
    typecheck("SchemeString::get", n, "number");
    return [...this.__string__][typeof n === "number" ? n : n.valueOf()];
  }

  cmp(string: StringLike): number {
    typecheck("SchemeString::cmp", string, "string");
    const a = this.valueOf();
    const b = string.valueOf();
    if (a < b) {
      return -1;
    } else if (a === b) {
      return 0;
    } else {
      return 1;
    }
  }

  // Setoid (Fantasy Land). REPRESENTATION-BLIND value equality: a boxed SchemeString equals BOTH
  // another SchemeString of the same content AND the same value UNBOXED (a plain JS string). A string
  // has no exact/inexact-style grade, so its identity is purely its characters — and the chain plane
  // boxes inconsistently (provenance-carrying op → boxed; literal/rosetta-unwrap → plain), so equal?
  // routinely meets a boxed string against a plain one. Comparing only `instanceof SchemeString` made
  // `(equal? boxed "x")` ⇒ #f, silently breaking every dedup/`member?` over derived strings (the
  // sift/closure.scm browser hang). `this.__string__ === other` lets a plain-string `other` match by
  // content and a non-string `other` (number/object) fall through to #f. structuralEqual consults the
  // Setoid before its valueOf check, so this is THE place string equality is decided.
  ["fantasy-land/equals"](other: unknown): boolean {
    return this.__string__ === (other instanceof AString ? other.__string__ : other);
  }

  // Ord (Fantasy Land, extends Setoid). Lexicographic via JS `<=`, a total
  // code-unit order (totality/antisymmetry/transitivity/consistency-with-equals
  // all hold against the Setoid above). Non-SchemeString → false.
  ["arrival/tagless-final/lte"](other: unknown): boolean {
    return other instanceof AString && this.__string__ <= other.__string__;
  }

  // Functor (Fantasy Land) — map over the characters. Iterates by code point
  // (spread), so astral chars map as single graphemes. `f` receives and returns
  // a string char; the result is the joined string. (Migrated from the
  // fantasy-land.ts monkey-patch — plan-2026-06-10-algebras-in-entities.md wave 2.)
  ["fantasy-land/map"](f: (char: string) => string): AString {
    return new AString([...this.__string__].map(f).join(""));
  }

  // Semigroup (Fantasy Land) — string append. `this ⋄ other` concatenates the
  // two underlying strings. Associative; equality via the Setoid above.
  ["fantasy-land/concat"](other: AString): AString {
    return new AString(this.__string__ + other.valueOf());
  }

  // Monoid (Fantasy Land) — the empty string is the identity for append.
  static ["arrival/tagless-final/empty"](): AString {
    return new AString("");
  }

  // Applicative (Fantasy Land) — lift a value into a SchemeString.
  static ["arrival/tagless-final/of"](value: unknown): AString {
    return new AString(String(value));
  }

  lower(): AString {
    return new AString(this.__string__.toLowerCase());
  }

  upper(): AString {
    return new AString(this.__string__.toUpperCase());
  }

  set(n: NumberLike, char: CharLike): void {
    typecheck("SchemeString::set", n, "number");
    typecheck("SchemeString::set", char, ["string", "character"]);
    const idx = typeof n === "number" ? n : n.valueOf();
    const charValue = char instanceof ACharacter ? char.__char__ : char.valueOf();
    // Rebuild by code point, not UTF-16 unit, so replacing index k in a string
    // containing astral chars doesn't split a surrogate pair (R7RS § 6.7).
    const codepoints = [...this.__string__];
    codepoints[idx] = charValue;
    this.__string__ = codepoints.join("");
  }

  clone(): AString {
    return new AString(this.valueOf());
  }

  fill(char: CharLike): void {
    typecheck("SchemeString::fill", char, ["string", "character"]);
    const charValue = char instanceof ACharacter ? char.valueOf() : char.valueOf();
    // Fill must preserve the code-point length, not the UTF-16 unit length —
    // a string of N astral chars stays N chars after string-fill! (R7RS § 6.7).
    const len = [...this.__string__].length;
    this.__string__ = charValue.repeat(len);
  }

  valueOf(): string {
    return this.__string__;
  }

  toString(): string {
    return this.__string__;
  }

  toJs(): string {
    return this.__string__;
  }

  withProvenance(p: ReadonlySet<number>): AString {
    return new AString(this.__string__, p);
  }
}

AValue.registerBoxer("string", (v, p) => new AString(v as string, p));

// Dynamically wrap all String.prototype methods
{
  const ignore = new Set(["length", "constructor"]);
  const _keys = Object.getOwnPropertyNames(String.prototype).filter((name) => {
    return !ignore.has(name);
  });
  const wrap = (fn: (...args: unknown[]) => unknown) =>
    function (this: AString, ...args: unknown[]) {
      return fn.apply(this.__string__, args);
    };
  for (const key of _keys) {
    const proto = AString.prototype as unknown as Record<string, unknown>;
    const strProto = String.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    proto[key] = wrap(strProto[key]);
  }
}

// ============================================================================
// INTEROP BOUNDARY
// ============================================================================
// War story (2026-05-28 audit): the loop above grafts EVERY method from
// `String.prototype` onto `SchemeString.prototype` as OWN enumerable
// properties — `.replace`, `.match`, `.split`, `.concat`, the entire surface.
// Because they're OWN (not inherited), the fast-path in `accessMember`
// returns them without checking any boundary. Symbol-to-field auto-resolution
// means an inference-plane holder of a SchemeString can reach every one of these via
// scheme property access. The methods themselves are harmless on the string
// payload, but the surface area is unaudited — any future graft (e.g. a
// method that returns the underlying object) becomes an exfiltration vector.
//
// Marking the class as a boundary lets `isInteropBoundary(proto)` return true
// when the prototype-chain walk in `accessMember` reaches the SchemeString
// prototype, blocking the inherited surface. Own properties remain accessible
// (the fast path is untouched) — this is correct because grafted methods are
// own, so the boundary only blocks future inherited additions, not the
// current intended API. Defense-in-depth via the AValue base marker.
// ============================================================================
markInteropBoundary(AString);
