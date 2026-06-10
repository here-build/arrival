// language-service — the "Scheme LSP with the TS LSP API" proof.
//
// Verifies the four mirrored methods operate in SCHEME coordinates:
//   • getSemanticDiagnostics — a TS bite lifts onto the right Scheme span; clean → 0.
//   • getQuickInfoAtPosition — hover on a builtin / a let-bound var yields a type.
//   • getCompletionsAtPosition — an operator slot surfaces the builtin names.
// Plus a 5-line `@codemirror/lint` adapter SNIPPET proving the diagnostic shape is
// wireable (no codemirror dep — just the mapping a CodeMirror extension performs).
//
// Per `.claude/rules/tests.md` this is a `__tests__/` verdict (boolean pass/fail).

import { describe, expect, it } from "vitest";

import { createSchemeLanguageService } from "../language-service.js";

const ls = createSchemeLanguageService();

describe("getSemanticDiagnostics — bites in Scheme coordinates", () => {
  it("(car 5) → one diagnostic covering the `5` in the SCHEME source", () => {
    const scheme = `(define z (car 5))`;
    const diags = ls.getSemanticDiagnostics(scheme);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    // The lifted span must cover the `5` in the SCHEME source (not the emitted TS).
    const fiveAt = scheme.indexOf("5");
    expect(d.start).toBe(fiveAt);
    expect(scheme.slice(d.start, d.start + d.length)).toBe("5");
    expect(d.severity).toBe("error");
    expect(d.code).toBe(2345);
    expect(d.messageText).toContain("not assignable");
    // line/col point at the `5`.
    expect(d.line).toBe(0);
    expect(d.character).toBe(fiveAt);
  });

  it("a clean program → 0 diagnostics", () => {
    const diags = ls.getSemanticDiagnostics(`(define xs (list 1 2 3))\n(car xs)`);
    expect(diags).toHaveLength(0);
  });

  // THE EMPTY BARREL: the compilation's globals are types-only (the lib bundle
  // strips every ambient JS value at generation). A JS global used as a scheme
  // symbol is unresolvable AT THE COMPILATION LEVEL — scheme has no JS
  // environment — and surfaces under the unknown-name policy below.
  it("the JS environment does not exist — (parseInt …) is unresolvable", () => {
    const diags = ls.getSemanticDiagnostics(`(define n (parseInt "3"))`);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.some((d) => d.messageText.includes("parseInt"))).toBe(true);
  });

  // UNKNOWN-NAME POLICY: until requires resolve across files, an unknown free
  // name is at least as likely an imported binding as a typo → a SUGGESTION
  // (soft mark), named by the SCHEME atom — never the cleanName'd TS twin
  // (`getenvNum`), and never an error-severity cry-wolf on correct code.
  it("unknown free names are scheme-named suggestions, not errors", () => {
    const scheme = `(define x (getenv-num "PORT"))`;
    const diags = ls.getSemanticDiagnostics(scheme);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("suggestion");
    expect(diags[0]!.messageText).toContain("'getenv-num'");
    expect(diags[0]!.messageText).not.toContain("getenvNum");
  });

  // `(require …)` is an environment directive — nothing to check in-buffer.
  // It used to emit a bare `require(...)` call → a bogus @types/node upsell.
  it("(require …) is a no-op, not an error", () => {
    expect(ls.getSemanticDiagnostics(`(require "lib/util.scm")\n(define x 1)`)).toHaveLength(0);
  });

  // `and`/`or` have leaves (logic.d.ts) — a predicate chain is clean, and the
  // old "Property 'and' does not exist on type 'ArrShape'" leak is gone.
  it("(and …)/(or …) predicate chains type-check clean", () => {
    const scheme = `(define xs (list 1 2 3))\n(define ok (and (not (null? xs)) (or (odd? (car xs)) (even? (car xs)))))`;
    expect(ls.getSemanticDiagnostics(scheme)).toHaveLength(0);
  });

  // The member roster is DERIVED from the merged ArrShape (leaves are the one
  // authored source): a leaf-only name like number->string lowers via __arr
  // and its signature bites — no hand-kept emitter list.
  it("a leaf-only builtin (number->string) is known to the emitter and bites", () => {
    expect(ls.getSemanticDiagnostics(`(define s (number->string 42))`)).toHaveLength(0);
    const bad = ls.getSemanticDiagnostics(`(define s (number->string "x"))`);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.severity).toBe("error");
  });

  it("never surfaces a wrong-positioned (unliftable) diagnostic", () => {
    // Every returned diagnostic must have lifted to a real Scheme span inside the
    // source (the unmapped-prelude drop rule).
    const scheme = `(define z (car 5))`;
    for (const d of ls.getSemanticDiagnostics(scheme)) {
      expect(d.start).toBeGreaterThanOrEqual(0);
      expect(d.start + d.length).toBeLessThanOrEqual(scheme.length);
    }
  });
});

describe("getQuickInfoAtPosition — hover in Scheme coordinates", () => {
  it("cursor on an argument identifier yields its inferred type", () => {
    // `xs` flows through `(list 1 2 3)` → hover resolves the List<number> type.
    // (Argument occurrences ARE token-mapped by `emitTypes`, so the cursor lands
    // precisely; the operator HEAD is not — see the known-gap test below.)
    const scheme = `(define xs (list 1 2 3))\n(car xs)`;
    const xsAt = scheme.lastIndexOf("xs") + 1;
    const info = ls.getQuickInfoAtPosition(scheme, xsAt);
    expect(info).not.toBeNull();
    expect(info!.displayText).toContain("List<number>");
  });

  it("cursor on a let-bound var (body occurrence) yields its inferred type", () => {
    // The BODY occurrence of `n` is token-mapped; the binder occurrence inside
    // `((n 5))` is not (only the value `5` is) — an emitter-granularity limit.
    const scheme = `(let ((n 5)) (+ n n))`;
    const nBodyAt = scheme.indexOf("n n"); // first body occurrence
    const info = ls.getQuickInfoAtPosition(scheme, nBodyAt);
    expect(info).not.toBeNull();
    // `n` is a `const` bound to the literal `5`, so TS infers the literal type
    // `5` (a subtype of number) — the inferred type is surfaced precisely.
    expect(info!.displayText).toBe("const n: 5");
  });

  // KNOWN GAP (emitter coordination): a cursor on the OPERATOR HEAD `car` in
  // `(car xs)` does NOT resolve to the builtin's signature, because `emitTypes`
  // emits only a WHOLE-FORM mapping for `(car xs)` → `__arr.car(xs)` and no
  // token mapping for the head `car` → the `.car` member access. The cursor
  // therefore projects into the `__arr` prefix and hover yields `__arr`'s type.
  // Querying the SAME service at the TS member offset returns the precise
  // `(method) ArrShape.car<number>(xs: List<number>): number` — so the lens is
  // correct; it is the MAPPING granularity that is missing upstream. This test
  // PINS the current behavior so the day the emitter adds head-token mappings,
  // it flips and we tighten it. (Fix lives in arrival-chain-view/types-emit.ts.)
  it("KNOWN GAP — operator-head hover lands on __arr (needs emitter head mapping)", () => {
    const scheme = `(define xs (list 1 2 3))\n(car xs)`;
    const carAt = scheme.lastIndexOf("car") + 1;
    const info = ls.getQuickInfoAtPosition(scheme, carAt);
    // Today this resolves the `__arr` prefix, not `car`. Documented, not desired.
    expect(info?.displayText).toBe("const __arr: ArrShape");
  });
});

describe("getCompletionsAtPosition — completions in Scheme coordinates", () => {
  it("returns a non-empty completion set in scope (locals + globals)", () => {
    // At the operator head the current (whole-form) mapping projects into the
    // `__arr` PREFIX, so TS completes the GLOBAL/in-scope set — which includes the
    // local binding `xs`. This proves the map→query→return plumbing is sound.
    const scheme = `(define xs (list 1 2 3))\n(car xs)`;
    const carAt = scheme.lastIndexOf("car") + 1;
    const names = new Set(ls.getCompletionsAtPosition(scheme, carAt).map((e) => e.name));
    expect(names.size).toBeGreaterThan(0);
    // The local binding surfaces (proves scope resolution works through the lens).
    expect(names.has("xs")).toBe(true);
  });

  // The builtin roster merges into EVERY answer (the `__arr[""]` element-access
  // probe — see builtinCompletions). This closed the old "builtin-member
  // completion needs an emitter head mapping" gap from the completion side; the
  // HOVER head gap above still awaits the emitter mapping.
  it("surfaces the builtin roster under real scheme names at any position", () => {
    const scheme = `(car xs)`;
    const carAt = scheme.indexOf("car") + 1;
    const names = new Set(ls.getCompletionsAtPosition(scheme, carAt).map((e) => e.name));
    for (const builtin of ["car", "map", "+", "odd?", "string-append", "max-by"]) {
      expect(names.has(builtin), builtin).toBe(true);
    }
  });

  // Answers are SCHEME vocabulary, not virtual-TS vocabulary: the JS global
  // scope and the lens's own infrastructure are emission substrate (a
  // materialization leak if surfaced) — subtracted via the empty-program
  // baseline. Program-local bindings survive the subtraction.
  it("never leaks the JS environment or lens infrastructure", () => {
    const scheme = `(define xs (list 1 2 3))\n(car xs)`;
    const names = new Set(ls.getCompletionsAtPosition(scheme, scheme.lastIndexOf("car") + 1).map((e) => e.name));
    expect(names.has("xs")).toBe(true); // the program's own binding survives
    for (const leak of ["console", "Array", "Math", "window", "__arr", "sexpr", "Dict", "typeof"]) {
      expect(names.has(leak), leak).toBe(false);
    }
  });

  // INCOMPLETE-PREFIX support: the sampler queries an UNBALANCED prefix mid-generation.
  // `emitTypes` parses complete programs only (parseSexprs throws on an unclosed paren →
  // the whole emit degrades to an empty module → no span at the cursor → empty completions).
  // The cursor-position queries balance the prefix first (closers append at the END, so the
  // cursor offset is unchanged), making them work mid-edit. Before this, all four returned [].
  it("returns completions on an UNBALANCED prefix (the sampler's mid-generation case)", () => {
    for (const prefix of ["(car ", "(filter (lambda (x) (> x ", "(list (ca", "(+ 1 "]) {
      const names = ls.getCompletionsAtPosition(prefix, prefix.length).map((e) => e.name);
      expect(names.length).toBeGreaterThan(0); // was [] (empty emit) before balancing
    }
  });

  it("diagnostics + quick-info don't crash on an unbalanced prefix", () => {
    // (diagnostics path is unbalanced-tolerant via emitTypes' empty-module fallback; the
    // cursor-position paths now balance — neither throws.)
    expect(() => ls.getSemanticDiagnostics("(car ")).not.toThrow();
    expect(() => ls.getQuickInfoAtPosition("(car x", 5)).not.toThrow();
  });
});

describe("completion subtraction — exact, not name-greedy", () => {
  // Audited 2026-06-10: name-only subtraction ate a program local that collides
  // with a substrate (type-only) name. Keys are `name kind` pairs now.
  it("a local shadowing a substrate type name (Array) still completes", () => {
    const scheme = `(define Array (list 1 2))\n(Arr`;
    const names = new Set(ls.getCompletionsAtPosition(scheme, scheme.length).map((e) => e.name));
    expect(names.has("Array")).toBe(true);
  });
});

describe("getCompletionContext — the loop closure (Σ∩T surfaced for humans)", () => {
  const PROG = `(define (greet name) (string-append "hi " name))\n(define names (list "ada" "grace"))\n`;

  it("argument slot: per-candidate verdicts = the sampler's mask, plus the param type", () => {
    const doc = `${PROG}(car `;
    const ctx = ls.getCompletionContext(doc, doc.length);
    expect(ctx.position).toBe("argument");
    expect(ctx.slot).toMatchObject({ argIndex: 0 });
    expect(ctx.slot!.paramType).toContain("List");
    const byName = new Map(ctx.entries.map((e) => [e.name, e]));
    // list producers fit; element/string producers are PROVEN unfit
    expect(byName.get("names")!.fits).toBe(true);
    expect(byName.get("filter")!.fits).toBe(true);
    expect(byName.get("greet")!.fits).toBe(false); // returns a string
    expect(byName.get("odd?")!.fits).toBe(false);
    // real narrowing: a clear majority of the roster is proven out at (car •
    expect(ctx.entries.filter((e) => e.fits === false).length).toBeGreaterThan(ctx.entries.length / 2);
  });

  it("signatures ride along: builtins always, locals from the emitted program", () => {
    const doc = `${PROG}(car `;
    const byName = new Map(ls.getCompletionContext(doc, doc.length).entries.map((e) => [e.name, e]));
    expect(byName.get("car")!.detail).toContain("List");
    expect(byName.get("car")!.callable).toBe(true);
    expect(byName.get("names")!.detail).toBe("List<string>");
    expect(byName.get("names")!.callable).toBe(false);
    expect(byName.get("greet")!.detail).toContain("=> string");
  });

  it("operator position is recognized (Σ's head discrimination), no slot probing", () => {
    const doc = `${PROG}(`;
    const ctx = ls.getCompletionContext(doc, doc.length);
    expect(ctx.position).toBe("operator");
    expect(ctx.slot).toBeUndefined();
    expect(ctx.entries.every((e) => e.fits === undefined)).toBe(true);
  });

  it("a LOCAL callee's slot narrows through INFERRED params (usage-based inference)", () => {
    // greet's param used to be `any` (everything kept, the honest degrade);
    // usage-based inference now reads its body — name flows into
    // string-append's SStr slot — so the param is `string` and the slot
    // gets REAL verdicts. The limitation test flipped into the feature test.
    const doc = `${PROG}(greet `;
    const ctx = ls.getCompletionContext(doc, doc.length);
    expect(ctx.position).toBe("argument");
    expect(ctx.slot).toMatchObject({ callee: "greet", argIndex: 0, paramType: "string" });
    const byName = new Map(ctx.entries.map((e) => [e.name, e]));
    expect(byName.get("names")!.fits).toBe(false); // a List is proven out now
    expect(byName.get("string-append")!.fits).toBe(true); // a string-producer fits
  });
});

describe("getSemanticClassifications — the checker's knowledge, atom-faithful", () => {
  it("classifies use-sites: parameters, locals, functions — single atoms only", () => {
    const scheme = `(define (greet name)\n  (string-append "hello, " name))\n\n(define names (list "a"))\n(define g (greet (car names)))`;
    const spans = ls.getSemanticClassifications(scheme);
    const byText = new Map(spans.map((s) => [scheme.slice(s.start, s.start + s.length), s.kind]));
    expect(byText.get("name")).toBe("parameter"); // the body USE of the lambda param
    expect(byText.get("names")).toBe("variable"); // a local's use-site
    expect(byText.get("greet")).toBe("function"); // a local function at its call
    for (const s of spans) {
      const text = scheme.slice(s.start, s.start + s.length);
      // Every span is a single atom (the whole-form binder lifts are dropped)
      // and never the emission infrastructure.
      expect(text).toMatch(/^[\w\-!$%&*+./<=>?@^~:]+$/);
      expect(text.startsWith("__")).toBe(false);
    }
  });
});

describe("getTypeValidCandidates — Layer T, the type-narrowed mask", () => {
  // The candidate pool the sampler's Σ would offer at the cursor; T narrows it to the type-valid.
  const POOL = ["car", "cdr", "filter", "map", "list", "cons", "not", "length"];

  it("an argument slot keeps only candidates whose value/return type fits the parameter", () => {
    // (car ⟨cur⟩) wants a List → list-PRODUCERS survive; element/number/bool ones are dropped.
    const carArg = new Set(ls.getTypeValidCandidates("(car ", 5, POOL));
    expect(carArg.has("list")).toBe(true);
    expect(carArg.has("filter")).toBe(true); // filter returns a list
    expect(carArg.has("car")).toBe(false); // car returns an element, not a list
    expect(carArg.has("length")).toBe(false); // returns a number
    expect(carArg.has("not")).toBe(false); // returns a bool

    // (+ 1 ⟨cur⟩) wants a number → only the number-producer.
    const plusArg = new Set(ls.getTypeValidCandidates("(+ 1 ", 5, POOL));
    expect(plusArg.has("length")).toBe(true);
    expect(plusArg.has("list")).toBe(false);
    expect(plusArg.has("car")).toBe(false);

    // (filter ⟨cur⟩ …) arg0 wants a predicate (x)=>bool → only the predicate-shaped builtin.
    const predArg = new Set(ls.getTypeValidCandidates("(filter ", 8, POOL));
    expect(predArg.has("not")).toBe(true);
    expect(predArg.has("list")).toBe(false);
  });

  it("narrows a FULL-ROSTER pool without truncation loss (the typeToString cutoff bug)", () => {
    // Audited 2026-06-10: reading the probe tuple via typeToString truncated
    // past ~160 chars, silently keeping every candidate beyond the cutoff.
    // Element-wise checker reads narrow the whole pool — the tail included.
    const pool = ls.getCompletionsAtPosition("(car ", 5).map((e) => e.name);
    expect(pool.length).toBeGreaterThan(50); // the full roster reaches the probe
    const narrowed = new Set(ls.getTypeValidCandidates("(car ", 5, pool));
    expect(narrowed.size).toBeLessThan(pool.length / 2); // real narrowing happened
    expect(narrowed.has("list")).toBe(true); // a list-producer survives
    expect(narrowed.has("odd?")).toBe(false); // a bool-producer in the TAIL is dropped
    expect(narrowed.has("string-append")).toBe(false); // a string-producer is dropped
  });

  it("does NOT narrow at a non-argument position (operator slot / top) — Σ owns operators", () => {
    expect(new Set(ls.getTypeValidCandidates("(", 1, POOL)).size).toBe(POOL.length);
    expect(new Set(ls.getTypeValidCandidates("", 0, POOL)).size).toBe(POOL.length);
  });

  it("conservatively KEEPS an unresolved candidate (a local / un-declared tool) — never a false drop", () => {
    // `netscan` is not in the bare prelude's ArrShape ⇒ unresolved ⇒ kept at every slot.
    const valid = ls.getTypeValidCandidates("(+ 1 ", 5, ["netscan", "length", "list"]);
    expect(valid).toContain("netscan"); // unresolved → kept
    expect(valid).toContain("length"); // number-producer → kept
    expect(valid).not.toContain("list"); // proven non-number → dropped
  });

  it("empty candidate set + unbalanced prefix don't crash", () => {
    expect(ls.getTypeValidCandidates("(car ", 5, [])).toEqual([]);
    expect(() => ls.getTypeValidCandidates("(filter (lambda (x) (> x ", 25, POOL)).not.toThrow();
  });
});

describe("getDefinitionAtPosition — go-to-def lifts back to Scheme", () => {
  it("a reference to a defined var resolves to its definition span in Scheme", () => {
    const scheme = `(define xs (list 1 2 3))\n(car xs)`;
    const useAt = scheme.lastIndexOf("xs") + 1;
    const defs = ls.getDefinitionAtPosition(scheme, useAt);
    expect(defs.length).toBeGreaterThan(0);
    // The definition lifts to a non-null Scheme span. (With current mappings the
    // binder token isn't individually mapped, so the def lifts to the enclosing
    // `(define xs …)` form — coarse but correct: it covers the binding site.)
    const withSpan = defs.find((d) => d.span !== null);
    expect(withSpan).toBeDefined();
    const defAt = scheme.indexOf("(define");
    expect(withSpan!.span!.start).toBe(defAt);
    // The span covers the `xs` binding occurrence.
    const bindAt = scheme.indexOf("xs");
    expect(withSpan!.span!.start).toBeLessThanOrEqual(bindAt);
    expect(withSpan!.span!.start + withSpan!.span!.length).toBeGreaterThan(bindAt);
  });
});

// ── CodeMirror-shape smoke ────────────────────────────────────────────────────
// PROOF the SchemeDiagnostic shape is wireable into `@codemirror/lint` — the
// adapter a CodeMirror extension writes is exactly this 5-line map (no codemirror
// dep added; this is the structural proof, not a live binding):
//
//   import { linter, type Diagnostic } from "@codemirror/lint";
//   const schemeLinter = linter((view): Diagnostic[] =>
//     ls.getSemanticDiagnostics(view.state.doc.toString()).map((d) => ({
//       from: d.start,
//       to: d.start + d.length,
//       severity: d.severity === "suggestion" ? "info" : d.severity, // CM: error|warning|info
//       message: d.messageText,
//     })));
//
describe("CodeMirror @codemirror/lint adapter shape", () => {
  it("a SchemeDiagnostic maps 1:1 onto a {from,to,severity,message} Diagnostic", () => {
    const diags = ls.getSemanticDiagnostics(`(define z (car 5))`);
    const cmDiagnostics = diags.map((d) => ({
      from: d.start,
      to: d.start + d.length,
      severity: d.severity === "suggestion" ? "info" : d.severity,
      message: d.messageText,
    }));
    expect(cmDiagnostics).toHaveLength(1);
    expect(cmDiagnostics[0]).toMatchObject({
      from: expect.any(Number),
      to: expect.any(Number),
      severity: "error",
      message: expect.stringContaining("not assignable"),
    });
    expect(cmDiagnostics[0]!.to).toBeGreaterThan(cmDiagnostics[0]!.from);
  });
});
