/**
 * SchemeCharacter — R7RS character type (extracted from values/types.ts).
 * Carries the `characters` named-character table it is backed by.
 */
import { CLASS } from "../../well-known-symbols.js";
import { CONSTANT_CTX, type RunContext } from "./RunContext.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { markInteropBoundary } from "../../interop-access.js";
import { isSchemeString, type SchemeStringLike } from "../types.js";
import invariant from "tiny-invariant";

const characters: Record<string, string> = {
  alarm: "\u0007",
  backspace: "\u0008",
  delete: "\u007F",
  escape: "\u001B",
  newline: "\n",
  null: "\u0000",
  return: "\r",
  space: " ",
  tab: "\t",
  // new symbols from ASCII table in SRFI-175
  dle: "\u0010",
  soh: "\u0001",
  dc1: "\u0011",
  stx: "\u0002",
  dc2: "\u0012",
  etx: "\u0003",
  dc3: "\u0013",
  eot: "\u0004",
  dc4: "\u0014",
  enq: "\u0005",
  nak: "\u0015",
  ack: "\u0006",
  syn: "\u0016",
  bel: "\u0007",
  etb: "\u0017",
  bs: "\u0008",
  can: "\u0018",
  ht: "\u0009",
  em: "\u0019",
  lf: "\u000A",
  sub: "\u001A",
  vt: "\u000B",
  fs: "\u001C",
  ff: "\u000C",
  gs: "\u001D",
  cr: "\u000D",
  rs: "\u001E",
  so: "\u000E",
  us: "\u001F",
  si: "\u000F",
  esc: "\u001B",
  del: "\u007F",
};

export { characters };

export class ACharacter extends AValue {
  static [CLASS] = "character";
  readonly kind = "character" as const;
  // Named character mappings
  static readonly __names__: Record<string, string> = characters;
  static readonly __rev_names__: Record<string, string> = (() => {
    const rev: Record<string, string> = {};
    // First-write-wins: R7RS § 6.6 canonical names (alarm, backspace, delete,
    // escape, newline, null, return, space, tab) are registered FIRST in the
    // `characters` table, before their later SRFI-175 aliases (bel, bs, del,
    // esc, lf, cr, ht). Iterating in source order and skipping codepoints that
    // already have a reverse name keeps the canonical R7RS name as the winner —
    // so `(integer->char 7)` resolves to #\alarm, not #\bel.
    for (const key of Object.keys(characters)) {
      const codepoint = characters[key];
      if (!(codepoint in rev)) {
        rev[codepoint] = key;
      }
    }
    return rev;
  })();
  readonly __char__: string;
  readonly __name__?: string;

  constructor(ctx: RunContext, char: string | SchemeStringLike, provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(ctx, provenance);
    let charValue = isSchemeString(char) ? char.valueOf() : char;
    let name: string | undefined;

    if ([...charValue].length > 1) {
      // this is a named character
      charValue = charValue.toLowerCase();
      // this should never happen - parser doesn't allow undefined named characters
      invariant(ACharacter.__names__[charValue], "Internal: Unknown named character");
      name = charValue;
      charValue = ACharacter.__names__[charValue];
    } else {
      name = ACharacter.__rev_names__[charValue];
    }

    this.__char__ = charValue;
    if (name) {
      this.__name__ = name;
    }
  }

  toUpperCase(): ACharacter {
    return new ACharacter(CONSTANT_CTX, this.__char__.toUpperCase());
  }

  toLowerCase(): ACharacter {
    return new ACharacter(CONSTANT_CTX, this.__char__.toLowerCase());
  }

  toString(): string {
    return `#\\${this.__name__ || this.__char__}`;
  }

  valueOf(): string {
    return this.__char__;
  }

  serialize(): string {
    return this.__char__;
  }

  toJs(): string {
    return this.__char__;
  }

  withProvenance(p: ReadonlySet<number>): ACharacter {
    return new ACharacter(CONSTANT_CTX, this.__char__, p);
  }

  // Setoid (Fantasy Land). Char ≡ char iff same grapheme. Matches the value
  // semantics of __char__. structuralEqual / equal? consult this first.
  // (algebras-in-entities migration — plan-2026-06-10-algebras-in-entities.md.)
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof ACharacter && this.__char__ === other.__char__;
  }

  // Ord (Fantasy Land, extends Setoid). Ordered by code point.
  ["arrival/tagless-final/lte"](other: unknown): boolean {
    return (
      other instanceof ACharacter &&
      (this.__char__.codePointAt(0) ?? 0) <= (other.__char__.codePointAt(0) ?? 0)
    );
  }
}

// SchemeCharacter has no JS-primitive source — it only exists post-parse, so no boxer.
markInteropBoundary(ACharacter);
