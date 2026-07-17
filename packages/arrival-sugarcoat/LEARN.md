# Learn Sugarcoat in Y minutes

Sugarcoat is a view, not a language: everything below is canonical Scheme wearing familiar
syntax, and every form shown folds back to the s-expression next to it. `;; ≡` marks the
canonical form a line lowers to. Every example here is real renderer output.

Plain Scheme is always valid input — parens never stop working. Sugarcoat is what the
renderer *chooses* to show you, and what the reader accepts back.

## Indentation

A line plus its more-indented children form one expression. That's the whole rule —
what other Lisps spend parens on, Sugarcoat spends layout on.

```scheme
define (score user)
  {user[:karma] * 2}

;; ≡ (define (score user)
;;     (* (:karma user) 2))
```

Bracket balance beats layout: a `{…}` or `(…)` may span physical lines freely.
Indentation is regenerated on every render — you can't save a "wrong layout".

The rule runs one way: indentation groups code, but **inside any bracket you are in
plain code context** — layout is just whitespace there. A multi-line lambda body can't
use indentation forms; write them delimited:

```scheme
rows.map{(r) => (dict :id r[:id] :label r[:label].strip)}
;; ≡ (map (lambda (r) (dict :id (:id r) :label (strip (:label r)))) rows)
```

## Curly-infix

`{…}` switches to infix with the precedence ladder you already know
(`||` < `&&` < comparisons < `+ -` < `* / modulo`):

```scheme
{a + b + c}              ;; ≡ (+ (+ a b) c)
{v == "a" || v == "b"}   ;; ≡ (or (equal? v "a") (equal? v "b"))
{a - b < c}              ;; ≡ (< (- a b) c)   — tighter child needs no braces
{{a + b} * c}            ;; ≡ (* (+ a b) c)   — looser child keeps them
```

`==` is `equal?`; `=`, `eq?`, `eqv?` render as themselves, so equality *kind* survives
the round-trip.

**Infix exists only inside `{…}`.** A naked operator line is an application, not arithmetic:

```scheme
{item[:votes] * item[:weight] + item[:bonus]}
;; ≡ (+ (* (:votes item) (:weight item)) (:bonus item))

item[:votes] * item[:weight]   ;; ✗ CALLS (:votes item) with args * and (:weight item)
adults.fold(0){…} / count      ;; ✗ same trap — wrap it whole: {adults.fold(0){…} / count}
```

## Subscripts

`[n]` walks pairs, `[:key]` reads keyed data. The whole `c[ad]+r` alphabet dissolves:

```scheme
x[0]        ;; ≡ (car x)
x[1]        ;; ≡ (cadr x)
x[1:]       ;; ≡ (cdr x)
x[0][0]     ;; ≡ (caar x)
it[:verdict]  ;; ≡ (:verdict it)
```

## Method-dot chains

`.symbol` seats the receiver in the *last* argument slot of the call it chains into:

```scheme
x.f.g                       ;; ≡ (g (f x))
xs.map{ it * 2 }            ;; ≡ (map (lambda (it) (* it 2)) xs)
evidence.map{ it[0].normalize[:family] }
;; ≡ (map (lambda (it) (:family (normalize (car it)))) evidence)
```

Extra positional arguments (a fold seed, a default) go in `(…)` **between** the method
name and the trailing lambda — never after the braces:

```scheme
items.fold(0){(acc it) => acc + it[:price]}
;; ≡ (fold (lambda (acc it) (+ acc (:price it))) 0 items)

items.fold{(acc it) => acc + it}  0   ;; ✗ NOT a seed — this APPLIES the fold result to 0
```

One rule covers unary pipes, higher-order calls with a trailing lambda, and seeded folds.
The brackets must be *tight* (no space before `(` or `{`) — a spaced `{…}` is a sibling
operand, not a trailing lambda.

## `it` and arrow lambdas

A trailing lambda whose parameter is named `it` elides it, Kotlin-style. Any other
signature renders as an arrow:

```scheme
users.filter{ it[:age] < 30 }
;; ≡ (filter (lambda (it) (< (:age it) 30)) users)

users.filter{(u) => u[:age] < 30}
;; ≡ (filter (lambda (u) (< (:age u) 30)) users)

(fold {(acc x) => acc + x} knil xs)
;; ≡ (fold (lambda (acc x) (+ acc x)) knil xs)
```

The lens never renames *your* parameters — `u` stays `u`. When you want `it`-ification
(or `items` → `item` recovery), that's the explicit opt-in `tidyBoundNames` pass from
`@inhuman.tools/arrival-sugarcoat/names`, or its no-touch twin `boundNameHints` for editor
inlays.

`=>` is just an alias of `lambda` — `(=> (y) y)` is legal — but `{(y) => y}` is the face.

## Binding forms

`let*`/`let` elide the binding parens — each binding is a name line with its value
indented; the body follows as a sibling:

```scheme
let*
  base
    (fetch url)
  rows
    base[:rows]
  rows.map{ it[:id] }

;; ≡ (let* ((base (fetch url))
;;          (rows (:rows base)))
;;     (map (lambda (it) (:id it)) rows))
```

`cond` renders vertical, test then consequence:

```scheme
cond
  {n < 0}
    "neg"
  {n = 0}
    "zero"
  else
    "pos"

;; ≡ (cond ((< n 0) "neg") ((= n 0) "zero") (else "pos"))
```

## Dicts and kwargs

Canonical dicts are `(dict :k v …)` (arrival's core reader also accepts the Clojure-style
input literal `{:k v …}` for the same form). Sugarcoat shows the block form as colon-pairs:

```scheme
dict
  name: "Ada Lovelace"
  age: 36

;; ≡ (dict :name "Ada Lovelace" :age 36)
```

The same `key: value` rendering applies to any kwarg-taking head — e.g. a `.prompt`
require's named arguments.

The `key:` suffix spelling is a **block-layout affordance** — it works on indented lines
under a kwarg head. Inline, inside parens, use the `:key` prefix:
`(dict :id r[:id])`, not `(dict id: r[:id])`.

## At-expressions — prose without escaping

`@head{…}` is a flat tagged template: quotes and newlines inside the braces are literal,
`@x` interpolates a value, `@(expr)` grafts a full form, `@|x|` marks a boundary when
prose glues to the name:

```scheme
@{hello, @|name|!}          ;; ≡ (str "hello, " name "!")
@string-append{a @x b}      ;; ≡ (string-append "a " x " b")

@dedent{
  multi-line prose
  with interpolated @x values
}                            ;; ≡ (str …) with the common indent stripped
```

**Inside a body, `@x` interpolates a bare name and nothing more** — no subscripts, no
dots, no infix attach to it. For anything richer, graft a form with `@(…)`, and inside
the graft you are writing **classic prefix Scheme** (the parens are the form's own
parens, not a wrapper):

```scheme
@{Visit #@(+ visits 1)}       ;; ≡ (str "Visit #" (+ visits 1))
@{from @(:baseline s)}        ;; ≡ (str "from " (:baseline s))

@{Visit #@(visits + 1)}       ;; ✗ calls `visits` — graft is prefix context, no infix
@{from @s[:baseline]}         ;; ✗ interpolates s, then "[:baseline]" is literal prose
```

Headless `@{…}` defaults to `(str …)`. Racket's `at-exp` is the ancestor.

---

That's the surface. The machinery behind it — the round-trip law, span alignment for
editors (`alignSugarcoatClassic`), parameter hints, the runtime-free `parseSexprs` reader —
is in the [README](./README.md) and the design docs in
`docs/package-specific/arrival-sugarcoat/`.
