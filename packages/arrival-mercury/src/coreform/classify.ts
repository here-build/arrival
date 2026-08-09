/**
 * classify() — desugared parse forest → CoreForm IR.
 *
 * One classification pass (coreform-ir.md §1): tags heads, mints dense pre-order
 * node ids, carries spans/comments forward, and doors what it can't place. It
 * never rewrites sugar (desugar already ran) and never invents structure the
 * parse tree didn't have. Total — never throws: every malformed/unsupported
 * shape becomes a LOCAL Door (collect-all, not fail-fast; errors-as-doors
 * Rule 0/2), and everything around it classifies normally.
 *
 * Discipline (spec §4.2, the Roslyn rule): every record constructed here gets an
 * id from one per-call monotonic counter in a fixed pre-order, left-to-right,
 * source-order walk; nodes are never mutated after construction; malformed shapes
 * are validated on the RAW nodes before any child id is minted, so a doored
 * subtree never leaves orphan ids behind (determinism feeds constitution §8's
 * compile-twice byte-compare gate).
 */
import { type Atom, isAtom, isBool, isKeyword, isList, isNumber, keywordName, type Node } from "../front/nodes.js";
import type {
  Base,
  Binding,
  ClassifyResult,
  CoreForm,
  Door,
  DoorCategory,
  KwEntry,
  LetKind,
  Lit,
  NodeId,
  Param,
  QuoteDatum,
  Span,
} from "./types.js";

/** Fallback span for a (pathological) spanless top-level form — desugar can synthesize
 *  a bare atom replacement (e.g. `(cond)` → `undefined`) that `withSpan` passes through
 *  without a span. Every real parsed node carries one (spec §4.3). */
const ZERO_SPAN: Span = [0, 0];

/** Forms banned at the language level (constitution §2.2 — immutability/no-dynamics):
 *  mutation and re-entrant control are incompatible with non-exponential provenance.
 *  These door as `prohibited-dynamics` at classify time, in ANY position — the door is
 *  syntactic, so even an untaken branch doors. Linear-update `!` procedures beyond the
 *  explicitly named set are registry-known and pick up the same category downstream at
 *  emit time (spec §6's doored-symbol note). */
const PROHIBITED_DYNAMICS: ReadonlySet<string> = new Set([
  "set!",
  "set-car!",
  "set-cdr!",
  "vector-set!",
  "string-set!",
  "call/cc",
  "call-with-current-continuation",
  "dynamic-wind",
]);

const prohibitedMessage = (name: string): string =>
  `\`${name}\` is prohibited by design: arrival-scheme is immutable and no-dynamics — ` +
  `mutation and re-entrant control are incompatible with non-exponential provenance ` +
  `(a mutable cell's lineage becomes writers × readers; a re-entrant continuation makes ` +
  `the provenance DAG unbounded). This is a permanent language law (constitution §2.2), ` +
  `not a backlog gap — restructure with immutable bindings and plain data flow.`;

/** `call/cc` → `call-cc`: a slug never contains `/` (it would read as nested namespacing
 *  under the `"<category>/<slug>"` code convention). */
const slugOf = (name: string): string => name.replaceAll("/", "-");

/** Special-form-like heads this compiler does not support, by scope decision.
 *  Recognized at classify time because their shapes would otherwise silently
 *  misclassify as nonsensical `App`s (the spec's §4.14 "successful-but-nonsensical"
 *  hazard). Each carries its own code so a door-scan can tell which is hit. */
const UNSUPPORTED_HEADS: ReadonlyMap<string, string> = new Map([
  ["quasiquote", "quasiquote is not supported — build the structure with `list`/`cons`/`append`/`dict` instead."],
  ["unquote", "unquote outside quasiquote is not supported (and quasiquote itself is unsupported)."],
  ["unquote-splicing", "unquote-splicing outside quasiquote is not supported (and quasiquote itself is unsupported)."],
  ["case", "`case` is not desugared yet — rewrite as `cond` with explicit `equal?` tests."],
  [
    "do",
    "`do` loops are outside the v1 CoreForm surface (constitution §3.2) — rewrite as a named `let` loop.",
  ],
]);

const DATUM_LABEL_RE = /^#\d+[=#]$/;

/** Decode a scheme string literal's escapes to runtime chars — the parser stores them
 *  raw (`\n` as backslash+n). Same table as the emitters this pass replaces (spec §4.13
 *  deletes that duplication by decoding ONCE, here). */
const decodeSchemeString = (raw: string): string =>
  raw.replaceAll(/\\(.)/gs, (_m, c: string) => {
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "0":
        return "\0";
      default:
        return c; // \\ \" and any other escaped char → the char itself
    }
  });

/** Non-narrowing keyword test for an already-`Atom` value (the imported `isKeyword` is a
 *  Node→Atom type GUARD; a negated guard on an Atom-typed value collapses it to `never`). */
const isKeywordAtom = (a: Atom): boolean => !a.str && a.atom.length > 1 && a.atom.startsWith(":");

/** Non-narrowing plain-symbol test for an already-`Atom` value. */
const isPlainAtom = (a: Atom): boolean =>
  !a.str && !isBool(a) && !isNumber(a) && !isKeywordAtom(a) && a.atom !== "." && !a.atom.startsWith("#");

/** A plain symbol atom — the only shape a binding/parameter/loop name may take. */
const isPlainSymbol = (n: Node | undefined): n is Atom => isAtom(n) && isPlainAtom(n);

const isDotAtom = (n: Node | undefined): boolean => isAtom(n) && !n.str && n.atom === ".";

/** Precondition: `forest` has already been through desugar() (spec §4.1).
 *  Total — never throws. Every malformed/unsupported shape becomes a local Door;
 *  everything around it classifies normally (collect-all, not fail-fast). */
export function classify(forest: readonly Node[]): ClassifyResult {
  let next = 0;
  const originAtom = new Map<NodeId, Atom>();
  const parentOf = new Map<NodeId, NodeId>();
  const doors: NodeId[] = [];

  const mint = (parent: NodeId | undefined): NodeId => {
    const id = next++ as NodeId;
    if (parent !== undefined) parentOf.set(id, parent);
    return id;
  };

  /** Base fields for a node minted from a real parse node (comments ride along)
   *  or a synthesized filler (`from` undefined → span inherited, no comments). */
  const baseFor = (parent: NodeId | undefined, from: Node | undefined, encl: Span): Base => {
    const id = mint(parent);
    const span = from?.span ?? encl;
    const base: { id: NodeId; span: Span; lead?: readonly string[]; trail?: readonly string[] } = { id, span };
    if (from?.lead !== undefined && from.lead.length > 0) base.lead = from.lead;
    if (from?.trail !== undefined && from.trail.length > 0) base.trail = from.trail;
    return base;
  };

  const makeDoor = (
    parent: NodeId | undefined,
    from: Node | undefined,
    span: Span,
    category: DoorCategory,
    slug: string,
    message: string,
  ): Door => {
    const base = baseFor(parent, from, span);
    const door: Door = { ...base, span, kind: "Door", category, code: `${category}/${slug}`, message };
    doors.push(door.id);
    return door;
  };

  /** Classification-synthesized filler (elided else / elided binding init) — inherits
   *  the nearest enclosing real node's span (spec §4.3), never spanless. */
  const undefinedLit = (parent: NodeId, encl: Span): Lit => ({
    ...baseFor(parent, undefined, encl),
    kind: "Lit",
    value: { kind: "undefined" },
  });

  // ── atoms ────────────────────────────────────────────────────────────────────

  const classifyAtom = (a: Atom, parent: NodeId | undefined, encl: Span): CoreForm => {
    const span = a.span ?? encl;
    if (a.str) return { ...baseFor(parent, a, encl), kind: "Lit", value: { kind: "string", value: decodeSchemeString(a.atom) } };
    if (isBool(a)) return { ...baseFor(parent, a, encl), kind: "Lit", value: { kind: "boolean", value: a.atom === "#t" } };
    if (isNumber(a)) return { ...baseFor(parent, a, encl), kind: "Lit", value: { kind: "number", text: a.atom } };
    if (isKeywordAtom(a))
      return { ...baseFor(parent, a, encl), kind: "Lit", value: { kind: "keyword", name: keywordName(a) } };
    if (a.atom === ".")
      return makeDoor(
        parent,
        a,
        span,
        "malformed-source",
        "dotted-form",
        "a bare `.` is only meaningful as the dotted tail of a quoted datum or a rest-parameter marker.",
      );
    if (a.atom.startsWith("#")) {
      // Compile-front hash surface: the copied parser cannot produce datum labels as a
      // construct — `#0=(…)` tokenizes as the stray atom `#0=` followed by a separate
      // list — so the label ATOM shape doors here (the constitution §2.2 compile-front
      // check: no datum labels in compiled inputs).
      if (DATUM_LABEL_RE.test(a.atom))
        return makeDoor(
          parent,
          a,
          span,
          "unsupported-form",
          "datum-label",
          "reader datum labels (`#0=` / `#0#`) are not part of the compiled surface — cyclic construction is interpreter-only.",
        );
      if (a.atom.startsWith("#\\"))
        return makeDoor(
          parent,
          a,
          span,
          "unsupported-form",
          "char-literal",
          "character literals are not part of the compiled surface — use a one-character string instead.",
        );
      return makeDoor(
        parent,
        a,
        span,
        "unsupported-form",
        "hash-syntax",
        `\`${a.atom}\` hash syntax is not part of the compiled surface (only \`#t\`/\`#f\` booleans are).`,
      );
    }
    if (PROHIBITED_DYNAMICS.has(a.atom))
      return makeDoor(parent, a, span, "prohibited-dynamics", slugOf(a.atom), prohibitedMessage(a.atom));
    const base = baseFor(parent, a, encl);
    originAtom.set(base.id, a);
    return { ...base, kind: "Ref", name: a.atom };
  };

  // ── quoted data (a mirror walk — never re-enters CoreForm classification) ────

  type DatumErr = { span: Span; category: DoorCategory; slug: string; message: string };
  type DatumOut = { ok: QuoteDatum } | { err: DatumErr };

  const atomDatum = (a: Atom, encl: Span): DatumOut => {
    const span = a.span ?? encl;
    if (a.str) return { ok: { kind: "string", value: decodeSchemeString(a.atom) } };
    if (isBool(a)) return { ok: { kind: "boolean", value: a.atom === "#t" } };
    if (isNumber(a)) return { ok: { kind: "number", text: a.atom } };
    if (a.atom === ".")
      return {
        err: {
          span,
          category: "malformed-source",
          slug: "dotted-datum",
          message: "a `.` in quoted data is only legal as the single dotted-tail marker in penultimate position.",
        },
      };
    if (a.atom.startsWith("#") && !isBool(a)) {
      if (DATUM_LABEL_RE.test(a.atom))
        return {
          err: {
            span,
            category: "unsupported-form",
            slug: "datum-label",
            message: "reader datum labels (`#0=` / `#0#`) are not part of the compiled surface — cyclic data is interpreter-only.",
          },
        };
      if (a.atom.startsWith("#\\"))
        return {
          err: {
            span,
            category: "unsupported-form",
            slug: "char-literal",
            message: "character literals are not part of the compiled surface — use a one-character string instead.",
          },
        };
      return {
        err: {
          span,
          category: "unsupported-form",
          slug: "hash-syntax",
          message: `\`${a.atom}\` hash syntax is not part of the compiled surface (only \`#t\`/\`#f\` booleans are).`,
        },
      };
    }
    return { ok: { kind: "symbol", name: a.atom } }; // keywords stay raw, inert text
  };

  /** Dotted pairs FOLD HERE, at classify time (⚖️ ruled — constitution §2.1: lists,
   *  pairs, and vectors all lower to arrays; the membrane's one-way fold). A list
   *  datum whose penultimate item is the bare `.`:
   *    - atom tail  → the tail folds in as the last element   ('(1 . 2)  ≡ '(1 2))
   *    - list tail  → the tail SPLICES ('(1 . (2 3)) IS the datum (1 2 3) — reader
   *      semantics; folding it in as one element would diverge from the interpreter,
   *      which never sees a "dotted pair with list tail" as a distinct value)
   *  QuoteDatum therefore never contains a bare-dot item. A `.` anywhere else is a
   *  malformed datum. */
  const listDatum = (items: readonly Node[], encl: Span): DatumOut => {
    const dotIdx = items.findIndex(isDotAtom);
    let front: readonly Node[] = items;
    let tail: Node | undefined;
    if (dotIdx !== -1) {
      const last = items[items.length - 1];
      const valid = dotIdx === items.length - 2 && items.length >= 3 && !isDotAtom(last);
      if (!valid) {
        const dot = items[dotIdx]!;
        return {
          err: {
            span: dot.span ?? encl,
            category: "malformed-source",
            slug: "dotted-datum",
            message: "malformed dotted datum: `.` must appear exactly once, in penultimate position, with a head of at least one item.",
          },
        };
      }
      front = items.slice(0, dotIdx);
      tail = last;
    }
    const out: QuoteDatum[] = [];
    for (const item of front) {
      const converted = datumOf(item, encl);
      if ("err" in converted) return converted;
      out.push(converted.ok);
    }
    if (tail !== undefined) {
      const converted = datumOf(tail, encl);
      if ("err" in converted) return converted;
      if (isList(tail) && converted.ok.kind === "list") out.push(...converted.ok.items);
      else out.push(converted.ok);
    }
    return { ok: { kind: "list", items: out } };
  };

  const datumOf = (d: Node, encl: Span): DatumOut =>
    isAtom(d) ? atomDatum(d, encl) : listDatum(d.list, d.span ?? encl);

  const classifyQuote = (n: Node & { list: Node[] }, parent: NodeId | undefined, span: Span): CoreForm => {
    if (n.list.length !== 2)
      return makeDoor(parent, n, span, "malformed-source", "quote-shape", "`quote` takes exactly one datum.");
    const converted = datumOf(n.list[1]!, span);
    if ("err" in converted)
      return makeDoor(parent, n, converted.err.span, converted.err.category, converted.err.slug, converted.err.message);
    return { ...baseFor(parent, n, span), kind: "Quote", datum: converted.ok };
  };

  // ── parameter lists (lambda / define fn-shorthand) ───────────────────────────

  type ParamsOut = { ok: { atom: Atom; rest: boolean }[] } | { err: DatumErr };

  /** `minFixed` is the R7RS grammar split: lambda formals require ≥1 fixed param before a
   *  dotted rest (`(a . rest)`; the zero-fixed spelling is the bare symbol, doored per spec
   *  §4.12), while DEFINE formals legally allow zero — `(define (f . rest) …)`. */
  const parseParams = (items: readonly Node[], encl: Span, minFixed: 0 | 1): ParamsOut => {
    const badParam = (at: Node | undefined): ParamsOut => ({
      err: {
        span: at?.span ?? encl,
        category: "malformed-source",
        slug: "param-list",
        message: "parameters must be plain symbols; a dotted rest tail is `(fixed… . rest)` with exactly one symbol after the `.`.",
      },
    });
    const dotIdx = items.findIndex(isDotAtom);
    if (dotIdx !== -1) {
      // The dot must sit penultimate, after ≥minFixed fixed params, before ONE symbol.
      if (dotIdx !== items.length - 2 || dotIdx < minFixed) return badParam(items[dotIdx]);
      const rest = items[items.length - 1];
      if (!isPlainSymbol(rest)) return badParam(rest);
      const fixed = items.slice(0, dotIdx);
      const out: { atom: Atom; rest: boolean }[] = [];
      for (const p of fixed) {
        if (!isPlainSymbol(p)) return badParam(p);
        out.push({ atom: p, rest: false });
      }
      out.push({ atom: rest, rest: true });
      return { ok: out };
    }
    const out: { atom: Atom; rest: boolean }[] = [];
    for (const p of items) {
      if (!isPlainSymbol(p)) return badParam(p);
      out.push({ atom: p, rest: false });
    }
    return { ok: out };
  };

  const mintParams = (descs: { atom: Atom; rest: boolean }[], parent: NodeId, encl: Span): Param[] =>
    descs.map(({ atom, rest }) => {
      const base = baseFor(parent, atom, encl);
      originAtom.set(base.id, atom);
      return { ...base, recordKind: "param", name: atom.atom, rest };
    });

  const classifyLambda = (n: Node & { list: Node[] }, parent: NodeId | undefined, span: Span): CoreForm => {
    if (n.list.length < 2)
      return makeDoor(parent, n, span, "malformed-source", "lambda-shape", "`lambda` needs a parameter list.");
    const spec = n.list[1]!;
    if (isAtom(spec)) {
      // `(lambda rest body…)` — a legal-if-rare R7RS shape (one rest parameter, no fixed
      // ones) the old emitter silently dropped (spec §4.12). Loud, actionable door.
      if (isPlainAtom(spec))
        return makeDoor(
          parent,
          spec,
          spec.span ?? span,
          "unsupported-form",
          "variadic-lambda",
          "a bare-symbol parameter spec (fully-variadic lambda) is not supported — spell the fixed parameters, e.g. `(lambda (a . rest) …)`.",
        );
      return makeDoor(parent, spec, spec.span ?? span, "malformed-source", "lambda-shape", "`lambda`'s parameter spec must be a list of symbols.");
    }
    const params = parseParams(spec.list, spec.span ?? span, 1);
    if ("err" in params)
      return makeDoor(parent, n, params.err.span, params.err.category, params.err.slug, params.err.message);
    const base = baseFor(parent, n, span);
    return {
      ...base,
      kind: "Lambda",
      params: mintParams(params.ok, base.id, span),
      body: n.list.slice(2).map((b) => classifyExpr(b, base.id, span)),
    };
  };

  // ── special forms ─────────────────────────────────────────────────────────────

  const classifyIf = (n: Node & { list: Node[] }, parent: NodeId | undefined, span: Span): CoreForm => {
    if (n.list.length !== 3 && n.list.length !== 4)
      return makeDoor(parent, n, span, "malformed-source", "if-shape", "`if` takes a condition, a then-branch, and an optional else-branch.");
    const base = baseFor(parent, n, span);
    const cond = classifyExpr(n.list[1]!, base.id, span);
    const then = classifyExpr(n.list[2]!, base.id, span);
    const els = n.list.length === 4 ? classifyExpr(n.list[3]!, base.id, span) : undefinedLit(base.id, span);
    return { ...base, kind: "If", cond, then, else: els };
  };

  type BindingsOut = { ok: { nameAtom: Atom; item: Node; init: Node | undefined }[] } | { err: DatumErr };

  const parseBindings = (items: readonly Node[], encl: Span): BindingsOut => {
    const out: { nameAtom: Atom; item: Node; init: Node | undefined }[] = [];
    for (const item of items) {
      const bad = (): BindingsOut => ({
        err: {
          span: item.span ?? encl,
          category: "malformed-source",
          slug: "let-binding",
          message: "each binding must be `(name init)` (or `(name)` for an elided init) with a plain-symbol name.",
        },
      });
      if (!isList(item) || item.list.length === 0 || item.list.length > 2) return bad();
      const nameAtom = item.list[0];
      if (!isPlainSymbol(nameAtom)) return bad();
      out.push({ nameAtom, item, init: item.list[1] });
    }
    return { ok: out };
  };

  const mintBindings = (
    descs: { nameAtom: Atom; item: Node; init: Node | undefined }[],
    parent: NodeId,
    encl: Span,
  ): Binding[] =>
    descs.map(({ nameAtom, item, init }) => {
      const base = baseFor(parent, item, encl);
      originAtom.set(base.id, nameAtom);
      return {
        ...base,
        recordKind: "binding",
        name: nameAtom.atom,
        init: init !== undefined ? classifyExpr(init, base.id, base.span) : undefinedLit(base.id, base.span),
      };
    });

  const classifyLetFamily = (
    letKind: LetKind,
    n: Node & { list: Node[] },
    parent: NodeId | undefined,
    span: Span,
  ): CoreForm => {
    const second = n.list[1];
    if (second === undefined)
      return makeDoor(parent, n, span, "malformed-source", "let-shape", `\`${letKind}\` needs a bindings list and a body.`);
    if (isAtom(second)) {
      // Named-let syntax is R7RS-defined ONLY for plain `let` (spec §4.11) — the old
      // emitters silently accepted `(let* loop …)`; that permissiveness was a bug.
      if (letKind !== "let")
        return makeDoor(
          parent,
          second,
          second.span ?? span,
          "malformed-source",
          "named-let-head",
          `named-let syntax is only defined for plain \`let\` — \`${letKind}\`'s second slot must be a bindings list.`,
        );
      if (!isPlainAtom(second))
        return makeDoor(parent, second, second.span ?? span, "malformed-source", "let-shape", "a named `let`'s loop name must be a plain symbol.");
      const bindingsNode = n.list[2];
      if (!isList(bindingsNode))
        return makeDoor(parent, n, span, "malformed-source", "let-shape", "a named `let` needs a bindings list after the loop name.");
      const parsed = parseBindings(bindingsNode.list, bindingsNode.span ?? span);
      if ("err" in parsed)
        return makeDoor(parent, n, parsed.err.span, parsed.err.category, parsed.err.slug, parsed.err.message);
      const base = baseFor(parent, n, span);
      originAtom.set(base.id, second);
      return {
        ...base,
        kind: "NamedLet",
        loopName: second.atom,
        bindings: mintBindings(parsed.ok, base.id, span),
        body: n.list.slice(3).map((b) => classifyExpr(b, base.id, span)),
      };
    }
    const parsed = parseBindings(second.list, second.span ?? span);
    if ("err" in parsed)
      return makeDoor(parent, n, parsed.err.span, parsed.err.category, parsed.err.slug, parsed.err.message);
    const base = baseFor(parent, n, span);
    return {
      ...base,
      kind: "Let",
      letKind,
      bindings: mintBindings(parsed.ok, base.id, span),
      body: n.list.slice(2).map((b) => classifyExpr(b, base.id, span)),
    };
  };

  const classifyDefine = (
    head: "define" | "define/overridable",
    n: Node & { list: Node[] },
    parent: NodeId | undefined,
    span: Span,
  ): CoreForm => {
    const overridable = head === "define/overridable";
    const shapeDoor = (message: string, at?: Node): CoreForm =>
      makeDoor(parent, at ?? n, at?.span ?? span, "malformed-source", "define-shape", message);
    const sig = n.list[1];
    if (sig === undefined) return shapeDoor(`\`${head}\` needs a name (or a \`(name params…)\` signature).`);
    if (isAtom(sig)) {
      if (!isPlainAtom(sig)) return shapeDoor("the defined name must be a plain symbol.", sig);
      const expected = overridable ? 4 : 3; // (define name value) / (define/overridable name type default)
      if (n.list.length !== expected)
        return shapeDoor(
          overridable
            ? "`define/overridable` takes exactly a name, a type tag, and a default value."
            : "`define` takes exactly a name and one value.",
        );
      const base = baseFor(parent, n, span);
      originAtom.set(base.id, sig);
      if (overridable) {
        const overridableType = classifyExpr(n.list[2]!, base.id, span);
        const value = classifyExpr(n.list[3]!, base.id, span);
        return { ...base, kind: "Define", name: sig.atom, value, overridableType };
      }
      return { ...base, kind: "Define", name: sig.atom, value: classifyExpr(n.list[2]!, base.id, span) };
    }
    // fn-shorthand: (define (f params…) body…) / (define/overridable (f params…) type body…)
    const nameAtom = sig.list[0];
    if (!isPlainSymbol(nameAtom)) return shapeDoor("the signature's first item must be the function name (a plain symbol).", sig);
    const bodyStart = overridable ? 3 : 2;
    if (n.list.length <= bodyStart)
      return shapeDoor(
        overridable
          ? "`define/overridable`'s fn-shorthand needs a type tag and a non-empty body."
          : "a function definition needs a non-empty body.",
      );
    const params = parseParams(sig.list.slice(1), sig.span ?? span, 0);
    if ("err" in params)
      return makeDoor(parent, n, params.err.span, params.err.category, params.err.slug, params.err.message);
    const base = baseFor(parent, n, span);
    originAtom.set(base.id, nameAtom);
    const mintedParams = mintParams(params.ok, base.id, span);
    const overridableType = overridable ? classifyExpr(n.list[2]!, base.id, span) : undefined;
    const body = n.list.slice(bodyStart).map((b) => classifyExpr(b, base.id, span));
    return overridableType !== undefined
      ? { ...base, kind: "DefineFn", name: nameAtom.atom, params: mintedParams, body, overridableType }
      : { ...base, kind: "DefineFn", name: nameAtom.atom, params: mintedParams, body };
  };

  const classifyDict = (n: Node & { list: Node[] }, parent: NodeId | undefined, span: Span): CoreForm => {
    const items = n.list.slice(1);
    if (items.length % 2 !== 0) {
      const dangling = items[items.length - 1]!;
      return makeDoor(parent, n, dangling.span ?? span, "malformed-source", "dict-arity", "`dict` takes key/value PAIRS — a dangling key has no value.");
    }
    // Validate every key on the raw nodes before minting any child (no orphan ids).
    for (let i = 0; i < items.length; i += 2) {
      const key = items[i]!;
      if (!isAtom(key))
        return makeDoor(parent, n, key.span ?? span, "malformed-source", "dict-key", "a `dict` key must be an atom (`:keyword` or bare symbol).");
    }
    const base = baseFor(parent, n, span);
    const entries: KwEntry[] = [];
    for (let i = 0; i < items.length; i += 2) {
      const key = items[i] as Atom;
      const value = items[i + 1]!;
      entries.push(mintKwEntry(key, isKeywordAtom(key) ? keywordName(key) : key.atom, value, base.id, span));
    }
    return { ...base, kind: "Dict", entries };
  };

  const mintKwEntry = (keyAtom: Atom, key: string, value: Node, parent: NodeId, encl: Span): KwEntry => {
    const keySpan = keyAtom.span ?? encl;
    const valueSpan = value.span ?? keySpan;
    const entrySpan: Span = [keySpan[0], valueSpan[1]];
    const id = mint(parent);
    const entryBase: Base = { id, span: entrySpan };
    return { ...entryBase, recordKind: "kwentry", key, value: classifyExpr(value, id, entrySpan) };
  };

  const classifyRequire = (n: Node & { list: Node[] }, parent: NodeId | undefined, span: Span): CoreForm => {
    const path = n.list[1];
    if (n.list.length !== 2 || !isAtom(path) || !path.str)
      return makeDoor(
        parent,
        n,
        span,
        "malformed-source",
        "require-path",
        "`require` takes exactly one string-literal path.",
      );
    return { ...baseFor(parent, n, span), kind: "Require", path: decodeSchemeString(path.atom) };
  };

  const classifyApp = (n: Node & { list: Node[] }, parent: NodeId | undefined, span: Span): CoreForm => {
    // Pre-validate the positional/kwarg split on the RAW nodes (spec §4.7): classification
    // is the boundary validator — a malformed call must not flow into later passes as an
    // apparently-ordinary App (spec §9 item 7's deciding argument).
    const items = n.list;
    const rawPositional: Node[] = [];
    const rawKw: { key: Atom; value: Node }[] = [];
    let sawKw = false;
    for (let i = 1; i < items.length; ) {
      const item = items[i]!;
      if (isKeyword(item)) {
        sawKw = true;
        const value = items[i + 1];
        if (value === undefined)
          return makeDoor(parent, n, item.span ?? span, "malformed-source", "kwarg-arity", `keyword argument \`${item.atom}\` has no value.`);
        rawKw.push({ key: item, value });
        i += 2;
      } else {
        if (sawKw)
          return makeDoor(
            parent,
            n,
            item.span ?? span,
            "malformed-source",
            "interleaved-args",
            "positional arguments may not follow keyword arguments.",
          );
        rawPositional.push(item);
        i += 1;
      }
    }
    const base = baseFor(parent, n, span);
    const fn = classifyExpr(items[0]!, base.id, span);
    const positionalArgs = rawPositional.map((a) => classifyExpr(a, base.id, span));
    const kwargs = rawKw.map(({ key, value }) => mintKwEntry(key, keywordName(key), value, base.id, span));
    return { ...base, kind: "App", fn, positionalArgs, kwargs };
  };

  // ── the list dispatcher ────────────────────────────────────────────────────────

  const classifyList = (n: Node & { list: Node[] }, parent: NodeId | undefined, encl: Span): CoreForm => {
    const span = n.span ?? encl;
    // Bare `()` in value position ≡ `'()` (spec §4.6) — both emitters already folded this.
    if (n.list.length === 0) return { ...baseFor(parent, n, encl), kind: "Quote", datum: { kind: "list", items: [] } };
    const first = n.list[0];
    const h = isAtom(first) && !first.str ? first.atom : undefined;
    if (h !== undefined) {
      // Doors are syntactic (constitution §2.2): a prohibited form doors in ANY position,
      // taken or not, well-formed target or not — there is nothing to lower.
      if (PROHIBITED_DYNAMICS.has(h))
        return makeDoor(parent, n, span, "prohibited-dynamics", slugOf(h), prohibitedMessage(h));
      const unsupported = UNSUPPORTED_HEADS.get(h);
      if (unsupported !== undefined) {
        // `cond` only reaches classify() unexpanded when desugar left it (a `=>` / bare-test
        // clause) — an expandable cond became nested `if` before this pass.
        return makeDoor(parent, n, span, "unsupported-form", slugOf(h), unsupported);
      }
      if (h === "cond")
        return makeDoor(
          parent,
          n,
          span,
          "unsupported-form",
          "cond-clause",
          "`cond` `=>` receiver / bare-`(test)` clauses are not desugared — use `(test body…)` clauses.",
        );
      switch (h) {
        case "quote":
          return classifyQuote(n, parent, span);
        case "lambda":
          return classifyLambda(n, parent, span);
        case "if":
          return classifyIf(n, parent, span);
        case "and": {
          const base = baseFor(parent, n, span);
          return { ...base, kind: "And", args: n.list.slice(1).map((a) => classifyExpr(a, base.id, span)) };
        }
        case "or": {
          const base = baseFor(parent, n, span);
          return { ...base, kind: "Or", args: n.list.slice(1).map((a) => classifyExpr(a, base.id, span)) };
        }
        case "let":
        case "let*":
        case "letrec":
        case "letrec*":
          return classifyLetFamily(h, n, parent, span);
        case "begin": {
          const base = baseFor(parent, n, span);
          return { ...base, kind: "Begin", body: n.list.slice(1).map((b) => classifyExpr(b, base.id, span)) };
        }
        case "define":
        case "define/overridable":
          return classifyDefine(h, n, parent, span);
        case "dict":
          return classifyDict(n, parent, span);
        case "require":
          return classifyRequire(n, parent, span);
      }
    }
    return classifyApp(n, parent, span);
  };

  const classifyExpr = (n: Node, parent: NodeId | undefined, encl: Span): CoreForm =>
    isAtom(n) ? classifyAtom(n, parent, encl) : classifyList(n, parent, n.span ?? encl);

  const forms = forest.map((f) => classifyExpr(f, undefined, f.span ?? ZERO_SPAN));
  return { forms, originAtom, parentOf, doors };
}
