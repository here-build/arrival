# @here.build/arrival-sugarcoat

**Sugarcoat** is the reversible view of Scheme. It can be used as bidirectional lens to convert into pure Scheme. Any Scheme program can be transformed into a Sugarcoat program, and any Sugarcoat program can be transformed back, intent-lossless; in other words, canonical AST representation is guaranteed to be preserved.


```
canonical: (map
              (lambda (it)
                (:family
                  (normalize
                     (car it))))
              evidence)
sugarcoat: evidence.map{ it[0].normalize[:family] }
```

It was specifically designed to make Scheme programs readable and editable by a widespread programmer audience, while avoiding any irrepresentable changes.  

## Code transform is bidirectionally stable

`ast(sugarcoatToScheme(schemeToSugarcoat(x), x)) ≡ ast(x)` — render then read gives you back the original intent, always.
It will lose the original formatting, and fuse `(car (car ...))` into `(caar ...)`, but the original intent is guaranteed to be preserved. All the transforms are implemented in isolation as deterministic rules with invariants.

```ts
import { schemeToSugarcoat, sugarcoatToScheme } from "@here.build/arrival-sugarcoat";

const scheme = "(map (lambda (it) (* it 2)) xs)";
schemeToSugarcoat(scheme);                       // → "xs.map{ it * 2 }"
sugarcoatToScheme("xs.map{ it * 2 }", scheme);    // → "(map (lambda (it) (* it 2)) xs)"
```

Or use `@here.build/codemirror-arrival`. It literally can render Sugarcoat while storing Scheme internally.

Inside the Arrival setup, Scheme programs are stored as canonical Scheme s-expressions.
Sugarcoat is a **skin** over that same stored form — a bidirectional lens, not a new language.
You can write either face; the file on disk stays raw Scheme either way.
Editor is transforming Scheme <> Sugarcoat live as you type.

## Why?

Sugarcoat was designed this specific way for quite a unique purpose: not for humans writing code, but for LLMs editing real Scheme, that gets sweetened into Sugarcoat, rendered for user, who may occasionally change things, or just try to understand what is changed, and converted back to Scheme for LLM to continue editing. This setup is part of the wider Arrival stack; e.g. Sugarcoat is used for Arrival MCP debugging.

It is designed specifically around human-AI collaboration flow – but it does not mean it cannot be used without AI. Feel free to work with it if you want to.

## The features, one at a time

### Curly-infix

```
canonical:  (+ (+ a b) c)
sugarcoat:  {a + b + c}

canonical:  (* it 2)
sugarcoat:  {it * 2}
```

Ordinary infix arithmetic/comparison reads left-to-right with normal precedence. The implementation is following SRFI-105 sweet expressions spec.

### Accessor subscripts — `[n]`, `[start:]`, `[:key]`

```
canonical:  (car x)          sugarcoat:  x[0]
canonical:  (cdr x)          sugarcoat:  x[1:]
canonical:  (cadr x)         sugarcoat:  x[1]
canonical:  (caar x)         sugarcoat:  x[0][0]
canonical:  (:verdict it)    sugarcoat:  it[:verdict]
```

The whole `c[ad]+r` accessor family decomposes into a PULL/DROP step chain (`decodeAccessor` /
`encodeAccessor`) — this is the one source of truth shared by the renderer, the reader, and the
chain-view compiler, so bracket-index and `.symbol` accessor sugar can never drift apart.

### Method-dot chains — receiver-last fold

```
canonical:  (map (lambda (it) (* it 2)) xs)
sugarcoat:  xs.map{ it * 2 }

canonical:  (g (f x))
sugarcoat:  x.f.g

canonical:  (fold (lambda (acc x) (+ acc x)) knil xs)
sugarcoat:  xs.fold(knil){(acc x) => acc + x}
```

`.symbol` always seats the receiver in the *last* argument slot of the call it's chaining into — that one
rule unifies plain unary pipes (`x.f.g`), higher-order calls with a trailing lambda (`xs.map{...}`), and
calls with their own extra args (`xs.fold(knil){...}`).

### The `it` pronoun

This one is based on multiple prior concepts. Specifically, Paul Graham was a popularizer of anaphoric expressions (`aif` macro), and Clojure has a similar concept with argument placeholders (`#(> % 3)`). Yet, the Kotlin-style declarations (`list.filter { it > 3 }`) were chosen as generally more recognizable.

```
canonical:  (map (lambda (it) (:family it)) evidence)
sugarcoat:  evidence.map{ it[:family] }
```

A trailing lambda's bound parameter gets recovered to the most readable name for its role: `it` when
every use inside the body is a keyed accessor, a singular noun pulled from the collection name when the
element escapes opaquely (`items` → `item`, `families` → `family`), or the original name if neither rung
applies. Expression will never get transformed to anaphoric, if it's not definitely suitable, or there are lexical scope collisions.

### Arrow lambdas

```
canonical:  (lambda (y) y)
sugarcoat:  {(y) => y}
```

Used whenever a lambda has more than one parameter, or a single parameter that isn't the implicit `it`. Internally, it is just alias to `lambda`, combined with sweet-expressions; technically, you can write `(=> (y) y)` too - but `{(y) => y}` is more recognisable for most of developers.

### `??` coalesce

```
canonical:  (if x x y)
sugarcoat:  x ?? y
```

This is just handy pattern-matching for readability. Internally, it's yet another macro.

### At-expressions — string/template building

```
canonical:  (str "hello")
sugarcoat:  @{hello}

canonical:  (str "a " x " b")
sugarcoat:  @{a @x b}

canonical:  (string-append "a " x " b")
sugarcoat:  @string-append{a @x b}

canonical:  (str (dedented, common-indent stripped))
sugarcoat:  @dedent{
              multi-line prose
              with interpolated @x values
            }
```

`@head{...}` is a flat tagged-template: headless defaults to `(str ...)`, an explicit head calls that
procedure with the interpolated parts, `@(datum)` grafts in a full parenthesized form, and quotes inside
the braces are literal — no escaping needed.

This syntax relies on Racket `at-exp` extension as reference.

### Extra goodies

Arrival-sugarcoat sits on top of Arrival, the polyglot interpreter of R7RS Scheme. It adds `{:key value}` dicts, `[item]` and `#(item)` vectors syntax on its own; it's not part of Sugarcoat, yet it is processed as part of underlying language.

Also, the Arrival-Scheme Language Server Protocol is designed Sugarcoat-compatible. All the capabilities - contextual autocomplete, arguments hinting, type conflicts detection, including generics, fully work in Sugarcoat. See `@here.build/arrival-codemirror` for reference implementation.

---

## What this package is *not*

- Not the eval engine. It's a zero-dependency leaf: its own s-expr parser, `tiny-invariant` as its only
  runtime dependency on the main entry point. It never pulls in the Arrival interpreter.
- Not SRFI-110. Indentation-as-grammar was considered and intentionally rejected for the canonical form;
  python-style indents only ever exist as a *display* lens over the same paren-delimited canonical source.
- Not a new language to learn before you can write Arrival scheme. Stored programs are always plain
  s-expressions — sugarcoat is an optional editing convenience, never a requirement.

## License

**[FSL-1.1-MIT](./LICENSE.md)** — Functional Source License 1.1, MIT Future License. Each version converts
to MIT two years after its release date. Until conversion, the license permits everything *except*
Competing Use (making the Software available in a commercial product or service that substitutes for the
Software or offers substantially similar functionality). Internal use, non-commercial education and
research, and professional services built on top of the Software are always permitted.

For licensing questions, exemptions, or clarifications: team@here.build.

If this package eventually becomes a commodity, we will be happy to convert it into MIT. FSL is chosen as an early-stage startup R&D defense against competitors and is not intended to be a permanent license for the whole package lifetime. 
