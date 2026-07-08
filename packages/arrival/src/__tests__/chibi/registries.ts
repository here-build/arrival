// Chibi harness v2 — registries.ts (design: docs/test-suite-v2/chibi-harness-v2.md §4, §11.2).
//
// Typed rule tables replacing v1's substring/regex matching over stringified test names
// (`chibi-r7rs.spec.ts:80-338`). A rule matches a `TestStep` by:
//   - `symbols`  — the step's datum references ANY of the given identifiers, ANYWHERE in its
//                  tree (recursive; see `datumSymbols`). Exact string membership, never a
//                  substring/regex — a hyphenated compound (`list-tail`) never collides with a
//                  bare token (`tail`), which is exactly the class of over-match v1's regexes
//                  risked (`\bport\b` matching inside `output-port`, etc.).
//   - `form`     — the step's whitespace-normalized exact text equals the given string. Reserved
//                  for one-off rows where no identifier in the form is safely unique (common
//                  short names like `bar`/`ff`/`tail`/`=>` are reused across unrelated tests
//                  elsewhere in the corpus — verified by grep against r7rs-tests.scm, not
//                  assumed).
//   - `section`  — the step's `sectionPath` includes the given name (mirrors v1's
//                  `EXCLUDED_GROUPS`).
//
// Precedence: excluded > expected-failure > staged > run (§4). Every `ExpectedFailure` carries
// a `gate` — either the plan/issue that closes it, or an honest "permanent" note for the two
// rows that are IEEE-754 floor effects, not gaps.
//
// Transcription notes (deviations from v1, each deliberate — see the design doc §11.2):
//   - v1's `(real? -2.5)` EXPECTED_FAILURE no longer matches: the corpus's real? tests now use
//     genuine complex literals (`-2.5+0i`, `-2.5+0.0i`), which door at READ time (arrival omits
//     the complex tower) and become `unreadable` steps — never reaching a TestStep at all.
//     Dropped rather than carried as a guaranteed-dead rule.
//   - v1's `/set-cdr!.*ls1/` (excluding two cyclic-list tests "for lack of cycle-detection
//     support") is SUPERSEDED by the general `set-cdr!` purity ExpectedFailure below — those
//     tests call `set-cdr!` directly, which doors on purity grounds regardless of cycle
//     support, a more accurate root cause. Not transcribed as its own rule.
//   - v1's `"(define-syntax swap!"` IS real (line 660-670: a `(test '(2 1) (let (…) (define-syntax
//     swap! …) (swap! x y) (list x y)))` standalone test) — transcribed via the `swap!`
//     identifier (verified unique to this one test).
import type { Manifest, TestStep } from "./manifest.js";
import { normalizeText } from "./manifest.js";

export type Matcher =
  | { kind: "symbols"; anyOf: readonly string[] }
  | { kind: "form"; exact: string }
  | { kind: "section"; name: string };

export interface Exclusion {
  match: Matcher;
  feature: string;
  note?: string;
}

export interface ExpectedFailure {
  match: Matcher;
  reason: string;
  gate: string;
  maxMatches?: number;
}

export interface Staged {
  match: Matcher;
  spec: string;
}

export type Verdict =
  | { run: "it" }
  | { run: "skip"; feature: string }
  | { run: "fails"; reason: string; gate: string }
  | { run: "todo"; spec: string };

function matchesRule(match: Matcher, step: TestStep): boolean {
  switch (match.kind) {
    case "symbols":
      return match.anyOf.some((name) => step.symbols.has(name));
    case "form":
      return normalizeText(step.text) === match.exact;
    case "section":
      return step.sectionPath.includes(match.name);
  }
}

// ── EXCLUDED — features omitted by design (§11.2 point 2: substring rules → symbols matchers
//    where the substring was an identifier, form matchers where it was a one-off snippet). ────

export const EXCLUDED: readonly Exclusion[] = [
  {
    match: {
      kind: "symbols",
      anyOf: [
        "port?",
        "input-port?",
        "output-port?",
        "textual-port?",
        "binary-port?",
        "input-port-open?",
        "output-port-open?",
        "close-port",
        "close-input-port",
        "close-output-port",
        "current-input-port",
        "current-output-port",
        "current-error-port",
        "open-input-string",
        "open-output-string",
        "get-output-string",
        "open-input-bytevector",
        "open-output-bytevector",
        "get-output-bytevector",
        "open-input-file",
        "open-output-file",
        "with-input-from-file",
        "with-output-to-file",
        "call-with-input-file",
        "call-with-output-file",
        "call-with-port",
        "eof-object",
        "eof-object?",
        "peek-char",
        "read-char",
        "read-line",
        "read-string",
        "read-u8",
        "read-bytevector",
        "read-bytevector!",
        "char-ready?",
        "u8-ready?",
        "write-char",
        "write-string",
        "write-u8",
        "write-bytevector",
        "write-simple",
        "write-shared",
        "write",
        "display",
        "newline",
        "flush-output-port",
        "read",
      ],
    },
    feature: "ports & I/O (R7RS §6.13) — sandbox has no port/file I/O",
  },
  {
    match: { kind: "symbols", anyOf: ["file-exists?", "delete-file"] },
    feature: "filesystem — sandbox omits",
  },
  // Block-member symbol-visibility gap (manifest.ts blockMembers): each of these 5 is a
  // `(let* ((out (open-output-string)) (value …)) (test … (get-output-string out)) (test …
  // value))` block (r7rs-tests.scm §6.11, the SRFI-34 with-exception-handler examples) —
  // the `value`-only companion test doesn't itself reference `open-output-string`/
  // `get-output-string` (that's in the block's OWN binding head), so the ports Exclusion
  // above never sees it. The sibling test in each pair (which DOES mention
  // `get-output-string` directly) is already caught correctly.
  {
    match: { kind: "form", exact: normalizeText(`(test 65 value)`) },
    feature: "ports & I/O (R7RS §6.13) — sandbox has no port/file I/O",
    note: "block-member symbol-visibility gap: `out`/`value` come from `open-output-string` in the enclosing `let*`, not this test's own datum",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 'exception value)`) },
    feature: "ports & I/O (R7RS §6.13) — sandbox has no port/file I/O",
    note: "same block-member symbol-visibility gap as the row above",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 'positive value)`) },
    feature: "ports & I/O (R7RS §6.13) — sandbox has no port/file I/O",
    note: "same block-member symbol-visibility gap as the row above",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 'negative value)`) },
    feature: "ports & I/O (R7RS §6.13) — sandbox has no port/file I/O",
    note: "same block-member symbol-visibility gap as the row above",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 'zero value)`) },
    feature: "ports & I/O (R7RS §6.13) — sandbox has no port/file I/O",
    note: "same block-member symbol-visibility gap as the row above",
  },
  {
    match: {
      kind: "symbols",
      anyOf: ["command-line", "exit", "emergency-exit", "get-environment-variable", "get-environment-variables"],
    },
    feature: "process/system (R7RS §6.14) — sandbox omits",
  },
  {
    match: { kind: "symbols", anyOf: ["call-with-current-continuation", "call/cc", "dynamic-wind"] },
    feature: "call/cc / dynamic-wind — not implemented (sandbox design decision)",
  },
  {
    match: { kind: "symbols", anyOf: ["list-length"] },
    feature: "uses call/cc internally (list-length's own reference impl) — sandbox omits continuations",
    note: "the test forms reference `list-length` itself, not call/cc directly — matched by its own name",
  },
  {
    match: { kind: "symbols", anyOf: ["test-exception-handler-1", "something-went-wrong"] },
    feature: "helper (test-exception-handler-1) defined via call-with-current-continuation — sandbox omits continuations",
    note: "sibling test-exception-handler-2 uses `guard` instead and is NOT excluded — matches v1",
  },
  {
    match: { kind: "symbols", anyOf: ["exact-integer-sqrt", "rationalize", "square"] },
    feature: "numeric procedure not yet implemented",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 35 (* root rem))`) },
    feature: "numeric procedure not yet implemented — cascading: `root`/`rem` come from `exact-integer-sqrt` in the enclosing `let*-values`",
    note: "block-member symbol-visibility gap (manifest.ts blockMembers): `exact-integer-sqrt` sits in the block's OWN binding head, not this member's datum",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 0 rem)`) },
    feature: "numeric procedure not yet implemented — cascading: `rem` comes from `exact-integer-sqrt` in the enclosing `let*-values`",
    note: "same block-member symbol-visibility gap as the row above",
  },
  {
    match: { kind: "symbols", anyOf: ["let-values", "let*-values", "call-with-values", "values"] },
    feature: "multiple values (R7RS §6.10) — not fully supported",
  },
  // NOTE: v1 also excluded "define-record-type" — dropped here rather than transcribed. It is
  // structurally DEAD as a symbols-Exclusion: `define-record-type` only ever heads a `setup`
  // step (never a TestStep), so it can never match a manifest.tests row and would permanently
  // trip the dead-rule alarm. The corpus's downstream accessor tests (kons/kar/pare?/set-kar!,
  // r7rs-tests.scm:675-686) use corpus-chosen names not enumerable as a general rule — expected
  // to surface as genuine red, a follow-up triage item, not a harness gap.
  {
    match: { kind: "symbols", anyOf: ["make-rectangular", "make-polar", "real-part", "imag-part", "magnitude", "angle"] },
    feature: "complex tower (R7RS §6.2.3 omitted)",
    note: "the complex LITERAL case doors at read time (an `unreadable` manifest step, handled "
      + "separately in the spec) — this rule covers the ACCESSOR/constructor calls, which parse "
      + "fine and door only at eval",
  },
  {
    match: { kind: "symbols", anyOf: ["environment", "null-environment", "scheme-report-environment"] },
    feature: "eval/environment reification — omitted by design (arrival is pure dataflow)",
  },
  {
    match: { kind: "symbols", anyOf: ["delay", "force", "make-promise", "delay-force", "promise?"] },
    feature:
      "delayed evaluation (R7RS §4.2.5) — omitted by design (defers a value's identity to force-time, not " +
      "construction-site; see r7rs/control.ts's notImplemented doors)",
  },
  {
    match: { kind: "symbols", anyOf: ["make-parameter", "parameterize"] },
    feature:
      "dynamic bindings (R7RS §4.2.6) — omitted by design (ties identity to call-time extent, not " +
      "construction-site; see r7rs/control.ts's notImplemented doors)",
  },
  {
    match: {
      kind: "form",
      exact: normalizeText(`(test 2 (head (tail (tail integers))))`),
    },
    feature: "delayed evaluation (R7RS §4.2.5 omitted) — cascading: `integers`'s own definition uses `delay`",
    note:
      "block-member symbol-visibility gap (manifest.ts blockMembers): the SETUP form defining `integers` via " +
      "`delay` is a sibling of this test, not part of its own datum, so the `delay` Exclusion above never sees " +
      "it — reported as a harness fix design, not editable here",
  },
  {
    match: {
      kind: "form",
      exact: normalizeText(`(test 5 (head (tail (tail (stream-filter odd? integers)))))`),
    },
    feature: "delayed evaluation (R7RS §4.2.5 omitted) — cascading: `stream-filter`/`integers` use `delay-force`/`delay`",
    note: "same block-member symbol-visibility gap as the `integers` row above",
  },
  {
    match: { kind: "symbols", anyOf: ["any-arity", "rest-arity", "dead-clause"] },
    feature: "case-lambda (R7RS §4.2.6-adjacent lambda form) — not implemented (no `case-lambda` binding anywhere in env/)",
  },
  {
    match: { kind: "symbols", anyOf: ["radix"] },
    feature: "dynamic bindings (R7RS §4.2.6 omitted) — cascading: `radix` is defined via the doored `make-parameter`",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test "12" (f 12))`) },
    feature: "dynamic bindings (R7RS §4.2.6 omitted) — cascading: `f` calls the never-defined `radix` parameter",
    note: "block/setup symbol-visibility gap — `f`'s own definition references `radix`, not this test's datum",
  },
  {
    match: {
      kind: "symbols",
      anyOf: ["current-second", "current-jiffy", "jiffies-per-second", "features"],
    },
    feature: "process/system (R7RS §6.14) — sandbox omits (extends the command-line/exit/env-var rule above)",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test #t (list? env))`) },
    feature: "process/system (R7RS §6.14) — sandbox omits `get-environment-variables`",
    note: "block-member symbol-visibility gap: `env` is bound via `get-environment-variables` in the enclosing `let`, not this test's own datum",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test #t (all? env-pair? env))`) },
    feature: "process/system (R7RS §6.14) — sandbox omits `get-environment-variables`",
    note: "same block-member symbol-visibility gap as the row above",
  },
  // -----------------------------------------------------------------------
  // `define-record-type` — genuinely UNBOUND (not a notImplemented door; verified via direct
  // exec: "Unbound variable `define-record-type'"), i.e. not implemented at all. As the
  // superseded-note above (§ "5 Program structure") already anticipated: it only ever heads a
  // `setup` step, never a TestStep, so it's structurally dead as a `symbols` Exclusion; the
  // downstream accessor tests use corpus-chosen names (kons/kar/kdr/pare?/set-kar!) that
  // aren't safely enumerable as a general rule (kar/kdr in particular collide with the
  // c[ad]+r resolver-structural family). Transcribed as five `form`-exact rows instead —
  // the anticipated follow-up triage.
  // -----------------------------------------------------------------------
  {
    match: { kind: "form", exact: normalizeText(`(test #t (pare? (kons 1 2)))`) },
    feature: "define-record-type — not implemented (unbound, R7RS §5.5)",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test #f (pare? (cons 1 2)))`) },
    feature: "define-record-type — not implemented (unbound, R7RS §5.5)",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 1 (kar (kons 1 2)))`) },
    feature: "define-record-type — not implemented (unbound, R7RS §5.5)",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 2 (kdr (kons 1 2)))`) },
    feature: "define-record-type — not implemented (unbound, R7RS §5.5)",
  },
  {
    match: {
      kind: "form",
      exact: normalizeText(`(test 3 (let ((k (kons 1 2)))
          (set-kar! k 3)
          (kar k)))`),
    },
    feature: "define-record-type — not implemented (unbound, R7RS §5.5)",
  },
];

// ── EXPECTED_FAILURES — documented deviations, not bugs (§11.2 point 2). ─────────────────────

export const EXPECTED_FAILURES: readonly ExpectedFailure[] = [
  // -----------------------------------------------------------------------
  // Keyword-migration hygiene gap (src/eval/evaluator.ts / src/env/core/core.ts) — the
  // DOMINANT signature (72 rows, all of "Numeric syntax"). `test-numeric-syntax`'s
  // syntax-rules template (r7rs-tests.scm:2297-2304) expands to a literal `(let* (…) …)`.
  // `let*` is one of the special forms NOT YET migrated to a `symbol.keyword` marker
  // (core.ts only keywords lambda/define/let/if/begin/quote/quasiquote/cond/case/when/
  // unless — core.ts:41's own comment says "let* / letrec / and / or follow as the
  // remaining primitives are keyworded", i.e. this is a KNOWN, planned, incomplete
  // migration, not a fresh bug). Mechanism: syntax-rules.ts's `rename()` hygiene-renames
  // every free template identifier to a gensym, copying the identifier's ENV VALUE onto
  // the gensym IF ONE EXISTS (`defChild.lookupSettled(name)`); a keyworded special form
  // has a real env value (a `Keyword` instance) to copy, so it round-trips through
  // `evaluatePair`'s VALUE-FIRST dispatch (`resolved instanceof Keyword ? SPECIAL_FORMS[
  // resolved.name] : …`) regardless of the gensym. `let*` has NO env binding (it's dispatched
  // purely by `SPECIAL_FORMS[symbol_name(first)]`, the STRING-keyed fallback) — so the
  // renamed head is a bare gensym backing a JS `Symbol("#:let*")` with no copied value.
  // `symbol_name()` reads the gensym's `.description` ("#:let*"), which misses the
  // `SPECIAL_FORMS["let*"]` table entirely, falls through to variable-lookup, and throws
  // "Unbound variable `Symbol(#:let*)'" (the JS Symbol's raw toString(), not the description
  // — evaluator.ts:3054's error path stringifies `first.__name__` directly).
  // Minimal repro (verified): a `(define-syntax m (syntax-rules () ((m x) (let* ((z x)) z))))`
  // then `(m 42)` throws this exact error; the same shape with `let` (already keyworded)
  // returns 42 cleanly. Fix design: add `let*`, `letrec`, `letrec*`, `and`, `or` (and
  // arguably `do`/`while`/`try`) as `symbol.keyword` bindings in core.ts, mirroring the
  // existing 11 — purely additive (SPECIAL_FORMS already has working handlers for all of
  // these; only the value-first dispatch path is missing). Real interpreter bug — a bug
  // report, not a harness defect — high value given it's the single largest red cluster.
  // -----------------------------------------------------------------------
  {
    match: { kind: "symbols", anyOf: ["test-numeric-syntax"] },
    reason:
      "hygiene gap: test-numeric-syntax's syntax-rules template expands to a literal `let*`, which isn't yet a " +
      "symbol.keyword (core.ts) — the hygienic renamer mints a gensym with no copied env value, and " +
      "SPECIAL_FORMS['let*'] (string-keyed) never sees the renamed head — 'Unbound variable `Symbol(#:let*)`'",
    gate: "core.ts: add let*/letrec/letrec*/and/or as symbol.keyword bindings (core.ts:41's own planned-next comment)",
  },
  {
    match: { kind: "form", exact: "(test #f (= 9007199254740992.0 9007199254740993))" },
    reason: "IEEE 754 precision limit: numbers beyond 2^53 lose precision when inexact",
    gate: "permanent — IEEE 754 semantics, no fix planned",
  },
  {
    match: { kind: "form", exact: "(test #t (if (and (= a b) (= b c)) (= a c) #t))" },
    reason: "Numeric = non-transitivity across exact-bignum vs inexact (2^1000 ± 1) — IEEE/tower edge, known",
    gate: "permanent — IEEE 754/tower edge, no fix planned",
  },
  // -----------------------------------------------------------------------
  // Purity invariant — writing methods are OMITTED by design (every entity is frozen).
  // -----------------------------------------------------------------------
  {
    match: {
      kind: "symbols",
      anyOf: [
        "string-set!",
        "string-fill!",
        "string-copy!",
        "vector-set!",
        "vector-fill!",
        "vector-copy!",
        "bytevector-u8-set!",
        "bytevector-copy!",
        "set-car!",
        "set-cdr!",
        "append!",
        "list-set!",
      ],
    },
    reason: "intentional — purity invariant (frozen entities); writing methods are doored",
    gate: "plan-2026-06-11-purity-pass",
  },
  {
    match: { kind: "symbols", anyOf: ["set!"] },
    reason: "intentional — purity invariant; lexical set! (variable rebinding) is doored",
    gate: "plan-2026-06-11-purity-pass (r7rs/binding)",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 6 (+ x 1))`) },
    reason: "intentional — purity invariant; cascading — the enclosing block's sibling `(set! x 5)` doors, aborting before this member runs",
    gate: "plan-2026-06-11-purity-pass (r7rs/binding); block-member symbol-visibility gap in manifest.ts blockMembers (harness fix design, not editable here)",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test 6 (force p))`) },
    reason:
      "intentional — purity invariant; cascading — `(define p (delay (begin (set! count …) …)))` evaluates its " +
      "argument (applicative order) before `delay`'s own door fires, so `set!` throws first",
    gate: "plan-2026-06-11-purity-pass (r7rs/binding); block-member symbol-visibility gap in manifest.ts blockMembers",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test #t (eqv? x y))`) },
    reason: "intentional — purity invariant; cascading — the enclosing block's sibling `(set-cdr! x 4)` doors first",
    gate: "plan-2026-06-11-purity-pass; block-member symbol-visibility gap in manifest.ts blockMembers",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test #f (list? y))`) },
    reason: "intentional — purity invariant; cascading — the enclosing block's sibling `(set-cdr! x 4)` doors first",
    gate: "plan-2026-06-11-purity-pass; block-member symbol-visibility gap in manifest.ts blockMembers",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test #f (list? x))`) },
    reason: "intentional — purity invariant; cascading — the enclosing block's sibling `(set-cdr! x 4)` doors first",
    gate: "plan-2026-06-11-purity-pass; block-member symbol-visibility gap in manifest.ts blockMembers",
  },
  // -----------------------------------------------------------------------
  // Macro engine / hygiene gaps — pre-L1, separate from AValue work.
  //
  // NOTE: `let-syntax` (v1/early-v2 rule, symbols:["let-syntax"]) was REMOVED —
  // r7rs-tests.scm:408's nested let-syntax/syntax-rules hygiene test now passes
  // (verified directly via exec: returns 'outer as expected). Its only other match,
  // r7rs-tests.scm:398, is independently caught by the "set!" rule above (that test's
  // body also contains a literal set!, and "set!" precedes this bucket in iteration
  // order) — so the rule was fully dead and is deleted, not just narrowed.
  // -----------------------------------------------------------------------
  {
    match: { kind: "symbols", anyOf: ["swap!"] },
    reason: "Local define-syntax + set! inside the rewrite — pre-L1 hygiene gap",
    gate: "pre-L1 macro engine (hygiene)",
  },
  {
    match: { kind: "symbols", anyOf: ["my-or"] },
    reason: "Hygienic shadowing of let/if at the use site — pre-L1 hygiene gap",
    gate: "pre-L1 hygiene",
  },
  {
    match: { kind: "form", exact: "(test 'ok (let ((=> #f)) (cond (#t => 'ok))))" },
    reason: "Hygienic shadowing of cond's => auxiliary keyword — pre-L1 hygiene gap",
    gate: "pre-L1 hygiene",
  },
  {
    match: { kind: "symbols", anyOf: ["sequence1"] },
    reason: "Nested define-syntax defining a macro (be-like-begin) — inner macro unbound — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine (nested define-syntax)",
  },
  {
    match: { kind: "symbols", anyOf: ["sequence2"] },
    reason: "Nested define-syntax defining a macro (be-like-begin) — inner macro unbound — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine (nested define-syntax)",
  },
  {
    match: { kind: "symbols", anyOf: ["sequence3"] },
    reason: "Nested define-syntax defining a macro (be-like-begin) — inner macro unbound — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine (nested define-syntax)",
  },
  {
    match: { kind: "symbols", anyOf: ["mad-hatter"] },
    reason: "Nested define-syntax (jabberwocky → hatter) — inner macro unbound — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine (nested define-syntax)",
  },
  {
    match: { kind: "form", exact: "(test 'x (bar 1))" },
    reason: "Nested define-syntax (foo → bar) — inner macro unbound — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine (nested define-syntax)",
  },
  {
    match: { kind: "form", exact: "(test 100 (ff 10))" },
    reason: "Nested define-syntax (ffoo → ff) — inner macro unbound — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine (nested define-syntax)",
  },
  // NOTE: narrowed from the original symbols:["elli-esc-1"] (3 matches) — the zero-arg
  // call `(elli-esc-1)` @472 now passes (verified directly via exec: returns '... as
  // expected). The 1-arg/2-arg calls below remain genuinely broken.
  {
    match: { kind: "form", exact: normalizeText(`(test '(100 ...) (elli-esc-1 100))`) },
    reason: "Ellipsis-escape (... ...) in the syntax-rules template — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine (ellipsis handling)",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test '(... 100 200) (elli-esc-1 100 200))`) },
    reason: "Ellipsis-escape (... ...) in the syntax-rules template — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine (ellipsis handling)",
  },
  {
    match: { kind: "symbols", anyOf: ["elli-lit-1"] },
    reason: "Ellipsis used as a literal in the template — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine (ellipsis handling)",
  },
  {
    match: {
      kind: "form",
      exact:
        '(test \'#((10 43) (31 41 51) (32 42 52) (63 77) ("rest:" . "tail")) (part-2x (10 (+ 21 22) (31 32) (41 42) (51 52) (+ 61 2) 77 . "tail")))',
    },
    reason: "Improper-list (dotted-tail) ellipsis pattern — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine (ellipsis handling)",
  },
  // Ellipsis sub-pattern `(m n) ...` in the MIDDLE of a pattern (followed by a fixed `x y`
  // tail) — verified: `m`/`n` bind to `()` instead of the collected elements (expected
  // `(31 41 51)`/`(32 42 52)`, actual `()`/`()`); the head/tail-only parts (`a b`, `x y`)
  // bind fine. A middle-ellipsis-sub-pattern capture gap, same family as the other pre-L1
  // ellipsis-handling rows above.
  {
    match: {
      kind: "form",
      exact: normalizeText(
        `(test '#((10 43) (31 41 51) (32 42 52) (63 77)) (part-2 10 (+ 21 22) (31 32) (41 42) (51 52) (+ 61 2) 77))`,
      ),
    },
    reason: "Ellipsis sub-pattern `(m n) ...` in the middle of a pattern binds to () instead of the collected elements",
    gate: "pre-L1 macro engine (ellipsis handling)",
  },
  {
    match: {
      kind: "form",
      exact: normalizeText(
        `(test '#((10 43) (31 41 51) (32 42 52) (63 77) ("rest:")) (part-2x (10 (+ 21 22) (31 32) (41 42) (51 52) (+ 61 2) 77)))`,
      ),
    },
    reason: "Ellipsis sub-pattern `(m n) ...` in the middle of a pattern binds to () instead of the collected elements",
    gate: "pre-L1 macro engine (ellipsis handling)",
  },
  {
    match: { kind: "symbols", anyOf: ["underscore"] },
    reason: "`_` wildcard in a syntax-rules pattern — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine",
  },
  {
    match: { kind: "symbols", anyOf: ["count-to-2_"] },
    reason: "`_` wildcard counting pattern (count-to-2_) — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine",
  },
  {
    match: { kind: "form", exact: "(test 'bound-identifier=? (m k))" },
    reason: "let-syntax + bound-identifier=? hygiene comparison — pre-L1 hygiene gap",
    gate: "pre-L1 hygiene (bound-identifier=?)",
  },
  // -----------------------------------------------------------------------
  // Function/lambda identity — evaluating twice through the lookup/eval path yields
  // distinct closures, so `(eq? p p)` sees two objects.
  // -----------------------------------------------------------------------
  {
    match: { kind: "form", exact: "(test #t (let ((p (lambda (x) x))) (eq? p p)))" },
    reason: "Lambda identity — lookup/eval yields distinct closures, eq? sees two objects — pre-L1",
    gate: "pre-L1 (evaluator identity)",
  },
  // NOTE: narrowed from the original symbols:["gen-counter"] (2 matches) — that broad rule
  // ALSO caught `(test #f (eqv? (gen-counter) (gen-counter)))` @713, which now passes:
  // two SEPARATE gen-counter calls legitimately produce non-eqv? closures regardless of the
  // identity bug, so the expected #f actually holds (verified directly via exec). Only the
  // self-comparison form below (the same lexical binding looked up twice, the actual identity
  // bug's shape) remains genuinely broken.
  {
    match: { kind: "form", exact: normalizeText(`(test #t (let ((g (gen-counter))) (eqv? g g)))`) },
    reason: "Lambda identity — same root cause as the (eq? p p) case above",
    gate: "pre-L1 (evaluator identity)",
  },
  {
    match: { kind: "symbols", anyOf: ["gen-loser"] },
    reason: "Lambda identity — same root cause as the (eq? p p) case above",
    gate: "pre-L1 (evaluator identity)",
  },
  // -----------------------------------------------------------------------
  // 6.5 Symbols — symbol->string/string->symbol REMOVED (v1/early-v2 rule). Verified fixed:
  // the described bug ("core.ts uses JS dot-access that no longer resolves") no longer applies
  // — the implementation moved to r7rs/equality.ts and uses `s.__name__` cleanly (a real
  // ASymbol API, not raw dot-access into a stale type). Direct exec confirms
  // `(symbol->string 'flying-fish)` → "flying-fish". All 7 matched rows now pass; the stale
  // it.fails rows were the ONLY thing keeping them red (was failing with "Expect test to fail").
  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------
  // Harness comparator bug — chibi-test-equal?'s inexact branch (harness-capability.ts prelude)
  // computes `(< (abs (- a b)) epsilon)`; for two infinities this is `(- +inf.0 +inf.0)` = NaN,
  // and `(< NaN _)` is always #f — so comparing any two equal infinities always "fails" even
  // though `expected`/`actual` print identically. NOT an arrival interpreter bug (confirmed:
  // `(eqv? (max 100 +inf.0) +inf.0)` → #t; the interpreter's own equality is correct) — it's the
  // harness's OWN comparator prelude, out of scope to edit here (report only). Fix design: special-
  // case `(and (infinite? a) (infinite? b))` → `(= a b)` before the epsilon subtraction, or route
  // through `=` first when both operands are non-finite.
  // -----------------------------------------------------------------------
  {
    match: { kind: "form", exact: normalizeText(`(test +inf.0 (max 100 +inf.0))`) },
    reason: "harness comparator bug (chibi-test-equal?): epsilon-diff of two +inf.0 is NaN, never < epsilon",
    gate: "harness-capability.ts prelude fix (report only — not an arrival interpreter bug)",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test -inf.0 (min -inf.0 -100))`) },
    reason: "harness comparator bug (chibi-test-equal?): epsilon-diff of two -inf.0 is NaN, never < epsilon",
    gate: "harness-capability.ts prelude fix (report only — not an arrival interpreter bug)",
  },
  // -----------------------------------------------------------------------
  // member/assoc custom-compare bug (src/env/r7rs/lists.ts): the native impl calls
  // `compare(obj, x)` as a RAW JS function invocation, but a scheme-level procedure value
  // (e.g. `string-ci=?`, `=`, or any user lambda) decodes to a boxed `ANativeProcedure`/ALambda
  // object, not `typeof === "function"` — so the call throws "compare is not a function" (a
  // plain JS TypeError, wrapped by the evaluator as "internal error in `?`: …"). Every OTHER
  // list native taking a user procedure (map/for-each/etc in the same file) correctly invokes
  // via `call_function(fn, args, {runCtx})` — member/assoc are the outliers calling it directly.
  // Fix design: replace `compare(obj, current.car)` with `call_function(compare, [obj,
  // current.car], {})` in both `member` and `assoc` (lists.ts ~L559, ~L583), matching
  // `mapImpl`'s pattern. Confirmed via direct exec repro; genuine interpreter bug, report only.
  // -----------------------------------------------------------------------
  {
    match: { kind: "form", exact: normalizeText(`(test '("b" "c") (member "B" '("a" "b" "c") string-ci=?))`) },
    reason: "member's custom `compare` is invoked as a raw JS call, not via call_function — throws on any boxed scheme procedure",
    gate: "src/env/r7rs/lists.ts member/assoc fix (report only — genuine interpreter bug)",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test '(2 4) (assoc 2.0 '((1 1) (2 4) (3 9)) =))`) },
    reason: "assoc's custom `compare` is invoked as a raw JS call, not via call_function — throws on any boxed scheme procedure",
    gate: "src/env/r7rs/lists.ts member/assoc fix (report only — genuine interpreter bug)",
  },
  // -----------------------------------------------------------------------
  // guard/raise value-loss bug (src/eval/evaluator.ts evalTry, ~L2693-2694): when `%raise`
  // throws a RAW non-Error scheme value (e.g. a pair — R7RS raise accepts ANY object), the
  // catch handler's `error instanceof Error` check is false, so it falls to
  // `new Error(String(error))` — STRINGIFYING the raised value and permanently losing it. The
  // `condition` variable guard's `catch` binds is therefore an R7RSError whose message is the
  // printed original value, not the original value itself — so `(assq 'a condition)` etc. can
  // never match, every clause falls through to `(else (raise ,var))`, and the (now twice-
  // stringified) error surfaces at the top level. Confirmed via direct repro: `assq` on the
  // raised list works fine in isolation; only the guard/catch round-trip loses it. Only trips
  // for raise of NON-Error data (raising via `error`/`make-error-object` already produces a
  // real Error instance, unaffected — hence only these 3 rows, not all of 6.11).
  // Fix design: in evalTry's catch, detect a raw (non-Error) scheme value BEFORE the
  // `instanceof Error` branch and preserve it directly as `errorValue` (skip the R7RSError
  // wrap-and-stringify path entirely for that case) — condition should bind the ORIGINAL raised
  // value, not a re-presentation of it. Genuine interpreter bug, report only.
  // -----------------------------------------------------------------------
  {
    match: {
      kind: "form",
      exact: normalizeText(`(test 42
    (guard (condition
            ((assq 'a condition) => cdr)
            ((assq 'b condition)))
      (raise (list (cons 'a 42)))))`),
    },
    reason: "guard/raise of a raw non-Error value gets stringified by evalTry's catch, losing the original value",
    gate: "src/eval/evaluator.ts evalTry fix (report only — genuine interpreter bug)",
  },
  {
    match: {
      kind: "form",
      exact: normalizeText(`(test '(b . 23)
    (guard (condition
            ((assq 'a condition) => cdr)
            ((assq 'b condition)))
      (raise (list (cons 'b 23)))))`),
    },
    reason: "guard/raise of a raw non-Error value gets stringified by evalTry's catch, losing the original value",
    gate: "src/eval/evaluator.ts evalTry fix (report only — genuine interpreter bug)",
  },
  {
    match: {
      kind: "form",
      exact: normalizeText(`(test 'caught-d
    (guard (condition
            ((assq 'c condition) 'caught-c)
            ((assq 'd condition) 'caught-d))
      (list
       (sqrt 8)
       (guard (condition
               ((assq 'a condition) => cdr)
               ((assq 'b condition)))
         (raise (list (cons 'd 24)))))))`),
    },
    reason: "guard/raise of a raw non-Error value gets stringified by evalTry's catch, losing the original value",
    gate: "src/eval/evaluator.ts evalTry fix (report only — genuine interpreter bug)",
  },
];

// ── STAGED — none yet (mirrors v1's empty SKIPPED_TESTS). ────────────────────────────────────

export const STAGED: readonly Staged[] = [];

export function verdictFor(step: TestStep): Verdict {
  for (const rule of EXCLUDED) if (matchesRule(rule.match, step)) return { run: "skip", feature: rule.feature };
  for (const rule of EXPECTED_FAILURES)
    if (matchesRule(rule.match, step)) return { run: "fails", reason: rule.reason, gate: rule.gate };
  for (const rule of STAGED) if (matchesRule(rule.match, step)) return { run: "todo", spec: rule.spec };
  return { run: "it" };
}

function describeMatch(match: Matcher): string {
  switch (match.kind) {
    case "symbols":
      return `symbols:[${match.anyOf.join(", ")}]`;
    case "form":
      return `form:"${match.exact.slice(0, 80)}"`;
    case "section":
      return `section:"${match.name}"`;
  }
}

/** P16 harness self-check (§4): dead-rule alarm (a rule matching zero manifest rows — orphaned
 *  by an upstream fix, must be deleted) + over-match alarm (an ExpectedFailure exceeding its
 *  declared `maxMatches`, protecting a sibling test that should stay green). Returns a list of
 *  human-readable findings; empty means coherent. */
export function registryCoherenceFindings(manifest: Manifest): string[] {
  const findings: string[] = [];
  const countMatches = (match: Matcher): number => manifest.tests.reduce((n, t) => n + (matchesRule(match, t) ? 1 : 0), 0);

  for (const rule of EXCLUDED) {
    const n = countMatches(rule.match);
    if (n === 0) findings.push(`dead Exclusion rule (0 matches): ${describeMatch(rule.match)} — ${rule.feature}`);
  }
  for (const rule of EXPECTED_FAILURES) {
    const n = countMatches(rule.match);
    if (n === 0) findings.push(`dead ExpectedFailure rule (0 matches): ${describeMatch(rule.match)} — ${rule.reason}`);
    if (rule.maxMatches !== undefined && n > rule.maxMatches)
      findings.push(
        `over-match ExpectedFailure rule (${n} > maxMatches ${rule.maxMatches}): ${describeMatch(rule.match)} — ${rule.reason}`,
      );
  }
  for (const rule of STAGED) {
    const n = countMatches(rule.match);
    if (n === 0) findings.push(`dead Staged rule (0 matches): ${describeMatch(rule.match)} — ${rule.spec}`);
  }
  return findings;
}
