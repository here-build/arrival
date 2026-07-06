/**
 * The reader's second stage: the Lexer's token stream → Scheme data, and the single text→datum entry
 * point (evaluator, analysis tools, and MCP all read through here).
 *
 * Two non-obvious things in `_read_object`: reader extensions (the quote family, the `specials`
 * registry) are evaluated at PARSE time, not later; and `_enterNesting` bounds native-stack descent so
 * a pathological input fails with a `ParseError` instead of a host `RangeError` (see the war story
 * below). Structure inspired by BiwaScheme's parser.
 */
import { DatumReference } from "../values/DatumReference.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { foldcase_string } from "./foldcase.js";
import * as specials from "./specials.js";
import { is_nil, is_pair } from "../eval/guards.js";
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
import { parse_argument } from "../utils/parsing.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { APair } from "../values/primitives/APair.js";
import { canonicalizeCurly } from "./curly-infix.js";
import { isUnquoteForm, makeDictLiteralNode, staticDictKey, suffixKeyName } from "../values/dict-literal.js";
import type { SchemeValue } from "../values/types.js";
import { ANil } from "../values/primitives/ANil.js";
import { nil } from "../values/primitives/ANil.js";
import invariant from "tiny-invariant";

// Nesting-depth cap — rejects a deeply-nested input at PARSE time before it can
// overflow the native JS stack. `_read_object`/`read_list` recurse one real frame
// per open delimiter, so without this a pathological input throws a host
// `RangeError` (uncatchable by sandbox `guard`) instead of a Scheme `ParseError`.
// The check is O(1): `_state.parentheses` already IS the live descent depth. The
// cap sits below the most fragile downstream consumer's overflow floor (a recursive
// evaluator overflows ~3,500) and far above any real s-expression depth.
let maxNestingDepth = 2_000;

/** Current parser nesting-depth cap (open delimiters before a ParseError). */
export function getMaxNestingDepth(): number {
  return maxNestingDepth;
}

/**
 * Override the parser nesting-depth cap. `Infinity` disables it (trusted input
 * only — re-exposes the native-stack-overflow vector). Must be a positive
 * number.
 */
export function setMaxNestingDepth(depth: number): void {
  invariant(
    typeof depth === "number" && !Number.isNaN(depth) && depth > 0,
    `setMaxNestingDepth: expected a positive number, got ${depth}`,
  );
  maxNestingDepth = depth;
}

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
  /** SRFI-105 curly-infix `{a + b}` → `(+ a b)` (the pre-2026-07 default). Defaults
   *  false: `{…}` reads as a DICT literal (≡ `(dict :k v …)`) and `[…]` as a vector
   *  literal — the Clojure/JSON shapes models emit. Mutually exclusive on the `{}`
   *  delimiter; `[…]` reads as a vector literal in BOTH modes. */
  curlyInfix?: boolean;
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
  private readonly _curlyInfix!: boolean;
  private _refs!: (SchemeValue | Promise<SchemeValue>)[];
  // `parentheses` is the live descent depth (the nesting-cap counter); `brackets`
  // is the typed open-delimiter stack holding each open's EXPECTED close char, so
  // a close must match its opener (strict pairing) — `(` pairs `)`, `{` pairs `}`.
  private readonly _state!: { parentheses: number; brackets: string[]; fold_case: boolean };

  constructor({
    meta = false,
    formatter = defaultFormatter,
    source,
    strict = false,
    curlyInfix = false,
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
    Object.defineProperty(this, "_curlyInfix", {
      value: curlyInfix,
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
        invariant(this.__lexer__.peek() !== eof, "Lexer: syntax error eof found after comment");
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
      line: meta.line + 1, // Convert 0-indexed to 1-indexed
      col: meta.col,
      offset: meta.offset,
      // `source` (this parser's filename/module path) makes frames read as
      // `file:line`; undefined for sourceless parses (the bare REPL/entry).
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
  // only. `[` … `]` is a VECTOR literal and `{` … `}` a DICT literal (or SRFI-105
  // curly-infix under the opt-in `curlyInfix` flag) — see _read_object.
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

  async read_list(): Promise<APair | ANil> {
    let head: APair | typeof nil = nil;
    let prev: APair | typeof nil = head;
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
      if (token === "." && !(head instanceof ANil)) {
        this.skip();
        (prev as APair).cdr = await this._read_object();
        dot = true;
      } else {
        invariant(!dot, "Parser: syntax error more than one element after dot");
        const node = await this._read_object();
        const cur = new APair(CONSTANT_CTX, node, nil);
        if (loc) {
          cur.setLocation(loc);
        }
        if (head instanceof ANil) {
          head = cur;
        } else {
          (prev as APair).cdr = cur;
        }
        prev = cur;
      }
    }
    return head;
  }

  /**
   * Collection-literal element reader: gather the flat datum sequence between `[`…`]` /
   * `{`…`}` with POSITION-SCOPED comma separators (the JSON-gravity tolerance; see
   * docs/working-proposals/arrival-curly-vector-literals.md "Commas and keys").
   *
   * A `,` is consumed as a SEPARATOR only where a JSON-writer would emit one —
   * immediately after a complete element (`[1, 2]`), and for maps only after a complete
   * key-value PAIR (an even boundary; JSON puts `:` between key and value, never `,`).
   * At most one separator per boundary; every other comma reads as R7RS unquote
   * (`{:a ,x}` under quasiquote keeps working). `,@` is never a separator. One trailing
   * separator before the close is tolerated (`[1, 2,]`, JS gravity).
   *
   * Maps additionally absorb at most ONE lone `:` token at an ODD boundary (immediately
   * after a complete key) — the verbatim-JSON string-key colon `{"a": 1}` (the lexer
   * emits a clean separate `:` token there; a GLUED `:1` is one keyword token and is NOT
   * absorbed — see the spec's flip section).
   */
  private async read_literal_elements(closeToken: string, isMap: boolean, what: string): Promise<SchemeValue[]> {
    const elements: SchemeValue[] = [];
    // Whether the CURRENT boundary already consumed its one separator comma.
    let separatorConsumed = false;
    // Maps: whether the CURRENT odd boundary already absorbed its one JSON `:` token.
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
        // Separator position: something precedes, this boundary hasn't consumed one,
        // and (maps) the preceding elements form complete pairs. Otherwise the comma
        // is unquote — fall through to _read_object, which reads the `,`-prefixed form.
        const separatorPosition =
          elements.length > 0 && !separatorConsumed && (!isMap || elements.length % 2 === 0);
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
   * Validate + mint the `{…}` dict-literal node (default `{}` mode). Doors, phrased for
   * model recovery: even arity; keys are `:keyword` / `"string"` / `key:` (all fold to
   * the same string key) or an unquote form (quasiquote-substituted, validated
   * post-substitution); duplicate static keys are loud (Clojure-faithful — a model's
   * duplicate is a mistake).
   *
   * THE SUFFIX-KEYWORD FLIP (spec: "The suffix-keyword flip"): a symbol key with a
   * single trailing colon is an EXPLICIT declaration and flips to the keyword —
   * `{flight_number: "X"}` ≡ `{:flight_number "X"}`. The flipped key is REPLACED in the
   * element sequence by its `:keyword` twin so every downstream face (code-position
   * `(dict …)` lowering, quasiquote processing, the quoted-data AJSObject face) sees the
   * one canonical spelling. Bare symbols (`{x 1}`) stay E-DICT-BAD-KEY — no commitment
   * marker, could be an intended reference. Position-scoped: this is a dict-literal KEY
   * rule, not a lexer change (`foo:` outside `{}` stays a plain symbol).
   */
  private make_dict_literal(elements: SchemeValue[], loc: SourceLocation | undefined): SchemeValue {
    // Key validation runs BEFORE the arity check (and covers a trailing unpaired key):
    // this matches the char-incremental order the sampler's Σ mirror necessarily judges
    // in — a key token is judged the moment it completes, the close's arity check comes
    // after — so `{a:1}` doors as the BAD KEY it is, not as odd arity.
    const seen = new Set<string>();
    for (let i = 0; i < elements.length; i += 2) {
      const suffixKey = suffixKeyName(elements[i]);
      if (suffixKey !== null) {
        elements[i] = new ASymbol(CONSTANT_CTX, `:${suffixKey}`); // the flip — canonicalize to the keyword twin
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
    return makeDictLiteralNode(elements);
  }

  // SRFI-105 curly-infix: gather the flat datum sequence between `{` and `}` (the transform to a
  // canonical s-expr happens in canonicalizeCurly). Mirrors read_list's loop but collects a JS array
  // and stops on `}`; `_read_object` recursion handles nested `{…}`/`(…)`/quotes for free.
  // Reached ONLY under the opt-in `curlyInfix` flag (kept verbatim: no comma-separator logic here —
  // in infix mode a `,` reads as unquote, exactly the pre-flag behavior).
  async read_curly_elements(): Promise<SchemeValue[]> {
    const elements: SchemeValue[] = [];
    while (true) {
      const token = await this.peek();
      if (token === eof) {
        throw new Unterminated("unterminated curly-infix '{'");
      }
      if (typeof token === "string" && this.is_curly_close(token)) {
        this._exitNesting(token, this._getLocation());
        this.skip();
        break;
      }
      if (token === ".") {
        throw new ParseError("'.' not allowed in curly-infix", this._getLocation());
      }
      const node = await this._read_object();
      if (node === eof) {
        throw new Unterminated("unterminated curly-infix '{'");
      }
      elements.push(node as SchemeValue);
    }
    return elements;
  }

  async read_value() {
    const token = await this.read();
    invariant(token !== eof, "Parser: Expected token eof found");
    return parse_argument(token, this._strict);
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
      // The method is async, so awaiting the resolver is the direct equivalent of the
      // former `unpromise` then-callback (`_resolve_object` always returns a Promise).
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

  // Resolves any nested reader-internal DatumReference placeholders inside a freshly
  // parsed datum. The only structure the reader emits that can carry a nested ref is an
  // APair, so that is the sole recursive case; every other SchemeValue is a leaf and
  // passes through. (A top-level ref is already unwrapped by read_object before this
  // runs.) The former raw-array / plain-object branches were LIPS-era dead code — the
  // reader no longer emits bare JS containers, so under the SchemeValue union they were
  // both unreachable and type-incoherent (they built `SchemeValue[]` / `Record<…>`
  // values that are not SchemeValue); removed rather than hardened with a cast.
  async _resolve_object(object: SchemeValue): Promise<SchemeValue> {
    if (object instanceof APair) {
      return this._resolve_pair(object);
    }
    return object;
  }

  async _resolve_pair(pair: APair): Promise<APair> {
    if (pair instanceof APair) {
      if (pair.car instanceof DatumReference) {
        pair.car = await pair.car.valueOf();
      } else if (pair.car instanceof APair) {
        await this._resolve_pair(pair.car);
      }
      if (pair.cdr instanceof DatumReference) {
        pair.cdr = await pair.cdr.valueOf();
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
    // Capture location early for all constructs
    const loc = this._getLocation();
    if (is_special(token)) {
      // Handle vector literals #(...) specially
      if (is_vector_literal(token)) {
        this.skip();
        this._enterNesting(")");
        const list = await this.read_list();
        // Convert list to a boxed vector (#(...) literal producer). R7RS literals
        // are immutable → freeze, so a later vector-set!/fill! on the literal is
        // an error (else it would corrupt the shared parsed AST node persistently).
        // Shallow cdr-walk (the `list->vector` builtin's idiom) collects the elements
        // as the honest `SchemeValue[]` the vector holds — `APair.to_array` returns
        // the deliberately-`unknown[]` cons payload, which `AVector` can't accept.
        const items: SchemeValue[] = [];
        for (let node: unknown = list; node instanceof APair; node = node.cdr) {
          items.push(node.car);
        }
        const litVec = new AVector(CONSTANT_CTX, items);
        litVec.freeze();
        return litVec;
      }
      // Handle bytevector literals #u8(...) specially
      if (is_bytevector_literal(token)) {
        this.skip();
        this._enterNesting(")");
        const list = await this.read_list();
        // Convert list to a boxed bytevector (#u8(...) literal producer). R7RS
        // literals are immutable → freeze (see the #(...) case above).
        let litBv: ABytevector;
        if (list instanceof ANil) {
          litBv = new ABytevector(CONSTANT_CTX, new Uint8Array(0));
        } else {
          const arr = list.to_array(false) as number[];
          litBv = new ABytevector(
            CONSTANT_CTX,
            new Uint8Array(arr.map((v) => (typeof v === "number" ? v : Number(v)))),
          );
        }
        litBv.freeze();
        return litBv;
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
      // Every registered special is BUILTIN reader syntax (quote/quasiquote/unquote prefixes, #(...),
      // #u8(...)) — it expands into a list the interpreter evaluates later. LIPS user-registered reader
      // macros (expanded by EVALUATING at parse time) were removed: nothing registered one, and that
      // read-time evaluator call was the ONLY reason the reader imported the evaluator — the cycle that
      // forced exec to dynamically import("stdlib") under the vestigial `lips` handle to break it.
      invariant(builtin, () => `Parse Error: non-builtin reader extension ${special.symbol} is unsupported`);
      if (is_literal(token)) {
        expr = new APair(CONSTANT_CTX, special.symbol, new APair(CONSTANT_CTX, object, nil));
        if (loc) expr.setLocation(loc);
      } else {
        expr = new APair(CONSTANT_CTX, special.symbol, object);
        if (loc) expr.setLocation(loc);
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
      // `[…]` VECTOR literal (Clojure/JSON array shape). The node is a frozen AVector
      // (a parsed literal is shared AST — quote hands it out as immutable data, like
      // `#(…)`) carrying `evalElements`: in code position the evaluator evaluates the
      // elements (lowering to `(vector …)` — see evaluator.ts), unlike the R7RS
      // constant `#(…)`. NOT an interchangeable list delimiter: `(a b]` stays an error.
      this._enterNesting("]");
      this.skip();
      const elements = await this.read_literal_elements("]", false, "vector literal");
      const vec = new AVector(CONSTANT_CTX, elements);
      vec.evalElements = true;
      vec.freeze();
      return vec;
    } else if (token === "]") {
      // A stray/mismatched `]` (read_literal_elements consumes its own close). Always
      // throws — same contract as the `}` / `)` stray-close branches below.
      this._exitNesting(token, loc ?? undefined);
    } else if (this.is_curly_open(token)) {
      this._enterNesting("}");
      this.skip();
      if (this._curlyInfix) {
        // Opt-in SRFI-105 curly-infix — the pre-2026-07 default, verbatim.
        const elements = await this.read_curly_elements();
        const datum = canonicalizeCurly(elements, loc);
        if (loc && datum instanceof APair) {
          datum.setLocation(loc);
        }
        return datum;
      }
      // `{…}` DICT literal (default): `{:k v …}` ≡ `(dict :k v …)` in code position;
      // data under quote. See read_literal_elements (comma rule) / make_dict_literal
      // (key doors) and docs/working-proposals/arrival-curly-vector-literals.md.
      const elements = await this.read_literal_elements("}", true, "dict literal");
      return this.make_dict_literal(elements, loc ?? undefined);
    } else if (this.is_curly_close(token)) {
      // a stray/mismatched `}` (read_curly_elements consumes its OWN close);
      // _exitNesting reports the mismatch — e.g. a `}` inside a `(` list — or the
      // unmatched close. It always throws on this path (the close is unmatched here),
      // so this branch never produces a datum; the post-chain throw below makes that
      // non-return explicit for the type checker.
      this._exitNesting(token, loc ?? undefined);
    } else if (this.is_close(token)) {
      // a stray/mismatched `)` — e.g. a `)` inside `{…}`, or a top-level close
      // with nothing open. Strict pairing rejects it (the old code silently
      // rebalanced and returned nothing). Like the `}` case, _exitNesting throws here.
      this._exitNesting(token, loc ?? undefined);
    } else if (this.is_open(token)) {
      this._enterNesting(")");
      this.skip();
      const list = await this.read_list();
      if (loc && list instanceof APair) {
        list.setLocation(loc);
      }
      return list;
    } else {
      return this.read_value();
    }
    // Unreachable for a well-formed token: every value-producing case above returns and
    // the two stray-close cases throw via _exitNesting. Kept as an explicit terminal so
    // the function is total without widening the return type to include `undefined`.
    throw new ParseError(`unexpected token '${token}'`, loc ?? undefined);
  }
}
