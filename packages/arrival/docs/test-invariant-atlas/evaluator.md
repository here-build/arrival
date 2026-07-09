> **Historical snapshot (2026-07-08, pre-rework v1 suite).** Files named here may be deleted, renamed, or relocated since (G1/G2/G3 — see `../../REWORK-DAG.md` and `../test-suite-v2/REMOVAL-MANIFEST.md`). Notably `curly-infix.test.ts` and the reader's curly-infix mode itself are deleted (R6 ruling).

## evaluator.spec.ts
### run() trampoline
- INVARIANT: run() drives a bare generator to completion and returns its final return value
- INVARIANT: run() awaits a yielded Promise and resumes with its resolved value
- INVARIANT: run() rejects when a yielded promise rejects, propagating the error

### evaluate()
- INVARIANT: self-evaluating atoms (exact number, string, nil) evaluate to themselves
- INVARIANT: symbol evaluation looks up the value bound in the environment
- INVARIANT: a function-call form evaluates operator and operands, then applies
- INVARIANT: nested function calls evaluate inside-out
- INVARIANT: a JS function bound in env that returns a promise is awaited and its resolved value passed through unboxed

### special forms › quote
- INVARIANT: (quote x) returns its argument unevaluated, structure intact
- INVARIANT: (quote symbol) returns the symbol itself, not its bound value

### special forms › quasiquote
- INVARIANT: a quasiquoted list with no unquotes returns unevaluated, like quote
- INVARIANT: (unquote expr) inside quasiquote evaluates expr and splices the value in place
- INVARIANT: (unquote-splicing expr) evaluates expr to a list and splices its elements into the surrounding list

### special forms › if
- INVARIANT: if evaluates the then-branch when the test is #t
- INVARIANT: if evaluates the else-branch when the test is #f
- INVARIANT: if treats '() (nil) as truthy — only #f is false
- INVARIANT: if with no else-branch returns the unspecified/void value when the test is false
- INVARIANT: nested if expressions select the correct branch at each level

### special forms › begin
- INVARIANT: begin evaluates its expressions in order and returns the last one's value
- INVARIANT: an empty begin returns the unspecified/void value
- INVARIANT: begin executes every expression for its side effects, in sequence

### special forms › define
- INVARIANT: (define x v) evaluates v and binds it in the environment [impl-pinning]
- INVARIANT: define evaluates the value expression before binding (not the literal form) [impl-pinning]
- INVARIANT: (define (f args) body) shorthand defines f as a callable ALambda carrying that name

### special forms › lambda
- INVARIANT: (lambda (params) body) creates a callable ALambda exposing the tagless-final apply term
- INVARIANT: applying a lambda binds params and evaluates the body
- INVARIANT: a lambda closes over its defining environment
- INVARIANT: a symbol (non-list) parameter spec binds all arguments as a rest-parameter list

### special forms › let
- INVARIANT: let binds each named variable to its init value, visible in the body
- INVARIANT: let uses parallel binding semantics — an init expression cannot see sibling bindings
- INVARIANT: named let establishes a self-referencing loop procedure

### special forms › let*
- INVARIANT: let* binds sequentially — each init can see previously bound siblings

### special forms › letrec
- INVARIANT: letrec allows a binding's lambda value to recursively reference itself

### special forms › and
- INVARIANT: (and) with no operands returns #t
- INVARIANT: and short-circuits on the first #f without evaluating the rest
- INVARIANT: and returns the value of its last operand when all are true

### special forms › or
- INVARIANT: (or) with no operands returns #f
- INVARIANT: or short-circuits on the first truthy value without evaluating the rest
- INVARIANT: or returns the value of its last operand when all are false (0 is truthy)

### special forms › cond
- INVARIANT: cond evaluates the body of the first clause whose test is truthy
- INVARIANT: cond evaluates the else clause when no test matches
- INVARIANT: a clause with only a test (no body) returns the test's value
- INVARIANT: (test => proc) applies proc to the test's value when the test is truthy

### special forms › case
- INVARIANT: case dispatches to the clause whose datum list contains a value matching the key
- INVARIANT: case falls back to else when no datum list matches

### special forms › when
- INVARIANT: when executes its body and returns the last value when the test is true
- INVARIANT: when returns the unspecified/void value when the test is false

### special forms › unless
- INVARIANT: unless executes its body and returns the last value when the test is false
- INVARIANT: unless returns the unspecified/void value when the test is true

### special forms › do
- INVARIANT: do iterates, re-evaluating step expressions, until the test clause is true, then returns the result expression
- INVARIANT: do executes the command body once per iteration for its side effects

### special forms › define-macro
- INVARIANT: define-macro's quasiquote/unquote-splicing template rewrites the call site, and the rewritten form is then evaluated

### special forms › delay/force — omitted by the purity invariant
- INVARIANT: delay is no longer a working special form — evaluating (delay …) throws rather than deferring

### performance - deep recursion
- INVARIANT: a deeply right-nested (+ 1 (+ 1 … 0)) expression (10k levels) evaluates without stack overflow
- INVARIANT: a deeply nested if-expression chain (10k levels) evaluates without stack overflow
- INVARIANT: tail-recursive self-call reaches 10k depth without exhausting the host call stack (§3.5 TCO)

## generator-exec.spec.ts
### exec() - basic operations
- INVARIANT: string-source arithmetic evaluates through the full parser+evaluator pipeline
- INVARIANT: multiple top-level expressions each produce one result, in order
- INVARIANT: define binds a value (returning void) and later top-level forms see the binding
- INVARIANT: lambdas parsed from string source evaluate/apply correctly
- INVARIANT: nested arithmetic expressions compose correctly from string source

### exec() - special forms
- INVARIANT: if from string source selects the correct branch for both #t and #f
- INVARIANT: let bindings from string source resolve correctly
- INVARIANT: let* sequential bindings from string source resolve correctly
- INVARIANT: letrec supports recursive definition (factorial) from string source
- INVARIANT: begin sequencing from string source returns the last value
- INVARIANT: and/or short-circuit and value semantics hold from string source
- INVARIANT: cond with else from string source selects the matching clause
- INVARIANT: case dispatch from string source selects the matching clause

### exec() - data structures
- INVARIANT: quote from string source produces pair structure, not evaluated
- INVARIANT: quasiquote+unquote inside a let produces the correctly spliced list
- INVARIANT: cons/car/cdr operate correctly on quoted list data from string source

### exec() - named let
- INVARIANT: named let performs iterative accumulation (factorial via loop) correctly

### exec() - macros
- INVARIANT: a define-macro definition and its use can appear in the same source text and expand correctly

### exec() - do loop
- INVARIANT: a do loop accumulates a running sum correctly across iterations

### parse()
- INVARIANT: parse() returns parsed forms without evaluating them
- INVARIANT: parse() returns one entry per top-level form

### execExpr()
- INVARIANT: execExpr evaluates a single already-parsed expression

### error handling
- INVARIANT: referencing an unbound variable throws an "Unbound variable" error
- INVARIANT: unterminated/malformed source throws a parse error

### async/promise handling
- INVARIANT: a lambda defined in one top-level form is usable, and returns the correct value, in a later top-level form of the same exec() call

### try/catch/finally
- INVARIANT: try returns the body's value when no exception is raised
- INVARIANT: a raised exception inside try's body is caught by its catch clause, whose value is returned
- INVARIANT: try's finally clause runs after a successful body, after the body
- INVARIANT: try's finally clause runs after catch handles a raised exception, in body→catch→finally order
- INVARIANT: binding the error to the catch variable exposes error-object accessors (skipped, not enforced)

### guard (R7RS exception handling)
- INVARIANT: guard's matching clause (#t) catches a raised exception and returns the clause's value
- INVARIANT: guard returns the body's value unchanged when no exception is raised
- INVARIANT: guard matches specific error-object? conditions and extracts the message (skipped, not enforced)

### parameterize (describe.skip — none enforced)
- INVARIANT: make-parameter/parameterize create a dynamically-scoped parameter (not enforced, whole block skipped)
- INVARIANT: parameterize rebinds the parameter's value for the dynamic extent of its body (not enforced, skipped)
- INVARIANT: the parameter's value is restored after parameterize's body completes (not enforced, skipped)

## tail-call.test.ts
### positive — O(1) stack at 50k depth (would overflow pre-TCO)
- INVARIANT: self-recursion via define — if's else-arm is a tail call, O(1) stack to 50k depth (§3.5)
- INVARIANT: named-let's loop body is a tail call w.r.t. the (loop …) call site, O(1) to 50k
- INVARIANT: mutual tail recursion (even?/odd?) — each call sits in the other's if-tail-arm, O(1) to 50k
- INVARIANT: cond's else-arm body inherits tail position, O(1) to 50k
- INVARIANT: cond's matched non-else clause body is also tail, O(1) to 50k
- INVARIANT: case's matched clause body inherits tail position, O(1) to 50k
- INVARIANT: cond's => arm — the (proc test-value) application is itself tail, O(1) to 50k
- INVARIANT: case's => arm — the (proc key) application is itself tail, O(1) to 50k
- INVARIANT: when's last body expression is tail when the test passes, O(1) to 50k
- INVARIANT: unless's last body expression is tail when the test fails, O(1) to 50k
- INVARIANT: and's final conjunct is in tail position, O(1) to 50k
- INVARIANT: or's final disjunct is in tail position, O(1) to 50k
- INVARIANT: begin's final expression is the only one in tail position, O(1) to 50k
- INVARIANT: let's body inherits the enclosing form's tail position, O(1) to 50k
- INVARIANT: let*'s body inherits the enclosing form's tail position, O(1) to 50k
- INVARIANT: letrec's body inherits the enclosing form's tail position, O(1) to 50k
- INVARIANT: an immediately-applied lambda in tail position collapses both the application and its body's tail call, O(1) to 50k

### negative — NON-tail positions must NOT be over-optimized
- INVARIANT: a recursive call in argument position (e.g. inside +) is NOT tail-collapsed — every pending frame still executes
- INVARIANT: a non-last expression in begin still executes its side effect after each recursive (non-tail) call returns, in order
- INVARIANT: a non-last begin expression's sequencing stays intact — the trailing expression after a non-recursive call is still returned

### composition
- INVARIANT: a collapsed tail call composes onResolve/onReject onto the replacement frame so every popped frame's tap exit still fires (enter count == exit count) [impl-pinning]
- INVARIANT: the value threaded back through a collapsed tail chain is the correct base-case value, never lost/replaced with undefined
- INVARIANT: a computed accumulator (not just a constant) threads correctly through a collapsed named-let tail loop

## abort.test.ts
### AbortSignal execution budget
- INVARIANT: an in-progress evaluation aborts (rejects) once its AbortSignal fires, within the trampoline's tick cadence
- INVARIANT: exec refuses immediately, without allocating trampoline state, when given an already-aborted signal
- INVARIANT: a custom signal.reason surfaces verbatim in the thrown error, not a generic AbortError
- INVARIANT: a signal.reason set on a mid-execution abort surfaces verbatim in the thrown error
- INVARIANT: passing a non-aborting AbortSignal does not alter normal evaluation
- INVARIANT: execExpr (single pre-parsed expression) honors an already-aborted signal identically to exec
- INVARIANT: an abort with no explicit reason throws an error recognizable as an abort (Web AbortError shape)
- INVARIANT: raceAbort rejects immediately on abort without waiting for a still-pending (never-settling) value [impl-pinning]
- INVARIANT: raceAbort rejects immediately when given an already-aborted signal [impl-pinning]
- INVARIANT: raceAbort's rejection carries the signal's custom reason verbatim [impl-pinning]
- INVARIANT: raceAbort resolves with the value when it settles first, and a later abort on the same signal is inert (no stray rejection) [impl-pinning]
- INVARIANT: raceAbort keeps a rejection handler on an abandoned (post-abort) value so its late rejection never surfaces as unhandledRejection [impl-pinning]

## chibi-r7rs.spec.ts
(harness-level invariants only — the ~600 vendored R7RS rows are not enumerated)
### Chibi R7RS Official Tests (harness machinery)
- INVARIANT: the vendored r7rs-tests.scm executes exactly once, section-by-section, on one shared capability-assembled env (cross-section state carries forward) [impl-pinning]
- INVARIANT: a section that throws (a purity door, an unbound feature) aborts only that section; later sections still run [impl-pinning]
- INVARIANT: complex-number literals/procedures are stripped from source text before parsing, since a complex datum doors at read-time and would otherwise abort its whole section [impl-pinning]
- INVARIANT: an outcome whose name/group matches EXCLUDED_TESTS/EXCLUDED_GROUPS is reported skipped, never pass or fail [impl-pinning]
- INVARIANT: an outcome matching EXPECTED_FAILURES is reported skipped as a documented deviation, not a gate failure [impl-pinning]
- INVARIANT: an outcome matching SKIPPED_TESTS is reported skipped with its documented reason [impl-pinning]
- INVARIANT: a failing outcome matching none of the exclusion/expected-failure/skip registries is reported as its own red vitest test [impl-pinning]
- INVARIANT: anti-vacuity sanity floor — the suite must produce >500 results and >500 passes, so silently executing zero tests fails loudly instead of passing green [impl-pinning]
- INVARIANT: a catastrophic suite-execution failure (env build/assembly) surfaces as one red "suite failed to execute" test rather than hiding every row [impl-pinning]
- INVARIANT: the "Read syntax" test group is excluded wholesale (datum-comment-in-dotted-pair parser limitation) [impl-pinning]

## r7rs-numbers.test.ts
### r7rs numbers — passing invariants (regression guards)
- INVARIANT: (expt 2 10) stays exact when the result fits a safe JS integer
- INVARIANT: (expt 0 0) is 1 per R7RS §6.2's special case
- INVARIANT: (eqv? +inf.0 +inf.0) is #t per R7RS §6.2
- INVARIANT: (inexact 1/2) converts an exact rational to the float 0.5

### r7rs numbers — exactness/precision fixes (regression guards)
- INVARIANT: (expt 2 -1) returns an exact 1/2, not inexact 0.5
- INVARIANT: (expt 2 1000) returns an exact bigint, not a lossy inexact approximation
- INVARIANT: (< 999999999999999998 999999999999999999) returns #t for huge exact integers (no double-precision collapse)
- INVARIANT: (exact 1e-10) does not throw and returns a correct exact rational
- INVARIANT: (number->string 5.0) preserves the inexact mark ("5." or "5.0"), not "5"
- INVARIANT: exact->inexact is bound as the R5RS alias for inexact
- INVARIANT: inexact->exact is bound as the R5RS alias for exact

## r7rs-unicode.test.ts
### r7rs unicode — passing invariants (regression guards)
- INVARIANT: string-length on a non-BMP emoji returns code-point count (1), not UTF-16 code-unit count (2)
- INVARIANT: char->integer on an ASCII character returns its ASCII codepoint
- INVARIANT: char-foldcase on a single-folded char (#\A → #\a) works correctly

### r7rs unicode — known bugs (currently asserting the fixed/correct behavior)
- INVARIANT: char->integer on a non-BMP character (😀) returns the full Unicode code point (128512), not the truncated UTF-16 surrogate
- INVARIANT: integer->char round-trips a non-BMP code point (128512) correctly
- INVARIANT: char-foldcase on #\ß returns #\ß unchanged (multi-char Unicode folds are identity per R7RS §6.6)
- INVARIANT: char-alphabetic? recognizes CJK ideographs (Unicode category Lo)
- INVARIANT: (integer->char 7) names as #\alarm (R7RS-canonical), not the SRFI-175 alias #\bel

## r7rs-identity.test.ts
### r7rs identity — passing invariants (regression guards)
- INVARIANT: eq? on interned symbols ('foo 'foo) is #t
- INVARIANT: eq? on two distinct (list 1) calls is #f
- INVARIANT: eqv? on two distinct vector copies is #f
- INVARIANT: string-length counts Unicode code points, not UTF-16 code units, through the public binding

### r7rs identity — known bugs (currently asserting the fixed/correct behavior)
- INVARIANT: eq? on two distinct string-copy results is #f
- INVARIANT: eqv? on two distinct string-copy results is #f
- INVARIANT: eqv? on two distinct make-string results is #f

## syntax-rules-arity-offbyone.test.ts
### syntax-rules matcher off-by-one (PRE-EXISTING pre-L1 gap — drops first code element)
- INVARIANT: a fixed 1-arg pattern ((_ a) a) binds and returns its var correctly
- INVARIANT: a fixed 2-arg pattern ((_ a b) (list a b)) binds both vars correctly
- INVARIANT: arity discrimination selects the rule matching the actual argument count, not off by one
- INVARIANT: an ellipsis pattern ((_ a ...) (list a ...)) keeps element 0
- INVARIANT: a head+ellipsis pattern ((_ h a ...) (list h a ...)) keeps the head element

### syntax-rules VECTOR patterns (boxing S9 — needs the matcher fix AND a SchemeVector unwrap)
- INVARIANT: a fixed vector pattern #(a b) matches and binds both elements [fails]
- INVARIANT: a vector pattern with ellipsis #(a ...) matches and binds all elements [fails]
- INVARIANT: a vector template emits an actual AVector value, not a list [fails]

## let-bracket-binding-door.test.ts
### bracket bindings — R2b per-element (Racket) consumption
- INVARIANT: let*'s per-element bracket bindings evaluate identically to their paren image
- INVARIANT: let's per-element bracket binding evaluates identically to its paren image
- INVARIANT: letrec's per-element bracket binding supports self-reference identically to its paren image
- INVARIANT: letrec*'s per-element bracket bindings evaluate identically to their paren image
- INVARIANT: do's per-element bracket bindings (with step) evaluate identically to their paren image
- INVARIANT: named let's Racket-style per-element bracket bindings consume, not silently binding zero params
- INVARIANT: a nested application inside a bracketed binding's init is consumed verbatim, identically to the paren image

### bracket bindings — R2a whole-list (Clojure) consumption
- INVARIANT: let's whole-list bracket binding evaluates identically to the paired paren image
- INVARIANT: named let's Clojure-style whole-list bracket bindings consume correctly
- INVARIANT: named let's Clojure-style whole-list bracket bindings recurse correctly
- INVARIANT: let*'s whole-list bracket bindings evaluate identically to the paren image
- INVARIANT: letrec's whole-list bracket bindings evaluate identically to the paren image

### bracket bindings — R2c mixing (paren pairs and bracket vectors together)
- INVARIANT: mixing a bracket-vector binding and a paren-pair binding in one bindings list is legal, judged elementwise

### bracket bindings — R3 equivalence (direct pin)
- INVARIANT: the bracket-binding form is equal? to its paren image, checked from within scheme itself
- INVARIANT: shadowing (rebinding in nested lets) behaves identically under bracket vs paren bindings
- INVARIANT: a bracket binding closes over a lambda exactly like the paren form

### bracket bindings — R2a whole-list grouped by POSITION, never by value atomicity
- INVARIANT: let*'s whole-list value computed from a prior sibling binding groups correctly by position
- INVARIANT: let's whole-list values that are all compound expressions still group correctly by position
- INVARIANT: let*'s interleaved atomic/compound whole-list values group correctly by position
- INVARIANT: let's lambda value at an odd whole-list position is a value, not a grouping boundary
- INVARIANT: let's whole-list bindings keep parallel semantics — a value sees only the outer binding, never a sibling's

### bracket bindings — a binding NAME may be a scope keyword (slots are data, not re-parsed)
- INVARIANT: a per-element binding named after a scope keyword (e.g. `let`) binds and reads back as a plain name
- INVARIANT: a whole-list binding named after a scope keyword binds and reads back as a plain name
- INVARIANT: a whole-list binding with two keyword-named bindings both read back as plain names
- INVARIANT: a keyword-named let* binding is usable as a plain name in a later compound value

### bracket bindings — R4 doors: whole-list malformations (E-LET-BRACKET-BINDINGS-LIST)
- INVARIANT: an odd element count in a whole-list vector binding doors, naming "odd number of elements" and echoing the offending vector [impl-pinning]
- INVARIANT: an odd element count doors identically for let* [impl-pinning]
- INVARIANT: do rejects the whole-list bracket form outright, pointing the caller at the per-element form with a corrected echo [impl-pinning]

### bracket bindings — R4 doors: per-element malformations (E-LET-BRACKET-BINDING)
- INVARIANT: a per-element vector binding with wrong length (3, expected 2) doors, naming the count and expected shape [impl-pinning]
- INVARIANT: a per-element vector binding for do with wrong length (4, expected 2–3) doors, naming the count [impl-pinning]
- INVARIANT: a destructuring name slot (vector where a symbol is expected) doors, explaining destructuring is unsupported [impl-pinning]
- INVARIANT: the same destructuring-name-slot door fires identically for the whole-list form [impl-pinning]
- INVARIANT: a non-symbol, non-vector name slot doors with a generic "binding name must be a symbol" message [impl-pinning]

### bracket bindings — R5 negatives (never consumed outside the six forms' bindings slots)
- INVARIANT: a bracketed value in a binding's INIT position is legal vector data, not a binding
- INVARIANT: a #(...) constant-vector init value is legal data too
- INVARIANT: a bracket literal in the BODY (not a binding position) is legal, ordinary vector data
- INVARIANT: a quoted let form's bracket bindings are inert data, never evaluated or consumed
- INVARIANT: a quoted let form's binding-slot vector holds the raw, unconsumed symbol datum
- INVARIANT: a #(...) constant sitting in binding position never triggers a bracket-binding door — the unrelated generic invariant fires instead

### bracket bindings — passthrough (unrelated malformed bindings, unchanged)
- INVARIANT: a bare symbol used as a binding still hits the pre-existing generic "invalid binding" invariant, not a bracket door
- INVARIANT: do-as-begin misuse (a define form as do's bindings) still hits the generic invariant, not a bracket door
- INVARIANT: nested lets — each form's own well-formed bracket bindings consume independently of the other

## cond-case-do-bracket-clause.test.ts
### bracket clauses — cond (R9)
- INVARIANT: a bracket test clause [test result] in cond consumes, evaluating identically to its paren image
- INVARIANT: a bracket else clause in cond consumes identically to its paren image
- INVARIANT: a bracket => clause in cond consumes identically to its paren image
- INVARIANT: cond falls through to a later bracket clause when earlier tests are false
- INVARIANT: cond with no matching bracket clause returns the unspecified value, same as the paren form
- INVARIANT: bracket and paren clauses may be mixed within one cond form
- INVARIANT: a bracket clause's body containing bracket let bindings composes correctly (R9 + R2)

### bracket clauses — case (R9)
- INVARIANT: a bracket clause with a parenthesized datum-list head consumes, matching identically to its paren image
- INVARIANT: a bracket else clause in case consumes identically to its paren image
- INVARIANT: a bracket => clause in case consumes identically to its paren image
- INVARIANT: case with no matching bracket clause and no else returns the unspecified value, same as the paren form
- INVARIANT: the datum-list head of a bracket case clause stays a LIST and matches correctly

### bracket clauses — do's test clause (R9)
- INVARIANT: a bracket test clause in do consumes identically to its paren image
- INVARIANT: a bracket test clause with multiple result expressions consumes correctly
- INVARIANT: do's binding brackets (R2) and its test-clause bracket (R9) compose correctly

### bracket clauses — R9 doors: E-COND-BRACKET-CLAUSE (empty clause)
- INVARIANT: cond doors on an empty bracket clause [], naming it empty [impl-pinning]
- INVARIANT: case doors on an empty bracket clause [] identically [impl-pinning]
- INVARIANT: do doors on an empty bracket test clause [] identically [impl-pinning]

### bracket clauses — R9 doors: E-CASE-BRACKET-DATUM-LIST (vector datum head)
- INVARIANT: case doors on a bracket-vector datum-list head, naming it a vector and showing the corrected paren form [impl-pinning]
- INVARIANT: a #(...) constant-vector datum head is not caught by R9's door — the pre-existing generic invariant fires instead

### bracket clauses — R5 negatives (still hold: '[…]' as a VALUE stays a vector)
- INVARIANT: a bracket vector used as cond's TEST EXPRESSION (not a clause wrapper) stays an ordinary vector value
- INVARIANT: a bracket vector in a clause's BODY position is legal vector data, not consumed as a clause
- INVARIANT: a quoted cond form's bracket clause is inert, unconsumed vector datum
- INVARIANT: a #(...) constant clause in cond's clause position never triggers a bracket-clause door — the generic invariant fires instead

### bracket clauses — passthrough (unrelated malformed clauses, unchanged)
- INVARIANT: a bare symbol clause in cond still hits the generic "invalid clause" invariant, not a bracket door
- INVARIANT: a bare (non-pair, non-else) clause in case still hits the generic "invalid clause" invariant, not a bracket door

## keyword-syntax.test.ts
### LIPS Keyword Syntax Investigation
(exploratory/investigation file; several tests assert nothing determinate — noted inline)
- INVARIANT: bare `:keyword` evaluation is non-committal here — the test accepts either a no-throw result or an "Unbound variable" error (weak/exploratory assertion)
- INVARIANT: `(:key obj)` invokes the keyword as an accessor, retrieving the object property named by the keyword
- INVARIANT: quoted `':keyword` is exercised only via logging — no fixed contract is asserted
- INVARIANT: multiple accessor syntax variants (string key, quoted symbol, bare symbol, escaped symbol) are logged for comparison — no assertions made
- INVARIANT: a bar-quoted numeric symbol used as a variable reference resolves through env binding like a normal identifier
- INVARIANT: a keyword used as map's procedure extracts the named property from each element
- INVARIANT: a keyword used as filter's predicate extracts and truth-tests the named boolean property on each element
- INVARIANT: a keyword accessor on a missing property returns nil (ANil), not an error

## escaped-symbols.test.ts
### Basic escaped symbols
- INVARIANT: a bar-quoted numeric symbol |24| can be defined and referenced as a variable name
- INVARIANT: a bar-quoted symbol containing spaces can be defined and referenced as a variable name
- INVARIANT: a bar-quoted symbol containing special characters can be defined and referenced as a variable name

### Escaped symbols with property access
- INVARIANT: a keyword-escaped numeric key :|24| accesses the correspondingly-named object property

### Escaped symbols in function names
- INVARIANT: a bar-quoted function name can be defined (via defineRosetta) and invoked
- INVARIANT: a bar-quoted function name containing spaces can be defined and invoked

### Keywords vs escaped symbols
- INVARIANT: :24 and :|24| both resolve to the same numeric-string object key via @
- INVARIANT: keywords with hyphens/underscores resolve to their correspondingly-named object properties

### Edge cases and resolution
- INVARIANT: the empty bar-quoted symbol || (empty-string name) can be defined and referenced (R7RS §7.1.1)
- INVARIANT: a bar-quoted symbol may contain Unicode characters in its name
- INVARIANT: an escaped bar \| inside |...| decodes to a literal | in the symbol's name (R7RS §7.1.1)
- INVARIANT: case sensitivity is preserved between two distinct bar-quoted symbols differing only in case

### MCP real-world patterns
- INVARIANT: a UUID string used as a bar-quoted keyword key accesses the corresponding object property
- INVARIANT: chained property access composes bar-quoted/keyword accessors across nested objects and mixed key types
- INVARIANT: filter composes with a lambda using string=? and a bar-quoted-keyword accessor to select matching objects

## curly-infix.test.ts
### curly-infix — lexer tokenization
- INVARIANT: braces tokenize as standalone tokens, splitting an adjacent symbol
- INVARIANT: empty braces tokenize as two standalone tokens
- INVARIANT: a hyphenated symbol stays one token; only whitespace-bounded operators split
- INVARIANT: nested braces tokenize correctly at each depth
- INVARIANT: a trailing brace splits off its preceding symbol
- INVARIANT: square brackets tokenize as standalone tokens
- INVARIANT: comma is a delimiter token (R7RS), splitting off an adjacent atom
- INVARIANT: `,@` stays one token; `#\,` (comma char literal) stays one token

### curly-infix — SRFI-105 base classifier (flag on)
- INVARIANT: `{}` reads as the empty list
- INVARIANT: a single-element curly form escapes to just that element
- INVARIANT: a two-element curly form reads as prefix/unary
- INVARIANT: a binary curly form reads as prefix
- INVARIANT: a same-operator run folds n-ary into one prefix form
- INVARIANT: curly nested on the right resolves inner-to-outer
- INVARIANT: curly nested on the left resolves inner-to-outer
- INVARIANT: hyphenated operands stay whole symbols inside curly-infix

### curly-infix — arithmetic precedence (formal divergence, flag on)
- INVARIANT: multiplicative operators bind tighter than additive
- INVARIANT: same-precedence mixed operators fold left-associatively
- INVARIANT: an additive run stays n-ary while a nested multiplicative run collapses to one operand
- INVARIANT: named arithmetic operators (e.g. modulo) participate in precedence like symbolic operators

### curly-infix — any single operator folds (SRFI-105, flag on)
- INVARIANT: a lone boolean/comparison operator folds as a plain binary form
- INVARIANT: a same-operator run folds n-ary regardless of which operator
- INVARIANT: any symbol occupying the operator position is treated as the operator

### curly-infix — errors-as-door for MIXED operators (flag on)
- INVARIANT: mixing two different boolean/comparison operators doors with "ambiguous operator mix" [impl-pinning]
- INVARIANT: mixing an arithmetic operator with an unlicensed operator doors with "ambiguous operator mix" plus a disambiguation hint [impl-pinning]
- INVARIANT: malformed parity (trailing operator) doors with "malformed infix" [impl-pinning]
- INVARIANT: a non-operator wedged into an operator slot doors with "malformed infix" [impl-pinning]

### curly-infix — quote distribution (flag on)
- INVARIANT: quote wraps the curly form's resolved datum, not the raw curly syntax
- INVARIANT: quasiquote/unquote compose correctly with the curly-infix transform

### curly-infix — non-regression (flag on)
- INVARIANT: square brackets still read as a vector literal even with curlyInfix on (flag scopes only `{}`)
- INVARIANT: ordinary parenthesized forms are unaffected by the curly-infix flag
- INVARIANT: a curly form nested inside a normal list resolves correctly in place
- INVARIANT: a vector literal is a valid infix operand within a curly form
- INVARIANT: multiple top-level curly forms each read independently

### curly-infix — structural errors (flag on)
- INVARIANT: an unterminated curly brace doors with "unterminated curly-infix" [impl-pinning]
- INVARIANT: a stray closing brace doors with "unexpected '}'" [impl-pinning]
- INVARIANT: a dotted pair inside curly-infix is rejected with "'.' not allowed in curly-infix" [impl-pinning]
- INVARIANT: deep curly nesting (3000 levels) trips a stack-depth guard [impl-pinning]
- INVARIANT: a `(` closed by mismatched `}` doors as a bracket mismatch [impl-pinning]
- INVARIANT: a `{` closed by mismatched `)` doors as a bracket mismatch [impl-pinning]
- INVARIANT: a stray `)` is rejected as unexpected [impl-pinning]

### the flag gate — default (flag OFF) is the dict/vector literal grammar
- INVARIANT: with curlyInfix off, `{:a 1}` reads as a dict-literal node, not curly-infix
- INVARIANT: with the flag off, `{a + b}` doors as a malformed dict literal (bare-symbol key), not infix
- INVARIANT: with the flag on, `{:a 1 :b}` still doors as malformed infix, confirming the flag switches grammar rather than special-casing keywords
- INVARIANT: `[…]` reads as a vector literal identically regardless of the curlyInfix flag

### curly-infix — pure module is independently testable
- INVARIANT: FIXITY licenses exactly the arithmetic operator set {*, +, -, /, modulo, quotient, remainder}, with * binding tighter than + [impl-pinning]
- INVARIANT: canonicalizeCurly escapes a single-element list to just that element [impl-pinning]

## parser.test.ts
### Parser — atoms
- INVARIANT: the parser reads a bare symbol datum
- INVARIANT: the parser reads integer and negative-integer numeric literals
- INVARIANT: the parser reads #t/#f boolean literals

### Parser — lists
- INVARIANT: the parser reads a flat list
- INVARIANT: the parser reads a nested list
- INVARIANT: the parser reads the empty list ()
- INVARIANT: the parser reads a dotted pair (a . b)

### Parser — quote sugar (builtin extensions)
- INVARIANT: ' expands to (quote x) without env lookup
- INVARIANT: `,`,@` expand to (quasiquote x)/(unquote x)/(unquote-splicing x) without env lookup

### Parser — vectors & strings
- INVARIANT: #(...) reads as a boxed AVector wrapping its elements
- INVARIANT: a string literal reads to its raw content via bare toString()

### Parser — bar-quoted symbols (R7RS §7.1.1)
- INVARIANT: a bar-quoted symbol with spaces reads to a symbol whose name is the literal spaced text
- INVARIANT: multiple bar-quoted symbols in a list each read as distinct symbols with their literal names
- INVARIANT: the empty bar-quoted symbol || reads as the symbol whose name is the empty string
- INVARIANT: an escaped bar \| inside |...| decodes to a literal | in the symbol's name
- INVARIANT: an inline hex escape \xHH; inside |...| decodes to its Unicode codepoint
- INVARIANT: the mnemonic escapes \t \n \r inside |...| decode to tab/newline/CR
- INVARIANT: the mnemonic escapes \a (alarm) and \b (backspace) inside |...| decode correctly
- INVARIANT: an unrecognized backslash escape inside |...| is rejected
- INVARIANT: a symbol whose name requires bars round-trips through toString(true) and re-parsing to an equal name
- INVARIANT: a symbol whose name contains both a bar and a backslash round-trips correctly
- INVARIANT: the empty symbol round-trips through toString(true) as || and re-parses to the empty name
- INVARIANT: a plain (bar-free) symbol prints without bars even when toString is asked to quote

### Parser — multiple top-level forms
- INVARIANT: the parser reads each top-level datum in sequence
- INVARIANT: the parser skips line comments between top-level forms

## module-composition.spec.ts
### Environment Module Composition › Resolver Yielding
- INVARIANT: multiple registered resolvers are tried in registration order until one returns a defined value [impl-pinning]
- INVARIANT: a resolver returning undefined "yields" (search continues); returning null or any other defined value stops the search [impl-pinning]

### Environment Module Composition › _lookupWithResolvers
- INVARIANT: resolution order per environment is direct bindings → registered resolvers → parent environment, checked in that order at each level [impl-pinning]

## syntax-rules-special-forms.test.ts
### syntax-rules → kernel special forms (keyword unlock)
- INVARIANT: a macro whose template expands to `if`+`begin` dispatches through the real kernel special-form handlers, not as a procedure application
- INVARIANT: a macro whose template expands to `let` introduces a genuine (hygienic) lexical binding
- INVARIANT: a template-introduced binding does not capture/shadow a same-named identifier from the use site (hygiene)
- INVARIANT: a recursively-expanding macro through `if` terminates and selects the correct branch after multiple expansion steps

## syntax-rules-tail-proper.test.ts
### syntax-rules — form-returning + tail-proper
- INVARIANT: a syntax-rules macro in tail position recurses to 50k depth without host-stack overflow
- INVARIANT: a template's quoted symbol is restored to its literal name after expansion (no gensym/hygiene-marker leak) [impl-pinning]
- INVARIANT: a quoted LIST of template identifiers is fully restored to literal symbols after expansion
- INVARIANT: hygiene holds under the tail-proper expansion path — a template binding does not capture a user identifier
- INVARIANT: a quasiquote form inside a macro template expands correctly — the unquote hole stays live code while quoted literals are restored

## Summary
- Invariant count: ~346
- Impl-pinning count: ~47
- Files whose entire purpose looks like exercising a test-only API: `module-composition.spec.ts` (built entirely around the private `_lookupWithResolvers`, bypassing the public `exec()`/runtime path by design), `keyword-syntax.test.ts` (exploratory investigation file with several vacuous/logging-only assertions, not a fixed contract), and (partially) the `raceAbort`-direct block in `abort.test.ts` (exercises an internal helper directly rather than through `exec`).
