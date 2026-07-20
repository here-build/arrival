// Chibi harness v2 — registries for the SRFI-1 corpus (chibi's OWN
// vendor/chibi-scheme/lib/srfi/1/test.sld suite, wired in as a second corpus alongside the
// main r7rs-tests.scm one — see chibi-srfi1.spec.ts / srfi1-manifest.ts). Same Matcher/
// Verdict shape and precedence (excluded > expected-failure > staged > run) as
// registries.ts's main tables, built through the SAME generic engine (`makeRegistry`) —
// only the rule tables differ here.
//
// Every EXCLUDED/EXPECTED_FAILURE row below is driven by src/env/srfi/srfi-1.ts's own
// DOORS inventory (the implement-or-door map for the official SRFI-1 export set arrival
// doesn't bind live) — cross-checked against actual usage in test.sld (a symbol only gets a
// rule here if it's genuinely exercised; the registry-coherence dead-rule alarm below would
// catch a rule that isn't). `symbols`-kind rules are grouped by DOORS reason class, not one
// row per name — `matchesRule`'s `anyOf.some(...)` already gives the same precision as N
// separate rules, and grouping keeps this file's size proportional to the number of DISTINCT
// reasons instead of the number of doored names.
import { makeRegistry, type Exclusion, type ExpectedFailure, type Staged } from "./registries.js";
import { normalizeText } from "./manifest.js";

// ── EXCLUDED — design/scope omissions (mirrors registries.ts's own EXCLUDED semantics: a
//    feature arrival deliberately doesn't cover, not a bug with an expected fix date). ──────

export const EXCLUDED: readonly Exclusion[] = [
  // Multiple values (R7RS §6.10 / SRFI-8) — identical rule/wording to registries.ts's main
  // corpus rule (same underlying design omission). Every test.sld `test-values` form
  // literally writes `(values …)` on its expected side (verified: all 5 occurrences), so
  // this one rule catches every test-values row structurally, with no form-exact rows
  // needed; it also catches `(list-tabulate 4 values)` (passing the bare `values` procedure
  // as an argument — same door, since `values` itself is unbound regardless of arity).
  {
    match: {
      kind: "symbols",
      anyOf: ["values", "call-with-values", "let-values", "let*-values", "define-values", "receive"],
    },
    feature: "multiple values (R7RS §6.10 / SRFI-8) — omitted by design (continuation family)",
  },
  // Official SRFI-1 exports outside arrival's shipped agent-grain subset (src/env/srfi/
  // srfi-1.ts's DOORS map, the "not-in-subset — pure but unshipped" cluster) — a scope
  // boundary the pack's own file header documents ("SCOPE (honest): NOT the full SRFI-1
  // export set"), not a bug with a fix gate.
  {
    match: {
      kind: "symbols",
      anyOf: [
        "xcons",
        "cons*",
        "circular-list",
        "take-right",
        "drop-right",
        "split-at",
        "unzip2",
        "pair-fold-right",
        "pair-for-each",
        "list=",
      ],
    },
    feature: "official SRFI-1 export outside arrival's shipped agent-grain subset (src/env/srfi/srfi-1.ts DOORS) — scope boundary, not a bug",
  },
  // lset-* (list-as-set algebra) — its own DOORS cluster (LSET/LSET_BANG reasons),
  // separated from the group above only for a clearer feature string.
  {
    match: {
      kind: "symbols",
      anyOf: ["lset<=", "lset=", "lset-adjoin", "lset-union", "lset-intersection", "lset-difference", "lset-xor"],
    },
    feature: "list-as-set algebra (lset-*) outside the shipped SRFI-1 subset (src/env/srfi/srfi-1.ts DOORS)",
  },
  // Bare `fold` is deliberately NOT bound under this name — reduce (left fold) and
  // fold-right cover the same ground under arrival's own naming (srfi-1.ts's own
  // `fold: symbol.notImplemented` comment). A naming/scope decision, not an omission of the
  // underlying capability.
  {
    match: { kind: "symbols", anyOf: ["fold"] },
    feature: "bare SRFI-1 fold not bound under this name — arrival binds reduce/fold-right instead (src/env/srfi/srfi-1.ts)",
  },
  // NOTE: purity mutators (take!/append!/append-map!/vector-set!/set!) are NOT here — they
  // live in EXPECTED_FAILURES below, matching registries.ts's own main-corpus classification
  // (a documented gap with a fix gate, not a permanent design omission).
];

// ── EXPECTED_FAILURES — documented gaps (a fix would flip these green; `it.fails` so the
//    flip is loud, not silently absorbed). ──────────────────────────────────────────────────

export const EXPECTED_FAILURES: readonly ExpectedFailure[] = [
  // Purity invariant — writing/linear-update methods are doored (every entity frozen).
  // Same cluster + gate as registries.ts's main-corpus rule (src/env/r7rs/lists.ts,
  // src/env/r7rs/vectors.ts, src/env/srfi/srfi-1.ts's own PURITY-doored `!` names).
  //
  // NOTE: `set-car!` is deliberately NOT in this anyOf, even though it's peer-covered by
  // the same purity door as `vector-set!`/`append!`/etc. Its one occurrence in this corpus
  // (line 186) is `(test-error (set-car! (g) 3))` — test-error only asserts that SOMETHING
  // throws, and the purity door DOES throw, so this row genuinely PASSES (verified directly:
  // registering it as an expected-failure here made vitest report "Expect test to fail",
  // i.e. the body did NOT throw at the harness's `if (outcome.kind !== "pass") throw …`
  // check — the underlying outcome WAS a pass). Carving it out of the anyOf lets it fall
  // through to the default `it` verdict, matching its real behavior instead of masking a
  // pass as a documented failure.
  {
    match: { kind: "symbols", anyOf: ["take!", "append!", "append-map!", "vector-set!"] },
    reason: "intentional — purity invariant (frozen entities); writing/linear-update methods are doored",
    gate: "plan-2026-06-11-purity-pass",
  },
  {
    match: { kind: "symbols", anyOf: ["set!"] },
    reason: "intentional — purity invariant; lexical set! (variable rebinding) is doored",
    gate: "plan-2026-06-11-purity-pass (r7rs/binding)",
  },
  // `(car '())` / `(cdr '())` — verified via direct exec (src/values/primitives/ANil.ts:93-99,
  // src/run/RunContext.ts:109/127): car/cdr-of-nil throw ONLY when
  // `runCtx.strict` is true; the chibi harness's `exec()` calls (runner.ts) never pass
  // `strict`, so it defaults to `false` (tolerant nil-projection — RunContext.ts's own
  // documented mode, not a bug introduced by this harness). In tolerant mode car/cdr of '()
  // yield ANil instead of throwing, so `test-error` (which asserts a throw) fails here.
  // Reported prominently rather than excluded outright: this is a real, documented arrival
  // semantic (R7RS itself mandates the throw; arrival's default mode deliberately doesn't),
  // not a harness gap — flipping the harness to `strict: true` is a bigger, untested change
  // (it could affect passing rows elsewhere that rely on tolerant reads) and out of scope
  // for a conformance-harness/registry change.
  {
    match: { kind: "form", exact: normalizeText(`(test-error (car '()))`) },
    reason:
      "arrival's default run mode is nil-tolerant (RunContext.ts strict:false) — (car '()) yields ANil instead of throwing; R7RS/test-error expects a throw",
    gate: "permanent under the harness's default strict:false — would need exec({ strict: true }), untested blast radius, out of scope here",
  },
  {
    match: { kind: "form", exact: normalizeText(`(test-error (cdr '()))`) },
    reason:
      "arrival's default run mode is nil-tolerant (RunContext.ts strict:false) — (cdr '()) yields ANil instead of throwing; R7RS/test-error expects a throw",
    gate: "permanent under the harness's default strict:false — would need exec({ strict: true }), untested blast radius, out of scope here",
  },
  // delete-duplicates with a custom-equality 2nd arg (SRFI-1's optional comparator) — verified
  // via direct exec: arrival's `delete-duplicates` contract (src/env/srfi/srfi-1.ts) is
  // single-arg only (`input: [listAlike]`); calling it with a 2nd (predicate) argument throws
  // a zod contract error at the boundary ("Too big: expected array to have <=1 items"), not a
  // silent default-equal? fallback. A genuine arrival gap (SRFI-1's optional comparator isn't
  // implemented), not a design omission — the unary form (used elsewhere in this same file)
  // works fine.
  {
    match: {
      kind: "form",
      exact: normalizeText(
        `(test '((a . 3) (b . 7) (c . 1)) (delete-duplicates '((a . 3) (b . 7) (a . 9) (c . 1)) (lambda (x y) (eq? (car x) (car y)))))`,
      ),
    },
    reason:
      "arrival's delete-duplicates is single-arg only (src/env/srfi/srfi-1.ts contract: input: [listAlike]) — SRFI-1's optional custom-equality 2nd argument isn't implemented; calling with one throws a zod contract error (\"Too big: expected array to have <=1 items\") rather than falling back to a default compare",
    gate: "arrival gap — src/env/srfi/srfi-1.ts delete-duplicates lacks the optional comparator SRFI-1 specifies",
  },
];

// ── STAGED — none yet. ───────────────────────────────────────────────────────────────────────

export const STAGED: readonly Staged[] = [];

const registry = makeRegistry(EXCLUDED, EXPECTED_FAILURES, STAGED);
export const verdictFor = registry.verdictFor;
export const registryCoherenceFindings = registry.registryCoherenceFindings;

// Re-exported so a consumer (chibi-srfi1.spec.ts) needing to build a `form`-exact matcher
// doesn't need its own import of manifest.ts just for this.
export { normalizeText };
