# Arrival grammar conformance corpus

Language-portable conformance suite for the arrival reader/evaluator grammar extensions —
currently the `{…}` dict / `[…]` vector collection literals and their position-scoped
comma rule (spec: `docs/working-proposals/arrival-curly-vector-literals.md`). A future
Python/Rust port of the reader runs this same corpus; only the thin runner
(`src/__tests__/spec-corpus.test.ts` here) is implementation-specific.

## Record format

JSONL — one JSON object per line:

```json
{"name": "y_...", "mode": "read" | "eval", "input": "<scheme source>", "expect": {…}}
```

- `name` prefix (JSON-Test-Suite style): `y_` must-accept, `n_` must-reject with the
  given error class, `i_` implementation-defined behavior we currently pin (a port MAY
  diverge here with a documented reason; a `y_`/`n_` divergence is a conformance bug).
- `input` may contain multiple top-level datums; the **last** datum/result is asserted.
- `expect` is exactly one of:
  - `{"ast": "<canonical s-expr>"}` — `mode: "read"`: the parse of the last datum,
    rendered per the canonicalization below.
  - `{"value": <json>}` — `mode: "eval"`: the evaluation result, folded to JSON per the
    value convention below.
  - `{"error": "<ERROR-CLASS>"}` — the read/eval must fail with the given stable error
    class (`"*"` = any error; used only in `i_` cases where the class is unpinned).

## AST canonicalization (`mode: "read"`)

- Lists print `(a b c)`, dotted tails `(a . b)`; quote-family reader macros print
  expanded: `(quote x)`, `(quasiquote x)`, `(unquote x)`, `(unquote-splicing x)`.
- A `[…]` vector **literal node** prints `[form …]`; an R7RS `#(…)` constant prints
  `#(form …)`. The distinction is load-bearing: a conforming reader must keep the two
  apart (the literal's elements evaluate in code position, the constant's never do).
- A `{…}` dict **literal node** prints `{form …}` — its flat key/value form sequence in
  source order (post comma-absorption).
- Strings print JSON-quoted (`"a"`), booleans `#t`/`#f`, nil `()`; numbers and symbols
  print bare.

## Value convention (`mode: "eval"`)

Results fold to JSON: exact/inexact numbers → numbers, strings → strings, booleans →
booleans, nil/absent → `null`, vectors → arrays, dicts → objects (string keys, values
folded recursively), symbols → `{"$sym": "<name>"}`.

## Error taxonomy

Stable machine-checkable identifiers (`code` on the thrown error). Messages stay free to
teach; the corpus matches ONLY the class. These become the spec's error contract keys.

| Code | Meaning |
|---|---|
| `E-DICT-ODD-ARITY` | `{…}` has an odd element count (a key without its value) |
| `E-DICT-BAD-KEY` | `{…}` key is not a `:keyword` / `"string"` / trailing-colon `key:` / unquote form (read time), or a substituted key folded to a non-string (eval time) |
| `E-DICT-DUP-KEY` | duplicate `{…}` key (read-time static; or post-quasiquote-substitution) |
| `E-LITERAL-DOT` | `.` inside a `[…]`/`{…}` literal |
| `E-EXPECTING-DATUM` | quote-family prefix (`'`, `` ` ``, `,`, `,@`) dangling against a close delimiter |
| `E-UNTERMINATED` | EOF inside an open string/list/literal |
| `E-BRACKET-MISMATCH` | close delimiter does not pair its opener (`(a]`) |
| `E-BRACKET-UNEXPECTED` | close delimiter with nothing open (`]`) |

## The comma rule (what the cases pin)

`,` is a token-level delimiter (R7RS classes it so). Inside `{…}`/`[…]` literals, at most
ONE comma is absorbed as a separator per element boundary — for maps only at EVEN
boundaries (after a complete key-value pair; JSON puts `:` between key and value, never
`,`). Every other comma — leading, odd-boundary, second-at-same-boundary, everywhere
outside the literals — is R7RS unquote. `,@` is never a separator. One trailing separator
before the close is tolerated. Canonical pin:
`{:a ,quoted,,anotherQuoted ,quotedValue}` ≡ `{:a (unquote quoted) (unquote anotherQuoted) (unquote quotedValue)}`.

## The suffix-keyword flip (what the `*_suffix_*` cases pin)

At KEY position inside `{…}`, a symbol token with a SINGLE trailing colon flips to the
keyword key: `{flight_number: "X"}` ≡ `{:flight_number "X"}` (explicit declaration only —
a bare `{x 1}` stays `E-DICT-BAD-KEY`; position-scoped — `foo:` outside `{}` is a plain
symbol; flipped keys share the dup-detection keyspace with `:key`/`"key"`). Maps also
absorb at most ONE lone `:` token at an ODD boundary — the verbatim-JSON string-key colon
`{"a": 1}`. The GLUED forms are lexer-scoped (`i_`): `{a:1}` is ONE symbol token (the
teaching door), and `{"a":1}` lexes the value as the keyword token `:1` — only a space
after the colon yields the JSON meaning.
