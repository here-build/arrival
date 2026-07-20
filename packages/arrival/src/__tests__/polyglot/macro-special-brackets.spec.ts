import { describe, expect, it } from "vitest";
import { readAst, evalJson, errorClass } from "./_harness.js";

describe("macro-special-brackets / […] as special-form syntax", () => {
  describe("let / let* / named-let / letrec", () => {
    // POSITIVE — read: input parses to canonical AST
    it.each([
      {
        name: "y_bracket_whole_list_reads_as_vector",
        input: "(let [a 1 b 2] (+ a b))",
        ast: "(let [a 1 b 2] (+ a b))",
      },
      {
        name: "y_bracket_per_element_reads_as_list_of_vectors",
        input: "(let* ([a 1] [b 2]) b)",
        ast: "(let* ([a 1] [b 2]) b)",
      },
      {
        name: "y_quote_let_bracket_binding_is_plain_vector",
        input: "(quote (let [a 1] a))",
        ast: "(quote (let [a 1] a))",
      },
      {
        name: "y_quote_reader_macro_let_bracket",
        input: "'(let [a 1] a)",
        ast: "(quote (let [a 1] a))",
      },
      {
        name: "y_named_let_bracket_reads",
        input: "(let loop [i 0] (loop))",
        ast: "(let loop [i 0] (loop))",
      },
      {
        name: "y_mixed_paren_and_bracket_reads",
        input: "(let ([a 1] (b 2)) x)",
        ast: "(let ([a 1] (b 2)) x)",
      },
    ])("read · $name", async ({ input, ast }) => {
      expect(await readAst(input)).toBe(ast);
    });

    // POSITIVE — eval: input evaluates to value
    it.each([
      { name: "y_let_whole_list_bracket_binds", input: "(let [a 1 b 2] (+ a b))", value: 3 },
      { name: "y_letstar_per_element_bracket_sequential", input: "(let* ([a 1] [b (+ a 1)]) b)", value: 2 },
      {
        name: "y_named_let_per_element_bracket_recurses",
        input: "(let loop ([i 0] [acc 0]) (if (= i 5) acc (loop (+ i 1) (+ acc i))))",
        value: 10,
      },
      {
        name: "y_named_let_whole_list_bracket_clojure",
        input: "(let loop [i 0] (if (= i 3) i (loop (+ i 1))))",
        value: 3,
      },
      { name: "y_mixed_paren_bracket_bindings", input: "(let ([a 1] (b 2)) (+ a b))", value: 3 },
      { name: "y_bracket_binding_shadowing", input: "(let [a 1] (let [a 2] a))", value: 2 },
      {
        name: "y_bracket_binding_closure_value",
        input: "((let ([f (lambda (x) (* x 2))]) f) 21)",
        value: 42,
      },
      {
        name: "y_letrec_bracket_mutual_recursion",
        input:
          "(letrec ([ev? (lambda (n) (if (= n 0) #t (od? (- n 1))))] [od? (lambda (n) (if (= n 0) #f (ev? (- n 1))))]) (ev? 10))",
        value: true,
      },
      {
        name: "y_bracket_equals_paren_image",
        input: "(equal? (let ([a 1] [b 2]) (+ a b)) (let ((a 1) (b 2)) (+ a b)))",
        value: true,
      },
      {
        name: "y_quoted_bracket_let_binding_slot_is_datum",
        input: "(vector-ref (car (cdr (quote (let [a 1] a)))) 0)",
        value: { $sym: "a" },
      },
    ])("eval · $name", async ({ input, value }) => {
      expect(await evalJson(input)).toEqual(value);
    });

    // DOORS — one it.each per error code
    it.each([
      { name: "n_let_whole_list_odd_arity", input: "(let [a 1 b] a)", mode: "eval" as const },
    ])("door E-LET-BRACKET-BINDINGS-LIST · $name", async ({ input, mode }) => {
      let err: unknown;
      try {
        mode === "read" ? await readAst(input) : await evalJson(input);
      } catch (e) {
        err = e;
      }
      expect(err, "expected E-LET-BRACKET-BINDINGS-LIST, but succeeded").toBeDefined();
      expect(errorClass(err)).toBe("E-LET-BRACKET-BINDINGS-LIST");
    });

    it.each([
      { name: "n_let_per_element_wrong_length", input: "(let ([a 1 2]) a)", mode: "eval" as const },
      { name: "n_let_destructuring_name_slot", input: "(let ([[a b] 1]) a)", mode: "eval" as const },
    ])("door E-LET-BRACKET-BINDING · $name", async ({ input, mode }) => {
      let err: unknown;
      try {
        mode === "read" ? await readAst(input) : await evalJson(input);
      } catch (e) {
        err = e;
      }
      expect(err, "expected E-LET-BRACKET-BINDING, but succeeded").toBeDefined();
      expect(errorClass(err)).toBe("E-LET-BRACKET-BINDING");
    });
  });

  describe("do — bracket steps", () => {
    // POSITIVE — read: input parses to canonical AST
    it.each([
      {
        name: "y_do_bracket_step_reads",
        input: "(do ([i 0 (+ i 1)]) (= i 3) i)",
        ast: "(do ([i 0 (+ i 1)]) (= i 3) i)",
      },
    ])("read · $name", async ({ input, ast }) => {
      expect(await readAst(input)).toBe(ast);
    });

    // POSITIVE — eval: input evaluates to value
    it.each([
      {
        name: "y_do_per_element_bracket_steps",
        input: "(do ([i 0 (+ i 1)] [s 0 (+ s i)]) (= i 3) s)",
        value: 3,
      },
    ])("eval · $name", async ({ input, value }) => {
      expect(await evalJson(input)).toEqual(value);
    });

    // DOORS — one it.each per error code
    it.each([
      { name: "n_do_whole_list_excluded", input: "(do [i 0 (+ i 1)] (= i 3) i)", mode: "eval" as const },
    ])("door E-LET-BRACKET-BINDINGS-LIST · $name", async ({ input, mode }) => {
      let err: unknown;
      try {
        mode === "read" ? await readAst(input) : await evalJson(input);
      } catch (e) {
        err = e;
      }
      expect(err, "expected E-LET-BRACKET-BINDINGS-LIST, but succeeded").toBeDefined();
      expect(errorClass(err)).toBe("E-LET-BRACKET-BINDINGS-LIST");
    });
  });

  describe("cond / case / do clauses", () => {
    // POSITIVE — read: input parses to canonical AST
    it.each([
      {
        name: "y_cond_bracket_clause_reads_as_vector",
        input: "(cond [(> x 1) \"a\"] [else \"b\"])",
        ast: "(cond [(> x 1) \"a\"] [else \"b\"])",
      },
      {
        name: "y_case_bracket_clause_reads_as_vector_datum_list_stays_list",
        input: "(case k [(1 2) \"low\"] [else \"hi\"])",
        ast: "(case k [(1 2) \"low\"] [else \"hi\"])",
      },
      {
        name: "y_do_bracket_test_clause_reads_as_vector",
        input: "(do ((i 0 (+ i 1))) [(= i n) acc])",
        ast: "(do ((i 0 (+ i 1))) [(= i n) acc])",
      },
      {
        name: "y_quote_cond_bracket_clause_is_plain_vector",
        input: "(quote (cond [#t 1]))",
        ast: "(quote (cond [#t 1]))",
      },
    ])("read · $name", async ({ input, ast }) => {
      expect(await readAst(input)).toBe(ast);
    });

    // POSITIVE — eval: input evaluates to value
    it.each([
      {
        name: "y_cond_bracket_test_matches",
        input: "(cond [(> 2 1) \"a\"] [else \"b\"])",
        value: "a",
      },
      {
        name: "y_cond_bracket_else_matches",
        input: "(cond [#f \"a\"] [else \"b\"])",
        value: "b",
      },
      {
        name: "y_cond_bracket_arrow_clause",
        input: "(cond [(+ 1 2) => (lambda (x) (* x 10))])",
        value: 30,
      },
      {
        name: "y_case_bracket_datum_list_matches",
        input: "(case 1 [(1 2) \"low\"] [else \"hi\"])",
        value: "low",
      },
      {
        name: "y_case_bracket_else_matches",
        input: "(case 99 [(1 2) \"low\"] [else \"hi\"])",
        value: "hi",
      },
      {
        name: "y_case_bracket_arrow_clause",
        input: "(case 2 [(1 2) => (lambda (x) (* x 100))] [else 0])",
        value: 200,
      },
      {
        name: "y_do_bracket_test_clause",
        input: "(do ((i 0 (+ i 1))) [(= i 3) i])",
        value: 3,
      },
      {
        name: "y_do_bracket_binding_and_test_clause_compose",
        input: "(do ([i 0 (+ i 1)]) [(= i 3) i])",
        value: 3,
      },
      {
        name: "y_nested_cond_bracket_clause_with_bracket_let_binding",
        input: "(cond [#t (let [a 1] a)])",
        value: 1,
      },
      {
        name: "y_cond_bracket_equals_paren_image",
        input: "(equal? (cond [(> 2 1) \"a\"]) (cond ((> 2 1) \"a\")))",
        value: true,
      },
    ])("eval · $name", async ({ input, value }) => {
      expect(await evalJson(input)).toEqual(value);
    });

    // DOORS — one it.each per error code
    it.each([
      { name: "n_cond_empty_bracket_clause", input: "(cond [])", mode: "eval" as const },
      { name: "n_case_empty_bracket_clause", input: "(case 1 [])", mode: "eval" as const },
      { name: "n_do_empty_bracket_test_clause", input: "(do ((i 0)) [])", mode: "eval" as const },
    ])("door E-COND-BRACKET-CLAUSE · $name", async ({ input, mode }) => {
      let err: unknown;
      try {
        mode === "read" ? await readAst(input) : await evalJson(input);
      } catch (e) {
        err = e;
      }
      expect(err, "expected E-COND-BRACKET-CLAUSE, but succeeded").toBeDefined();
      expect(errorClass(err)).toBe("E-COND-BRACKET-CLAUSE");
    });

    it.each([
      { name: "n_case_bracket_datum_list_vector_head", input: "(case 1 [[1 2] \"low\"])", mode: "eval" as const },
    ])("door E-CASE-BRACKET-DATUM-LIST · $name", async ({ input, mode }) => {
      let err: unknown;
      try {
        mode === "read" ? await readAst(input) : await evalJson(input);
      } catch (e) {
        err = e;
      }
      expect(err, "expected E-CASE-BRACKET-DATUM-LIST, but succeeded").toBeDefined();
      expect(errorClass(err)).toBe("E-CASE-BRACKET-DATUM-LIST");
    });
  });
});
