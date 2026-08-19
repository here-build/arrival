// scheme-parse.ts — a compact, string-aware reader for the decoded Scheme call(s). A focused port of
// intent-eval's `bfcl-score.ts` parser (the source the prompt points at), vendored here so the sampler's
// server has NO dependency on the intent-eval example package (dependency direction: examples consume the
// sampler, never the reverse). The reader is intentionally minimal — it reads exactly the call shapes the
// constrained decode emits: a positional `(name arg …)` form, with atoms being quoted strings, bare numbers,
// `#t`/`#f`, bare symbols, and list literals `(list a b …)` / `(array a b …)` / `'(a b …)`.
//
// We do NOT re-implement the BFCL scorer (matching/coercion against ground truth) — only the parse into a
// positional `{ name, args }` shape, which is all the scheme→tool_calls translation needs.

/** A parsed positional argument. `kind` mirrors the value classifier; `list` carries ordered `elements`. */
export interface ParsedArg {
  readonly kind: "string" | "number" | "bool" | "symbol" | "list";
  readonly raw: string;
  readonly value: string | number | boolean;
  readonly elements?: readonly ParsedArg[];
}

/** A parsed positional call: the operator `name` + its positional `args`. */
export interface ParsedCall {
  readonly name: string;
  readonly args: readonly ParsedArg[];
}

interface Tok {
  readonly raw: string;
}

/** Parse ALL top-level balanced `(…)` forms in `program` into positional calls. A SINGLE top-level wrapper
 *  around child call forms is unwrapped to those calls — the natural way a model emits several calls as one
 *  expression. Two wrapper kinds:
 *    • `(begin …)` / `(do …)` — statement sequences; unwrap their child forms unconditionally.
 *    • `(list …)` / `(array …)` — the model's NATURAL PARALLEL shape `(list (f …) (g …))` (observed from
 *      arch-1.5b on parallel intents). Unwrap ONLY when EVERY body token is itself a call form, i.e. the body
 *      is all nested `(…)` forms — never a data list of bare atoms like `(list "a" "b")` (which isn't a tool
 *      call and is filtered downstream anyway). The `childForms.length === head.rest.length` test is the
 *      discriminator: it holds iff every argument of the list is a parenthesised form.
 *  Returns [] if no balanced form is found. */
export function parseSchemeForms(program: string): ParsedCall[] {
  const forms = topLevelForms(program);
  if (forms.length === 1) {
    const sole = forms[0]!;
    const head = readSchemeHead(sole);
    if (head) {
      const isSeq = head.name === "begin" || head.name === "do";
      const isList = head.name === "list" || head.name === "array";
      if (isSeq || isList) {
        const inner = sole.slice(sole.indexOf("(") + 1);
        const childForms = topLevelForms(inner).filter((f) => f.trimStart().startsWith("("));
        // begin/do: unwrap whatever child forms are present. list/array: only when ALL body tokens are forms
        // (a call-list, not a data-list) — else fall through and let it parse as a (non-tool) `list` call.
        const unwrap = childForms.length > 0 && (isSeq || childForms.length === head.rest.length);
        if (unwrap) {
          const calls = childForms.map(parseSchemeCall).filter((c): c is ParsedCall => c !== null);
          if (calls.length > 0) return calls;
        }
      }
    }
  }
  return forms.map(parseSchemeCall).filter((c): c is ParsedCall => c !== null);
}

/** Parse the FIRST balanced top-level `(name arg …)` form. String-aware (a `)` inside `"…"` does not close).
 *  Returns null if unparseable. */
export function parseSchemeCall(program: string): ParsedCall | null {
  const head = readSchemeHead(program);
  if (head === null) return null;
  return { name: head.name, args: head.rest.map(classify) };
}

/** The operator name + raw body tokens of the first balanced top-level form, or null. */
function readSchemeHead(program: string): { name: string; rest: Tok[] } | null {
  const start = program.indexOf("(");
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  let inStr = false;
  for (let i = start; i < program.length; i++) {
    const ch = program[i]!;
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const toks = tokenize(program.slice(start + 1, end));
  if (toks.length === 0) return null;
  const [headTok, ...rest] = toks;
  return { name: headTok!.raw, rest };
}

/** Slice a program into its top-level balanced `(...)` form substrings (string-aware). */
function topLevelForms(program: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < program.length) {
    const start = program.indexOf("(", i);
    if (start === -1) break;
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (let j = start; j < program.length; j++) {
      const ch = program[j]!;
      if (inStr) {
        if (ch === "\\") j++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) break;
    out.push(program.slice(start, end + 1));
    i = end + 1;
  }
  return out;
}

/** Split a form body into top-level tokens: quoted strings, nested forms, quoted lists, and bare atoms. */
function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let buf = '"';
      while (j < s.length) {
        const c = s[j]!;
        buf += c;
        if (c === "\\") {
          buf += s[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (c === '"') {
          j++;
          break;
        }
        j++;
      }
      out.push({ raw: buf });
      i = j;
      continue;
    }
    if ((ch === "'" && s[i + 1] === "(") || ch === "(") {
      // a quoted list `'(…)` or a nested form `(…)` — capture the whole balanced form (incl. a leading quote).
      const quote = ch === "'";
      let depth = 0;
      let j = quote ? i + 1 : i;
      let inStr = false;
      let buf = quote ? "'" : "";
      for (; j < s.length; j++) {
        const c = s[j]!;
        buf += c;
        if (inStr) {
          if (c === "\\") {
            buf += s[j + 1] ?? "";
            j++;
          } else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === "(") depth++;
        else if (c === ")") {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
      }
      out.push({ raw: buf });
      i = j;
      continue;
    }
    // bare atom
    let j = i;
    while (j < s.length && !/[\s()"]/.test(s[j]!)) j++;
    out.push({ raw: s.slice(i, j) });
    i = j;
  }
  return out;
}

/** Classify a body token into a {@link ParsedArg}. */
function classify(t: Tok): ParsedArg {
  const raw = t.raw;
  if (raw.startsWith('"')) return { kind: "string", raw, value: unquote(raw) };
  if (raw === "#t" || raw === "#f") return { kind: "bool", raw, value: raw === "#t" };
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw)) return { kind: "number", raw, value: Number(raw) };
  const listElems = schemeListElements(raw);
  if (listElems !== null) return { kind: "list", raw, value: raw, elements: listElems };
  return { kind: "symbol", raw, value: raw };
}

/** If `raw` is a scheme list surface — `(list …)`, `(array …)`, or `'(…)` — return its ordered element args. */
function schemeListElements(raw: string): ParsedArg[] | null {
  if (raw.startsWith("'(") && raw.endsWith(")")) {
    return tokenize(raw.slice(2, -1)).map(classify);
  }
  if (raw.startsWith("(") && raw.endsWith(")")) {
    const toks = tokenize(raw.slice(1, -1));
    if (toks.length === 0) return null;
    const head = toks[0]!.raw;
    if (head !== "list" && head !== "array") return null;
    return toks.slice(1).map(classify);
  }
  return null;
}

function unquote(s: string): string {
  return s
    .slice(1, -1)
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}
