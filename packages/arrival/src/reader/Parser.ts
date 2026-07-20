/**
 * Lexer token stream → Scheme data — the single text→datum entry point (evaluator,
 * analysis tools, and MCP all read through here).
 *
 * Two gotchas in `_read_object`: reader extensions (the quote family, the `specials`
 * registry) expand at PARSE time, not later; and `_enterNesting` bounds native-stack
 * descent so a pathological input throws `ParseError` instead of a host `RangeError`
 * (see `maxNestingDepth`).
 */
import { DatumReference } from "./DatumReference.js";
// PARSE_CTX family (not CONSTANT_CTX): every node this parser mints carries a
// parse-origin ctx with its SourceLocation — the ctx channel of the span migration.
// For APairs the `setLocation` calls below stay as the derived MIRROR (both channels
// written, same loc), so the `[LOCATION]`-slot readers — the evaluator tap gate,
// scopeId, the cross-package Symbol.for readers — see byte-identical data.
import { makeParseCtx } from "../values/primitives/RunContext.js";
import { foldcase_string } from "./foldcase.js";
import * as specials from "./specials.js";
import { is_nil } from "../eval/guards.js";
import { is_pair } from "../values/value-guards.js";
import {
  is_builtin,
  is_bytevector_literal,
  is_directive,
  is_literal,
  is_special,
  is_symbol_extension,
  is_vector_literal,
} from "./token-guards.js";
import type { EOF } from "../values/primitives/EOF.js";
import { eof } from "../values/primitives/EOF.js";
import { ParseError, type SourceLocation, Unterminated } from "../errors.js";
import { Lexer } from "./Lexer.js";
// These deps form an import cycle with the value/eval modules; ES6 live bindings
// resolve it, since they're referenced only inside methods, not at module-eval time.
import { ABytevector } from "../values/primitives/ABytevector.js";
import { AVector } from "../values/primitives/AVector.js";
import { parse_argument } from "./parsing.js";
import { ctxOf } from "../values/primitives/AValue.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { APair, __tieKnot } from "../values/primitives/APair.js";
import { isUnquoteForm, makeDictLiteralNode, staticDictKey, suffixKeyName } from "./dict-grammar.js";
import type { AList, AListAlike, SchemeValue } from "../values/types.js";
import { ANil } from "../values/primitives/ANil.js";
import { nil } from "../values/primitives/ANil.js";
import invariant from "tiny-invariant";

// Nesting-depth cap: rejects deep input at PARSE time before it overflows the
// native JS stack. `_read_object`/`read_list` recurse one frame per open delimiter,
// so uncapped input throws a host `RangeError` (uncatchable by sandbox `guard`)
// instead of a Scheme `ParseError`. O(1) check — `_state.parentheses` IS the live
// descent depth. Cap sits below the most fragile consumer's overflow floor (a
// recursive evaluator overflows ~3,500) and far above any real s-expression depth.
const maxNestingDepth = 2_000;

export interface TokenMeta {
  token: string;
  col: number;
  offset: number;
  line: number;
}

interface ParserOptions {
  meta?: boolean;
  formatter?: (token: TokenMeta) => TokenMeta;
  /** Source identifier (filename / module path) stamped onto every location this
   *  parser produces — so a throw inside a required module reads as `file:line`. */
  source?: string;
  /** Strict (R7RS-faithful) parse — rejects loose-mode reader tolerances like
   *  `#void`/`#null`. Defaults false (loose), the studio default. */
  strict?: boolean;
}

function defaultFormatter(token: { token: string; col: number; offset: number; line: number }) {
  return token;
}

export class Parser {
  // Re-exported so callers can `instanceof Parser.Unterminated` without importing from ./errors.
  public static readonly Unterminated = Unterminated;

  __lexer__!: Lexer;
  private readonly _formatter!: (token: TokenMeta) => TokenMeta;
  private readonly _meta!: boolean;
  private readonly _source?: string;
  private readonly _strict!: boolean;
  private _refs!: (SchemeValue | Promise<SchemeValue>)[];
  // `parentheses` is the live descent depth (nesting-cap counter); `brackets` is the
  // open-delimiter stack holding each open's EXPECTED close char, so a close must
  // match its opener (strict pairing) — `(` pairs `)`, `{` pairs `}`.
  private readonly _state!: { parentheses: number; brackets: string[]; fold_case: boolean };

  constructor({
    meta = false,
    formatter = defaultFormatter,
    source,
    strict = false,
  }: ParserOptions = {}) {
    Object.defineProperty(this, "_formatter", {
      value: formatter,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(this, "_source", {
      value: source,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(this, "_meta", {
      value: meta,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(this, "_strict", {
      value: strict,
      configurable: true,
      enumerable: false,
    });
    // datum labels
    Object.defineProperty(this, "_refs", {
      value: [],
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(this, "_state", {
      value: {
        parentheses: 0,
        brackets: [],
        fold_case: false,
      },
      configurable: true,
      enumerable: false,
    });
  }

  parse(arg: string | AString) {
    if (arg instanceof AString) {
      arg = arg.toString();
    }
    Object.defineProperty(this, "__lexer__", {
      value: new Lexer(arg),
      configurable: true,
      enumerable: true,
    });
  }

  async peek() {
    let token;
    while (true) {
      token = this.__lexer__.peek(true);
      if (token === eof) {
        return eof;
      }
      if (this.is_comment(token!.token)) {
        this.skip();
        continue;
      }
      if (is_directive(token!.token)) {
        this.skip();
        if (token!.token === "#!fold-case") {
          this._state.fold_case = true;
        } else if (token!.token === "#!no-fold-case") {
          this._state.fold_case = false;
        }
        continue;
      }
      if (token!.token === "#;") {
        this.skip();
        if (this.__lexer__.peek() === eof) throw new Unterminated("syntax error: eof found after comment");
        await this._read_object();
        continue;
      }
      break;
    }
    token = this._formatter(token);
    if (this._state.fold_case) {
      token.token = foldcase_string(token.token);
    }
    if (this._meta) {
      return token;
    }
    return token.token;
  }

  reset() {
    this._refs.length = 0;
    // Each top-level datum starts balanced; clear any descent state a prior throw
    // (e.g. a mismatched bracket) left behind, so stale depth can't leak a false
    // pairing error into the next read.
    this._state.parentheses = 0;
    this._state.brackets.length = 0;
  }

  skip() {
    this.__lexer__.skip();
  }

  _getLocation(): SourceLocation | undefined {
    const meta = this.__lexer__.__token__;
    if (!meta) return undefined;
    return {
      line: meta.line + 1, // 0-indexed → 1-indexed
      col: meta.col,
      offset: meta.offset,
      // Stamped filename for `file:line` frames; undefined for sourceless parses.
      source: this._source,
    };
  }

  async read() {
    const token = await this.peek();
    this.skip();
    return token;
  }

  match_datum_label(token: string) {
    const m = token.match(/^#(\d+)=$/);
    return m?.[1] ?? null;
  }

  match_datum_ref(token: string) {
    const m = token.match(/^#(\d+)#$/);
    return m?.[1] ?? null;
  }

  /**
   * Enter one nesting level. Increments the live descent depth and throws a
   * Scheme-level ParseError if it would exceed the cap — called at every open
   * delimiter (list, vector literal, bytevector literal) BEFORE recursing, so
   * we bail before the native JS stack overflows. See `maxNestingDepth`.
   */
  private _enterNesting(expectedClose: string) {
    this._state.brackets.push(expectedClose);
    if (++this._state.parentheses > maxNestingDepth) {
      throw new ParseError(`input nesting depth exceeded ${maxNestingDepth}`, this._getLocation());
    }
  }

  /**
   * Leave one nesting level on a close delimiter, enforcing STRICT PAIRING: the
   * close must match the char its opener pushed (`(`→`)`, `{`→`}`). A close with
   * an empty stack is unmatched; a close of the wrong type is mismatched. Both
   * throw a ParseError rather than silently rebalancing (the old behaviour, which
   * let `(a]` and a stray `)` through).
   */
  private _exitNesting(closeToken: string, loc?: SourceLocation) {
    const expected = this._state.brackets.pop();
    if (expected === undefined) {
      throw new ParseError(`unexpected '${closeToken}'`, loc ?? undefined, "E-BRACKET-UNEXPECTED");
    }
    if (closeToken !== expected) {
      throw new ParseError(
        `mismatched bracket: expected '${expected}' but found '${closeToken}'`,
        loc ?? undefined,
        "E-BRACKET-MISMATCH",
      );
    }
    --this._state.parentheses;
  }

  // `[` / `]` are NOT interchangeable list delimiters: s-expressions use `(` … `)`
  // only. `[` … `]` is a VECTOR literal and `{` … `}` a DICT literal — see
  // _read_object. (SRFI-105 curly-infix n-expressions are BANNED — R6 — the
  // reader's curly-infix mode was deleted; `{a * b}`-shaped forms door via
  // make_dict_literal's infix-intent heuristic instead of silently misparsing.)
  is_open(token: string) {
    return token === "(";
  }

  is_close(token: string) {
    return token === ")";
  }

  is_curly_open(token: string) {
    return token === "{";
  }

  is_curly_close(token: string) {
    return token === "}";
  }

  async read_list(openLoc?: SourceLocation): Promise<AListAlike> {
    // ACCUMULATE-THEN-CONSTRUCT (readonly-slot contract): collect the elements (+ each cell's
    // location) left-to-right, then build the spine in ONE right fold — no in-place tail
    // append. The improper dot-tail seeds the fold. An element may be a DatumReference
    // placeholder (`#0#` before its label resolves) — reader-internal, patched by
    // `_resolve_pair` via the knot door before any form leaves the reader; the per-cell cast
    // below is that documented channel.
    //
    // `openLoc` (the `(` branch passes it) is the HEAD cell's location — the same value the
    // caller's `setLocation(loc)` re-stamp always produced as the head's FINAL `[LOCATION]`;
    // minting the head's ctx under it directly keeps the immutable ctx channel in exact
    // agreement with the mirror (a ctx can't be overwritten the way the slot could).
    const items: Array<{ node: unknown; loc: ReturnType<Parser["_getLocation"]> }> = [];
    let tail: unknown = nil;
    let dot = false;
    while (true) {
      const token = await this.peek();
      if (token === eof) {
        break;
      }
      if (typeof token === "string" && this.is_close(token)) {
        this._exitNesting(token, this._getLocation());
        this.skip();
        break;
      }
      // Capture location BEFORE reading the object
      const loc = this._getLocation();
      if (token === "." && items.length > 0) {
        this.skip();
        tail = await this._read_object();
        dot = true;
      } else {
        if (dot) throw new ParseError("more than one element after dot", loc ?? undefined, "E-DOT-EXTRA-ELEMENT");
        items.push({ node: await this._read_object(), loc });
      }
    }
    let chain: unknown = tail;
    for (let i = items.length - 1; i >= 0; i--) {
      const loc = (i === 0 ? (openLoc ?? items[i].loc) : items[i].loc);
      const cell = new APair(makeParseCtx(loc), items[i].node as SchemeValue, chain as SchemeValue);
      if (loc) {
        cell.setLocation(loc); // derived mirror — same loc the ctx carries
      }
      chain = cell;
    }
    return chain as AListAlike;
  }

  /**
   * Gather the flat datum sequence between `[`…`]` / `{`…`}`, with POSITION-SCOPED
   * comma separators (the JSON-gravity tolerance).
   *
   * A `,` is a SEPARATOR only where a JSON-writer would emit one: after a complete
   * element (`[1, 2]`), or for maps only after a complete key-value pair (an even
   * boundary — JSON puts `:` between key and value, never `,`). At most one separator
   * per boundary; any other comma reads as R7RS unquote (`{:a ,x}` under quasiquote
   * still works). `,@` is never a separator. One trailing separator before the close
   * is tolerated (`[1, 2,]`).
   *
   * Maps also absorb at most one lone `:` token at an ODD boundary (right after a
   * complete key) — the verbatim-JSON string-key colon `{"a": 1}`. A GLUED `:1` is one
   * keyword token and is NOT absorbed (see `suffixKeyName` in dict-grammar.ts, the
   * suffix-keyword flip).
   */
  private async read_literal_elements(closeToken: string, isMap: boolean, what: string): Promise<SchemeValue[]> {
    const elements: SchemeValue[] = [];
    // Has the current boundary already consumed its one separator comma?
    let separatorConsumed = false;
    // Maps: has the current odd boundary already absorbed its one JSON `:` token?
    let colonConsumed = false;
    while (true) {
      const token = await this.peek();
      if (token === eof) {
        throw new Unterminated(`unterminated ${what} '${isMap ? "{" : "["}'`);
      }
      if (typeof token === "string" && token === closeToken) {
        this._exitNesting(closeToken, this._getLocation());
        this.skip();
        break;
      }
      if (token === ",") {
        // Separator position: something precedes, this boundary hasn't consumed one yet,
        // and (maps) the preceding elements form complete pairs. Otherwise it's unquote —
        // fall through to _read_object, which reads the `,`-prefixed form.
        const separatorPosition = elements.length > 0 && !separatorConsumed && (!isMap || elements.length % 2 === 0);
        if (separatorPosition) {
          separatorConsumed = true;
          this.skip();
          continue;
        }
      }
      if (token === ":" && isMap && elements.length % 2 === 1 && !colonConsumed) {
        // The verbatim-JSON key colon (`{"a": 1}`): one lone `:` token at the odd
        // boundary is absorbed. Anywhere else `:` reads as a plain datum.
        colonConsumed = true;
        this.skip();
        continue;
      }
      if (token === ".") {
        throw new ParseError(`'.' not allowed in a ${what}`, this._getLocation(), "E-LITERAL-DOT");
      }
      const node = await this._read_object();
      if (node === eof) {
        throw new Unterminated(`unterminated ${what} '${isMap ? "{" : "["}'`);
      }
      elements.push(node as SchemeValue);
      separatorConsumed = false;
      colonConsumed = false;
    }
    return elements;
  }

  /**
   * Validate + mint the `{…}` dict-literal node (default `{}` mode). Even arity; keys
   * are `:keyword` / `"string"` / `key:` (fold to the same string key) or an unquote
   * form (validated post quasiquote-substitution); duplicate static keys throw
   * (Clojure-faithful — a model's duplicate is a mistake).
   *
   * SUFFIX-KEYWORD FLIP: a symbol key with a single trailing colon is an explicit
   * declaration and flips to the keyword — `{flight_number: "X"}` ≡ `{:flight_number "X"}`.
   * The flipped key REPLACES the original in the element sequence so every downstream
   * face (code-position `(dict …)` lowering, quasiquote, the quoted-data ADict face)
   * sees one canonical spelling. Bare symbols (`{x 1}`) stay E-DICT-BAD-KEY (could be an
   * intended reference). Key rule is position-scoped: `foo:` outside `{}` stays a plain
   * symbol.
   */
  private make_dict_literal(elements: SchemeValue[], loc: SourceLocation | undefined): SchemeValue {
    // R6 infix-ban door, checked FIRST (before key validation reads its own, less
    // specific, error into the same shape). SRFI-105 n-expressions always flatten to an
    // ODD-length element sequence (k operands + k-1 operators = 2k-1) with a bare
    // SYMBOL sitting in the "operator" slot at index 1 — `{a * b}`, `{a + b + c}`,
    // `{a op b}` for ANY symbol op. Guard against the genuine-dict false positive
    // `{:a foo :b}` (a valid key at index 0, `foo` its VALUE, `:b` a dangling key —
    // odd arity, not infix): only fire when index 0 does NOT look like a key either
    // (`staticDictKey`/`suffixKeyName`/`isUnquoteForm` all reject it), so the shape is
    // "operand operator operand", never "key value key". That combination can never be
    // a legitimate dict (a real one would have a key-shaped element 0), so it's
    // unambiguously stray infix intent or reader-syntax confusion — both deserve this
    // teaching door rather than the generic "bad key" message about `elements[0]`.
    const head = elements[0];
    const headLooksLikeKey =
      suffixKeyName(head) !== null || staticDictKey(head) !== null || isUnquoteForm(head);
    if (elements.length % 2 === 1 && elements.length >= 3 && elements[1] instanceof ASymbol && !headLooksLikeKey) {
      const op = String(elements[1]);
      throw new ParseError(
        `\`{…}\` is a dict literal, not an infix expression — this reader has no curly-infix ` +
          `mode (SRFI-105 n-expressions are not supported here). '${op}' in the middle position ` +
          `looks like an infix operator; if you meant (${op} …), write the s-expression directly. ` +
          `A dict literal needs alternating :keyword/value pairs, e.g. {:a 1 :b 2} — see ` +
          `E-DICT-BAD-KEY/E-DICT-ODD-ARITY below for that grammar. Infix/neoteric syntax ` +
          `(where \`{a * b}\` DOES mean (* a b)) lives in arrival-sugarcoat, not core arrival.`,
        loc,
        "E-DICT-INFIX-BANNED",
      );
    }
    // Key validation runs BEFORE the arity check (covers a trailing unpaired key too):
    // matches the char-incremental order the sampler's Σ mirror judges in — a key token
    // is judged the moment it completes, arity comes after — so `{a:1}` doors as the BAD
    // KEY it is, not as odd arity.
    const seen = new Set<string>();
    for (let i = 0; i < elements.length; i += 2) {
      const suffixKey = suffixKeyName(elements[i]);
      if (suffixKey !== null) {
        // The flip — canonicalize to the keyword twin, keeping the ORIGINAL key token's
        // parse ctx (its exact leaf location), not the dict's `{` location.
        elements[i] = new ASymbol(ctxOf(elements[i]), `:${suffixKey}`);
      }
      const keyDatum = elements[i];
      const key = staticDictKey(keyDatum);
      if (key === null) {
        if (isUnquoteForm(keyDatum)) continue; // quasiquote-substituted key — validated post-substitution
        // Teaching door. The glued JSON form `{a:1}` lexes as ONE symbol token `a:1`
        // (only a space after the colon splits it) — call that shape out explicitly.
        const shown = String(keyDatum);
        const glued = keyDatum instanceof ASymbol && /^[^:\s]+:[^:]/.test(shown);
        throw new ParseError(
          `dict literal key must be a :keyword, a "string", or a name with a trailing colon (name:), ` +
            `got ${shown} — write {:name "Ada"}, {name: "Ada"} or {"name" "Ada"}; ` +
            `for computed keys use (dict …)` +
            (glued ? ` (${shown} is glued — add a space after the colon: {${shown.replace(":", ": ")}})` : ""),
          loc,
          "E-DICT-BAD-KEY",
        );
      }
      if (seen.has(key)) {
        throw new ParseError(
          `duplicate dict literal key :${key} — each key may appear once (:${key} and "${key}" are the same key)`,
          loc,
          "E-DICT-DUP-KEY",
        );
      }
      seen.add(key);
    }
    if (elements.length % 2 !== 0) {
      throw new ParseError(
        `dict literal {…} has ${elements.length} element(s) — expected alternating key value pairs, ` +
          `e.g. {:name "Ada" :age 36} (a key is missing its value)`,
        loc,
        "E-DICT-ODD-ARITY",
      );
    }
    return makeDictLiteralNode(elements, makeParseCtx(loc));
  }

  async read_value(loc?: SourceLocation) {
    const token = await this.read();
    invariant(token !== eof, "Parser: Expected token eof found");
    return parse_argument(token, this._strict, makeParseCtx(loc));
  }

  is_comment(token: string) {
    return token.match(/^;/) || (token.match(/^#\|/) && token.match(/\|#$/));
  }

  // Public entry: reads one datum and resolves any R7RS datum labels (#n=/#n#), marking cycles so a
  // self-referential literal terminates instead of looping during later traversal.
  async read_object(): Promise<SchemeValue | EOF> {
    this.reset();
    const read = await this._read_object();
    // `_read_object` may hand back a reader-internal DatumReference (a `#n#` label);
    // unwrap it to the value it points at. `valueOf()` is `any`, so pin the result
    // to the public datum union here.
    const object: SchemeValue | EOF = read instanceof DatumReference ? read.valueOf() : read;
    if (this._refs.length > 0 && object !== eof) {
      const resolved = await this._resolve_object(object);
      if (resolved instanceof APair) {
        // mark cycles on parser level
        resolved.mark_cycles();
      }
      return resolved;
    }
    return object;
  }

  balanced(): boolean {
    return this._state.parentheses === 0;
  }

  ballancing_error(expr: SchemeValue, prev: SchemeValue): never {
    const count = this._state.parentheses;
    let e: Error & { __code__?: string[] };
    if (count < 0) {
      e = new Error("Parser: unexpected parenthesis");
      e.__code__ = [`${String(prev)})`];
    } else {
      e = new Error("Parser: expected parenthesis but eof found");
      const re = new RegExp(`\\){${count}}$`);
      e.__code__ = [String(expr).replace(re, "")];
    }
    throw e;
  }

  // Resolves nested reader-internal DatumReference placeholders inside a freshly parsed
  // datum. APair is the only structure the reader emits that can carry a nested ref, so
  // it's the sole recursive case; every other SchemeValue is a leaf and passes through
  // (a top-level ref is already unwrapped by read_object before this runs).
  async _resolve_object(object: SchemeValue): Promise<SchemeValue> {
    if (object instanceof APair) {
      return this._resolve_pair(object);
    }
    return object;
  }

  async _resolve_pair(pair: AListAlike): Promise<AListAlike> {
    // Datum-label resolution IS the knot-tying case: `#0=(1 #0#)` closes a cycle no
    // construction order can express, so the placeholder patch goes through the door
    // (one of its three named consumers). Patch-not-recurse on the resolved branch keeps
    // the walk cycle-safe (the resolved value may BE an ancestor of this walk).
    if (pair instanceof APair) {
      if (pair.car instanceof DatumReference) {
        __tieKnot(pair, "car", (await pair.car.valueOf()) as SchemeValue);
      } else if (pair.car instanceof APair) {
        await this._resolve_pair(pair.car);
      }
      if (pair.cdr instanceof DatumReference) {
        __tieKnot(pair, "cdr", (await pair.cdr.valueOf()) as SchemeValue);
      } else if (pair.cdr instanceof APair) {
        await this._resolve_pair(pair.cdr);
      }
    }
    return pair;
  }

  // Internal read of one datum. Broader than the public `read_object` return: this may
  // hand back a reader-internal `DatumReference` (a `#n#` label placeholder) which
  // `read_object` resolves away before exposing the value — so DatumReference is part of
  // this signature but deliberately excluded from the public SchemeValue union.
  async _read_object(): Promise<SchemeValue | EOF | DatumReference> {
    const token = await this.peek();
    if (token === eof) {
      return token;
    }
    const loc = this._getLocation();
    if (is_special(token)) {
      if (is_vector_literal(token)) {
        this.skip();
        this._enterNesting(")");
        const list = await this.read_list();
        // R7RS literals are immutable — AVector itself has no mutation surface
        // (vector-set!/fill! are notImplemented stubs), so no freeze is needed. Shallow
        // cdr-walk collects elements as the honest `SchemeValue[]` the vector holds —
        // `APair.to_array` returns the deliberately-`unknown[]` cons payload, which
        // `AVector` can't accept.
        const items: SchemeValue[] = [];
        for (let node: unknown = list; node instanceof APair; node = node.cdr) {
          items.push(node.car);
        }
        return new AVector(makeParseCtx(loc), items);
      }
      if (is_bytevector_literal(token)) {
        this.skip();
        this._enterNesting(")");
        const list = await this.read_list();
        // Immutable, same rationale as the vector literal case above.
        if (list instanceof ANil) {
          return new ABytevector(makeParseCtx(loc), new Uint8Array(0));
        }
        const arr = list.to_array(false) as number[];
        return new ABytevector(
          makeParseCtx(loc),
          new Uint8Array(arr.map((v) => (typeof v === "number" ? v : Number(v)))),
        );
      }
      // A parser extension is a symbol that expands at read time, in one of two
      // ways: a FUNCTION extension is applied FEXPR-style (result returned as-is);
      // a MACRO extension is evaluated in place and its result quoted (see below).
      const special = specials.get(token);
      const builtin = is_builtin(token);
      this.skip();
      let expr: any;
      const is_symbol = is_symbol_extension(token);
      // A quote-family prefix dangling against a close delimiter (e.g. the trailing-
      // unquote `{:a ,}`, or `')`) is a MISSING DATUM — door it here, BEFORE the datum
      // read, or the stray-close machinery throws its less-teaching error first. Any
      // close counts, not just `)` (the literals brought `]`/`}` into datum position).
      const peeked = await this.peek();
      const was_close = typeof peeked === "string" && [")", "]", "}"].includes(peeked);
      if (was_close && is_literal(token)) {
        throw new ParseError(`Parse Error: expecting datum after '${token}'`, loc ?? undefined, "E-EXPECTING-DATUM");
      }
      const object = is_symbol ? undefined : await this._read_object();
      if (object === eof) {
        throw new Unterminated("Expecting expression, eof found");
      }
      // Every registered special is BUILTIN reader syntax (quote/quasiquote/unquote, #(...),
      // #u8(...)) expanding into a list the interpreter evaluates later — no user-registered
      // reader macros exist (that would require evaluating at parse time).
      invariant(builtin, () => `Parse Error: non-builtin reader extension ${special.symbol} is unsupported`);
      // `object` may still be a DatumReference placeholder here — the reader-internal
      // channel `_resolve_pair` patches before the form leaves the reader.
      if (is_literal(token)) {
        expr = new APair(makeParseCtx(loc), special.symbol, new APair(makeParseCtx(loc), object as SchemeValue, nil));
        if (loc) expr.setLocation(loc); // mirror — inner cell rides the ctx channel only (no LOCATION-slot change)
      } else {
        expr = new APair(makeParseCtx(loc), special.symbol, object as SchemeValue);
        if (loc) expr.setLocation(loc); // mirror
      }
      return expr;
    }
    const ref = this.match_datum_ref(token);
    if (ref !== null) {
      this.skip();
      invariant((+ref) in this._refs, `Parse Error: invalid datum label #${ref}#`);
      return new DatumReference(ref, this._refs[+ref] as SchemeValue);
    }
    const ref_label = this.match_datum_label(token);
    if (ref_label !== null) {
      this.skip();
      this._refs[+ref_label] = this._read_object() as SchemeValue | Promise<SchemeValue>;
      return this._refs[+ref_label] as SchemeValue | Promise<SchemeValue>;
    } else if (token === "[") {
      // `[…]` VECTOR literal (Clojure/JSON array shape). The node is an immutable AVector
      // (a parsed literal is shared AST — quote hands it out as immutable data, like
      // `#(…)`) carrying `evalElements`: in code position the evaluator evaluates the
      // elements (lowering to `(vector …)` — see evaluator.ts), unlike the R7RS
      // constant `#(…)`. NOT an interchangeable list delimiter: `(a b]` stays an error.
      this._enterNesting("]");
      this.skip();
      const elements = await this.read_literal_elements("]", false, "vector literal");
      const vec = new AVector(makeParseCtx(loc), elements);
      vec.evalElements = true;
      return vec;
    } else if (token === "]") {
      // A stray/mismatched `]` (read_literal_elements consumes its own close). Always
      // throws — same contract as the `}` / `)` stray-close branches below.
      this._exitNesting(token, loc ?? undefined);
    } else if (this.is_curly_open(token)) {
      this._enterNesting("}");
      this.skip();
      // `{…}` DICT literal (the ONLY `{}` grammar — R6: the reader's curly-infix mode
      // is deleted; there is no flag that reads `{}` any other way): `{:k v …}` ≡
      // `(dict :k v …)` in code position; data under quote. See read_literal_elements
      // (comma rule) / make_dict_literal (key doors, including the infix-intent ban).
      const elements = await this.read_literal_elements("}", true, "dict literal");
      return this.make_dict_literal(elements, loc ?? undefined);
    } else if (this.is_curly_close(token)) {
      // Stray/mismatched `}` (read_literal_elements consumes its own close) — e.g. a `}`
      // inside a `(` list. _exitNesting always throws here; the post-chain throw below
      // makes the non-return explicit for the type checker.
      this._exitNesting(token, loc ?? undefined);
    } else if (this.is_close(token)) {
      // Stray/mismatched `)` — e.g. a `)` inside `{…}`, or a top-level close with
      // nothing open. Strict pairing rejects it; _exitNesting throws here too.
      this._exitNesting(token, loc ?? undefined);
    } else if (this.is_open(token)) {
      this._enterNesting(")");
      this.skip();
      const list = await this.read_list(loc);
      if (loc && list instanceof APair) {
        list.setLocation(loc); // mirror re-stamp — same loc the head cell's ctx already carries
      }
      return list;
    } else {
      // Leaf literals (symbol/string/number/char): `loc` — computed above for this very
      // token — finally has somewhere to go. These classes have no location slot; the
      // parse ctx is their FIRST source identity (the ~18-site PARSE-CTX-CANDIDATE set).
      return this.read_value(loc);
    }
    // Unreachable for a well-formed token: every value-producing case above returns and
    // the two stray-close cases throw via _exitNesting. Kept as an explicit terminal so
    // the function is total without widening the return type to include `undefined`.
    throw new ParseError(`unexpected token '${token}'`, loc ?? undefined);
  }
}
