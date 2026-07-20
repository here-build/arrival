# Polyglot grammar specs

These `*.spec.ts` files pin arrival's non-standard reader/eval grammar — the `{…}` dict /
`[…]` vector collection literals and their position-scoped comma rule, the let-family
**bracket bindings** superset (the bracket-binding section header in `src/eval/evaluator.ts`,
`normalizeBindings`), and its addendum, **bracket clause positions** for `cond`/`case`/`do`'s
test clause — one feature per file, via native `it.each` tables (curly-braces, vector-bracket,
vector-hash, macro-special-brackets, member-accessor, reader-baseline).

## AST canonicalization (`readAst`)

- Lists print `(a b c)`, dotted tails `(a . b)`; quote-family reader macros print
  expanded: `(quote x)`, `(quasiquote x)`, `(unquote x)`, `(unquote-splicing x)`.
- A `[…]` vector **literal node** prints `[form …]`; an R7RS `#(…)` constant prints
  `#(form …)`. The distinction is load-bearing: a conforming reader must keep the two
  apart (the literal's elements evaluate in code position, the constant's never do).
- A `{…}` dict **literal node** prints `{form …}` — its flat key/value form sequence in
  source order (post comma-absorption).
- Strings print JSON-quoted (`"a"`), booleans `#t`/`#f`, nil `()`; numbers and symbols
  print bare.

## Value folding (`evalJson`)

Results fold to JSON: exact/inexact numbers → numbers, strings → strings, booleans →
booleans, nil/absent → `null`, vectors → arrays, dicts → objects (string keys, values
folded recursively), symbols → `{"$sym": "<name>"}`.

## Error taxonomy

Stable machine-checkable identifiers (`code` on the thrown error). Messages stay free to
teach; the specs match ONLY the class.

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
| `E-LET-BRACKET-BINDINGS-LIST` | a let-family whole-list bracket bindings form is malformed: odd element count, or the whole-list form on `do` (see the bracket-binding section in `src/eval/evaluator.ts`) |
| `E-LET-BRACKET-BINDING` | a per-element bracket binding is malformed: wrong length (≠2; ≠2–3 for `do`), or a non-symbol (incl. a destructuring vector) in the binding-name slot |
| `E-COND-BRACKET-CLAUSE` | a `cond`/`case`/`do`-test bracket clause is empty (`[]`) |
| `E-CASE-BRACKET-DATUM-LIST` | a `case` clause's datum-list head is itself a bracket vector — the datum list is data and is never bracket-converted, even inside a bracketed clause |

## The comma rule

`,` is a token-level delimiter (R7RS classes it so). Inside `{…}`/`[…]` literals, at most
ONE comma is absorbed as a separator per element boundary — for maps only at EVEN
boundaries (after a complete key-value pair; JSON puts `:` between key and value, never
`,`). Every other comma — leading, odd-boundary, second-at-same-boundary, everywhere
outside the literals — is R7RS unquote. `,@` is never a separator. One trailing separator
before the close is tolerated. Canonical pin:
`{:a ,quoted,,anotherQuoted ,quotedValue}` ≡ `{:a (unquote quoted) (unquote anotherQuoted) (unquote quotedValue)}`.

## The suffix-keyword flip

At KEY position inside `{…}`, a symbol token with a SINGLE trailing colon flips to the
keyword key: `{flight_number: "X"}` ≡ `{:flight_number "X"}` (explicit declaration only —
a bare `{x 1}` stays `E-DICT-BAD-KEY`; position-scoped — `foo:` outside `{}` is a plain
symbol; flipped keys share the dup-detection keyspace with `:key`/`"key"`). Maps also
absorb at most ONE lone `:` token at an ODD boundary — the verbatim-JSON string-key colon
`{"a": 1}`. The GLUED forms are lexer-scoped: `{a:1}` is ONE symbol token (the teaching
door), and `{"a":1}` lexes the value as the keyword token `:1` — only a space after the
colon yields the JSON meaning.
