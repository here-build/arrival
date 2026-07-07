# @here.build/arrival-sugarcoat — learn it in Y minutes

**"Sweet" means SRFI-105 curly-infix, and only that.** Everything else in this package — accessors,
method-dot, the `it` pronoun, arrow-lambdas, at-expressions — is **sugarcoat**, here.build's own dialect. It's like **sweet**, but even sweeter.

It was specifically designed to make Scheme programs readable by modern audience, yet avoiding any irrepresentable changes.

Arrival programs are stored as canonical Scheme s-expressions. That never changes. Sugarcoat is a
**readable skin** over that same stored form — a bidirectional lens, not a new language. You can write
either face; the file on disk stays raw scheme either way.

```
canonical:  (map (lambda (it) (* it 2)) xs)
sugarcoat:  xs.map{ it * 2 }
```

`sugarcoatToScheme(schemeToSugarcoat(x), x) ≡ x` — render then read gives you back the original intent, always.
It will probably lose the original formatting, and fuse `(car (car ...))` into `(caar ...)`, but the original intent is guaranteed to be preserved.
That round-trip law is what makes this sound instead of a lossy transpile: editing the sugarcoat view and
saving never silently rewrites bytes you didn't touch.

## The three layers

```
core scheme  ⟷  sweet  ⟷  sugarcoat
```

1. **core scheme** — s-expressions. What the interpreter evaluates. The only canonical, stored form.
2. **sweet** — **SRFI-105 curly-infix, and nothing else.** `{a + b}` → `(+ a b)`. SRFI-110
   (significant-indentation sweet-expressions) is *deliberately* not part of this grammar — an AI-primary
   editor gains nothing from layout and inherits all the invisible-wrong-parse risk, so the canonical
   grammar keeps visible delimiters.
3. **sugarcoat** — the full here.build dialect. An "everything-soup" pastiche, each feature borrowed from
   wherever reads best (JS, Python, Kotlin, Ruby), each one a *bounded, named departure* with a mechanical
   inverse back to scheme. Sweet (layer 2) is sugarcoat's infix sub-feature, not a separate thing you pick
   between.

This package implements layer 3 (sugarcoat), with layer 2 (sweet/curly-infix) interleaved as one of its
features — there's no separate "vanilla sweet only" build.

## Try it

```ts
import { schemeToSugarcoat, sugarcoatToScheme } from "@here.build/arrival-sugarcoat";

const classic = "(map (lambda (it) (* it 2)) xs)";
schemeToSugarcoat(classic);                       // → "xs.map{ it * 2 }"
sugarcoatToScheme("xs.map{ it * 2 }", classic);    // → back to `classic`, byte-identical
```

## The features, one at a time

### Curly-infix (the actual "sweet" layer — SRFI-105)

```
canonical:  (+ (+ a b) c)
sugarcoat:  {a + b + c}

canonical:  (* it 2)
sugarcoat:  {it * 2}
```

Ordinary infix arithmetic/comparison reads left-to-right with normal precedence. This is the *only*
feature that's correctly called "sweet" — everything past this point is sugarcoat-proper.

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

This one is based on multiple prior concepts. Specifically, Paul Graham was a popularizer of anaphoric expressions (`aif` macro), and Clojure has a similar concept with argument placeholders (`#(> % 3)`). Yet, the Kotlin-style declarations (`list.filter { it > 3 }`) were chosen as most readable ones across the family.

```
canonical:  (map (lambda (it) (:family it)) evidence)
sugarcoat:  evidence.map{ it[:family] }
```

A trailing lambda's bound parameter gets recovered to the most readable name for its role: `it` when
every use inside the body is a keyed accessor, a singular noun pulled from the collection name when the
element escapes opaquely (`items` → `item`, `families` → `family`), or the original name if neither rung
applies. This is a **sugarcoat-only** feature — no relation to SRFI-105.

### Arrow lambdas

```
canonical:  (lambda (y) y)
sugarcoat:  {(y) => y}
```

Used whenever a lambda has more than one parameter, or a single parameter that isn't the implicit `it`. Internally, it is just alias to `lambda`, combined with sweet-expressions; technically, you can write `(=> (y) y)` too - but `{(y) => y}` looks way more readable for modern audience.

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

## What this package is *not*

- Not the eval engine. It's a zero-dependency leaf: its own s-expr parser, `tiny-invariant` as its only
  runtime dependency on the main entry point. It never pulls in the Arrival interpreter.
- Not SRFI-110. Indentation-as-grammar was considered and intentionally rejected for the canonical form;
  python-style indents only ever exist as a *display* lens over the same paren-delimited canonical source.
- Not a new language to learn before you can write Arrival scheme. Stored programs are always plain
  s-expressions — sugarcoat is an optional editing convenience, never a requirement.

## API surface

- `schemeToSugarcoat(src, opts?)` — render canonical scheme as sugarcoat text.
- `sugarcoatToScheme(sugarcoatText, prevClassic, opts?)` / `readSugarcoat` — fold an edited sugarcoat buffer
  back to canonical scheme, using the previous classic source so unchanged forms round-trip byte-for-byte.
- `parseSexprs` / `printScheme` — the bundled s-expr parser and canonical pretty-printer
  (`parseSexprs(printScheme(f)) ≡ f`).
- `alignSugarcoatClassic` — span-pair alignment between the two views, for cursor/selection mapping in editors.
- `paramHints` / `paramHintsSugarcoat` — positional argument-name inlay hints.
- `inlineSugarcoat` / `formatSugarcoat`, kwarg (de)sugaring, `nodeEq`, `DEFAULT_OPTS` — lower-level render
  primitives some tools reach for directly.
- `decodeAccessor` / `encodeAccessor` — the single `c[ad]+r` decomposition shared by renderer, reader, and
  the chain-view compiler.
- `./names` subpath — `tidyBoundNames`, `boundNameHints` (the `it`-pronoun recovery pass). Tree-shaken away
  from `.` consumers that don't use it; pulls in `@here.build/lexical-namer` and `pluralize`.

## Install

```bash
pnpm add @here.build/arrival-sugarcoat
```

## License

**[FSL-1.1-MIT](./LICENSE.md)** — Functional Source License 1.1, MIT Future License. Each version converts
to MIT two years after its release date. Until conversion, the license permits everything *except*
Competing Use (making the Software available in a commercial product or service that substitutes for the
Software or offers substantially similar functionality). Internal use, non-commercial education and
research, and professional services built on top of the Software are always permitted.

For licensing questions, exemptions, or clarifications: team@here.build
