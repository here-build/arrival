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
];

// ── EXPECTED_FAILURES — documented deviations, not bugs (§11.2 point 2). ─────────────────────

export const EXPECTED_FAILURES: readonly ExpectedFailure[] = [
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
  // -----------------------------------------------------------------------
  // Macro engine / hygiene gaps — pre-L1, separate from AValue work.
  // -----------------------------------------------------------------------
  {
    match: { kind: "symbols", anyOf: ["let-syntax"] },
    reason: "let-syntax + nested syntax-rules don't bind cleanly — pre-L1 macro engine gap",
    gate: "pre-L1 macro engine",
  },
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
  {
    match: { kind: "symbols", anyOf: ["elli-esc-1"] },
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
  {
    match: { kind: "symbols", anyOf: ["gen-counter"] },
    reason: "Lambda identity — same root cause as the (eq? p p) case above",
    gate: "pre-L1 (evaluator identity)",
  },
  {
    match: { kind: "symbols", anyOf: ["gen-loser"] },
    reason: "Lambda identity — same root cause as the (eq? p p) case above",
    gate: "pre-L1 (evaluator identity)",
  },
  // -----------------------------------------------------------------------
  // 6.5 Symbols — bootstrap's symbol->string / string->symbol uses raw JS-property
  // dot-syntax that doesn't resolve through the current Environment.get path.
  // -----------------------------------------------------------------------
  {
    match: { kind: "symbols", anyOf: ["symbol->string", "string->symbol"] },
    reason: "core.ts uses JS dot-access (s.__name__, scheme.SchemeSymbol) that no longer resolves — pre-L1",
    gate: "pre-L1 (core.ts env resolution)",
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
