// arrival's polyglot-racket pack — the Racket dialect pack (see
// polyglot.ts's header for the sibling-pack map).
//
// Two families:
//   THREADING — `~>`/`~>>` (Racket's thread-first/thread-last spellings), ALIASES
//   expanding to Clojure's `->`/`->>` (polyglot-clojure.ts): this pack DEPENDS
//   ON polyglot-clojure rather than re-implementing the expansion independently.
//   `->`/`->>` are referenced only as quasiquoted DATA inside `~>`/`~>>`'s own
//   macro bodies (`\`(-> ,x ,@forms)`), so the static bake FV walker does NOT
//   force this edge (quasiquote space is data except under unquote) — but the
//   RESULTING expansion is a runtime Unbound-variable trap unless `->`/`->>` are
//   actually bound, so the edge is declared anyway for honest standalone
//   composition. Consequence: base-packs.ts positions this pack BEFORE
//   polyglot-clojure in the C3 tail (dependents before dependencies).
//   DICT ACCESSOR FAMILY (Racket's dict library) — grain-completion: models
//   reach for `dict-ref` to read a field off a dict-shaped tool result and get
//   stranded (Unbound variable). `@`/`:key` already read ANYTHING member-shaped
//   (dict / membrane-foreign / array — origin-agnostic, see polyglot.ts's
//   header), but a model trained on Racket's dict library reaches for its
//   actual name. This family is that name, PLUS the value `@` doesn't have:
//   dict-ref/dict-keys/… are dict-SPECIFIC — they guard the dict shape (see
//   %dict-guard) so a wrong-shaped argument fails loudly (door: fact + why +
//   action) instead of silently reading nil through `@`'s origin-agnostic
//   fallback. `assoc-ref` (Guile/Emacs Lisp) rides with this family — an
//   accessor-name alias of `dict-ref`, not a second read convention.
//
// DICT DOOR: `d` is `z.schemeValue`, never `z.dict()`. The guard throws the
// teaching text; a dict contract would reject the bad shape before that text
// runs. Native contracts are type-only, so the throw is the validator.

import { EnvCapability } from "../../common/capability.js";
import { is_callable, is_macro } from "../../eval/guards.js";
import { AJSObject } from "../../membrane/AJSObject.js";
import { isSchemeNumber, schemeBool } from "../../values/op-helpers.js";
import { mintExact } from "../../values/mint-numeric.js";
import { ADict, foldKeyName, type DictKey } from "../../values/primitives/ADict.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { APair } from "../../values/primitives/APair.js";
import { AString } from "../../values/primitives/AString.js";
import type { SchemeValue } from "../../values/types.js";
import { maybeThen } from "../../utils/promises.js";
import { asReceiver, to_array } from "../pack-helpers.js";
import polyglotClojure from "./polyglot-clojure.js";
import polyglot, { asDictKey, hasMember, memberEntries, memberNames, readMember } from "./polyglot.js";
import equality from "../r7rs/equality.js";
import numeric from "../r7rs/numeric.js";
import vectors from "../r7rs/vectors.js";
import lists from "../r7rs/lists.js";
import exceptions from "../r7rs/exceptions.js";

/** The `%dict-guard` door's carrier noun. First matching row wins, in the order the
 *  scheme `cond` had. */
function carrierPhrase(d: SchemeValue): string {
  const receiver = asReceiver(d);
  if (receiver?.["arrival/tagless-final/pair?"]?.() === true) return "a pair/list";
  if (receiver?.["arrival/tagless-final/vector?"]?.() === true) return "a vector";
  if (d instanceof AString) return "a string";
  if (isSchemeNumber(d)) return "a number";
  if (d instanceof ANil) return "'() (empty list)";
  if (is_callable(d) && !is_macro(d)) return "a procedure";
  return "a foreign/membrane value";
}

/** `dict?` as an assertion: the teaching door is the validator (see DICT DOOR). */
function requireDict(who: string, d: SchemeValue): asserts d is ADict | AJSObject {
  if (d instanceof ADict || d instanceof AJSObject) return;
  throw new Error(
    `${who}: expected a dict (native {…} / (dict …) record), got ${carrierPhrase(d)} — ${who} guards the dict shape so a wrong-shaped argument fails loudly instead of silently reading nil; use @ for an origin-agnostic read across dict/array/foreign values instead`,
  );
}

export default EnvCapability.define("scheme/polyglot-racket", {
  deps: [polyglotClojure, polyglot, equality, numeric, exceptions, vectors, lists],
  symbols: (symbol, z) => ({
    // ═══════════════════════════════════════════════════════════════════════════
    // THREADING MACROS (Racket ~> ~>>) — aliases expanding to Clojure's -> ->>
    // ═══════════════════════════════════════════════════════════════════════════
    "~>": symbol.defineSyntax`~>: Racket's thread-first — an alias expanding to (-> …)`(
      `(lambda (x . forms) \`(-> ,x ,@forms))`,
      { macroAttribute: "expression" },
    ),
    "~>>": symbol.defineSyntax`~>>: Racket's thread-last — an alias expanding to (->> …)`(
      `(lambda (x . forms) \`(->> ,x ,@forms))`,
      { macroAttribute: "expression" },
    ),

    // ═══════════════════════════════════════════════════════════════════════════
    // RACKET — dict accessor family (Racket's dict library) — grain-completion
    // ═══════════════════════════════════════════════════════════════════════════
    "%dict-guard":
      symbol.native`%dict-guard: the dict? teaching guard shared by the dict-* family — returns d when dict-shaped, else throws the fact+why+action door (private helper)`(
        { input: [z.string, z.schemeValue], output: [z.dict()] },
        function (who, d) {
          requireDict(who.valueOf(), d);
          return d;
        },
      ),
    // Stored nil is a hit (hasMember, not a nil check). Only the first default applies.
    "dict-ref":
      symbol.native`dict-ref: Racket — the value at key in d, or the optional default (nil when absent and no default); keys normalize like @/:key`(
        { input: [z.schemeValue, z.schemeValue], inputRest: z.schemeValue, output: [z.schemeValue] },
        function (d, key, ...rest) {
          requireDict("dict-ref", d);
          if (!hasMember(this, d, key)) return rest[0] ?? nil;
          return readMember(this, d, key);
        },
      ),
    "dict-has-key?": symbol.native`dict-has-key?: Racket — #t iff key resolves in d; a dict-guarded alias of @?`(
      { input: [z.schemeValue, z.schemeValue], output: [z.boolean] },
      function (d, key) {
        requireDict("dict-has-key?", d);
        return schemeBool(hasMember(this, d, key));
      },
    ),
    // A proper list of AString, in member order. @keys is a vector; map/filter need a list.
    "dict-keys": symbol.native`dict-keys: Racket — d's own keys as a proper scheme list, in member order`(
      { input: [z.schemeValue], output: [z.list(z.string)] },
      function (d) {
        requireDict("dict-keys", d);
        return APair.fromArray(
          this.runCtx,
          memberNames(this, d).map((name) => new AString(name)),
          false,
        );
      },
    ),
    "dict-values": symbol.native`dict-values: Racket — the value at each of d's keys, in dict-keys order`(
      { input: [z.schemeValue], output: [z.list()] },
      function (d) {
        requireDict("dict-values", d);
        return maybeThen(memberEntries(this, d), (entries) =>
          APair.fromArray(
            this.runCtx,
            entries.map(([, value]) => value),
            false,
          ),
        );
      },
    ),
    "dict-count": symbol.native`dict-count: Racket — the number of keys in d`(
      { input: [z.schemeValue], output: [z.exact] },
      function (d) {
        requireDict("dict-count", d);
        return mintExact(memberNames(this, d).length, 1, undefined, "dict-count");
      },
    ),
    "dict->alist":
      symbol.native`dict->alist: d's entries as an alist of (key . value) pairs, in dict-keys order — the inverse of alist->dict`(
        { input: [z.schemeValue], output: [z.list(z.pair)] },
        function (d) {
          requireDict("dict->alist", d);
          return maybeThen(memberEntries(this, d), (entries) =>
            APair.fromArray(
              this.runCtx,
              entries.map(([name, value]) => new APair(new AString(name), value)),
              false,
            ),
          );
        },
      ),
    "alist->dict":
      symbol.native`alist->dict: build a dict from an alist of (key . value) pairs — the inverse of dict->alist; keys normalize like dict's own`(
        { input: [z.list(z.pair)], output: [z.dict()] },
        function (alist) {
          const byName = new Map<string, [DictKey, SchemeValue]>();
          for (const entry of to_array("alist->dict")(alist)) {
            if (!(entry instanceof APair)) {
              throw new TypeError("alist->dict: expected a list of pairs");
            }
            const key = asDictKey(entry.car);
            byName.set(foldKeyName(key), [key, entry.cdr]);
          }
          return new ADict([...byName.values()]);
        },
      ),
    // Teaching doors. A native that returned a new dict would read as mutation.
    "dict-set":
      symbol.native`dict-set: a teaching DOOR — dicts are immutable here; build a NEW dict via assoc-in and bind it`(
        { input: [], inputRest: z.schemeValue, output: [z.schemeValue] },
        function () {
          throw new Error(
            "dict-set is not provided — dicts are immutable here, and a 'set' verb implies in-place mutation, which never happens. Build a NEW dict and bind it: (define d2 (assoc-in d (list :key) value)) — the original d is unchanged.",
          );
        },
      ),
    "dict-update":
      symbol.native`dict-update: a teaching DOOR — dicts are immutable here; build a NEW dict via update-in and bind it`(
        { input: [], inputRest: z.schemeValue, output: [z.schemeValue] },
        function () {
          throw new Error(
            "dict-update is not provided — dicts are immutable here, and an 'update' verb implies in-place mutation, which never happens. Build a NEW dict and bind it: (define d2 (update-in d (list :key) updater)) — the original d is unchanged.",
          );
        },
      ),

    // assoc-ref binds dict-ref's own procedure. The door text therefore says dict-ref.
    "assoc-ref": symbol.alias`dict-ref`,
  }),
});
