// Reproduction of the dotted-tail / ellipsis-escape holes. Matcher source is
// unchanged — a one-line "stop hard-failing improper remainder" turns the door
// into `Not callable: a number` (the expander then emits a numeric call-head).
//
// Still open:
//   - `(x ... a . b)` vs improper input — door (`no matching syntax`).
//   - `(x ... . b)` — match succeeds, eval dies (#:b unbound / number in call-head).
//   - quoted `'(... (x ...))` — silent unsubstituted `(x ...)`.
import { describe, expect, it } from "vitest";
import { freshEnv } from "../_fresh-env.js";
import { execStateOverFrame as execState, parse } from "../../eval/generator-exec.js";
import { extract_patterns, restore_data_gensyms, transform_syntax } from "../../eval/syntax-rules.js";
import { Resolver } from "../../eval/Resolver.js";
import { RunContext } from "../../run/RunContext.js";

const env = await freshEnv();

async function run(form: string): Promise<unknown> {
  const { values: r } = await execState(form, { env });
  return r[0];
}

async function boom(form: string): Promise<string> {
  try {
    const out = await run(form);
    return `RESOLVED:${String(out)}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const improperRemainder = `(let-syntax ((m (syntax-rules () ((_ x ... a . b) (cons (list x ...) (cons a b)))))) (m 1 2 3 4 . 5))`;
const escape1 = `(let-syntax ((m (syntax-rules () ((_ x) '(... (x ...)))))) (m 100))`;
const escape2 = `(let-syntax ((m (syntax-rules () ((_ x y) '(... (... x y)))))) (m 100 200))`;

describe("syntax-rules trailing / ellipsis — controls (must stay green)", () => {
  it("proper tail after ellipsis: ((_ x ... a b) …) on (m 1 2 3 4 5)", async () => {
    const out = await run(
      `(let-syntax ((m (syntax-rules () ((_ x ... a b) (list (list x ...) a b))))) (m 1 2 3 4 5))`,
    );
    expect(String(out)).toBe("((1 2 3) 4 5)");
  });

  it("improper PATTERN vs proper INPUT (LIPS #360): remainder (5) binds a=5, b=()", async () => {
    const out = await run(
      `(let-syntax ((m (syntax-rules () ((_ x ... a . b) (cons (list x ...) (cons a b)))))) (m 1 2 3 4 5))`,
    );
    expect(String(out)).toBe("((1 2 3 4) 5)");
  });

  it("zero-arg quoted escape '(... ...) produces the identifier ...", async () => {
    const out = await run(`(let-syntax ((m (syntax-rules () ((_) '(... ...))))) (m))`);
    expect(String(out)).toBe("...");
  });
});

describe("syntax-rules trailing-handler hole (improper remainder)", () => {
  it.fails("R7RS: (x ... a . b) vs (1 2 3 4 . 5) binds a=4, b=5 → ((1 2 3) 4 . 5)", async () => {
    const out = await run(improperRemainder);
    expect(String(out)).toBe("((1 2 3) 4 . 5)");
  });

  it("doors — no matching syntax — does not throw an invariant", async () => {
    const msg = await boom(improperRemainder);
    expect(msg).toMatch(/syntax-rules: no matching syntax in macro \(m 1 2 3 4 \. 5\)/);
  });

  it("empty ellipsis + exact tail already works: (x ... a b) vs (1 2)", async () => {
    const out = await run(
      `(let-syntax ((m (syntax-rules () ((_ x ... a b) (list (list x ...) a b))))) (m 1 2))`,
    );
    expect(String(out)).toBe("(() 1 2)");
  });

  it("empty ellipsis + dotted tail (1 . 2) still doors", async () => {
    const msg = await boom(
      `(let-syntax ((m (syntax-rules () ((_ x ... a . b) (cons (list x ...) (cons a b)))))) (m 1 . 2))`,
    );
    expect(msg).toMatch(/syntax-rules: no matching syntax in macro \(m 1 \. 2\)/);
  });
});

describe("syntax-rules ellipsis-escape hole (quoted (... <template>))", () => {
  it.fails("1-arg '(... (x ...)) should produce (100 ...)", async () => {
    const out = await run(escape1);
    expect(String(out)).toBe("(100 ...)");
  });

  it.fails("2-arg '(... (... x y)) should produce (... 100 200)", async () => {
    const out = await run(escape2);
    expect(String(out)).toBe("(... 100 200)");
  });

  it("1-arg does not crash — silent wrong value (x ...)", async () => {
    expect(await boom(escape1)).toBe("RESOLVED:(x ...)");
  });

  it("2-arg does not crash — silent wrong value (... x y)", async () => {
    expect(await boom(escape2)).toBe("RESOLVED:(... x y)");
  });
});

describe("syntax-rules (x ... . b) arm — match succeeds, then eval dies", () => {
  // This arm does NOT use the trailing-handler loop (`cdr.cdr` is the symbol `b`).
  // Match returns true; the expansion is wrong and dies at eval.
  it("(x ... . b) vs proper (1 2 3 4 5): unbound hygienic #:b", async () => {
    const msg = await boom(
      `(let-syntax ((m (syntax-rules () ((_ x ... . b) (cons (list x ...) b))))) (m 1 2 3 4 5))`,
    );
    expect(msg).toMatch(/Unbound variable `Symbol\(#:b\)'/);
  });

  it("(x ... . b) vs improper (1 2 3 4 . 5): number in call-head", async () => {
    const msg = await boom(
      `(let-syntax ((m (syntax-rules () ((_ x ... . b) (cons (list x ...) b))))) (m 1 2 3 4 . 5))`,
    );
    expect(msg).toMatch(/Not callable: a number sits in operator\/call-head position/);
  });

});

// Probe stops after restore_data_gensyms: the transcribed form is not evaluated as Scheme.
// Door case records extract_patterns returning no bindings; the matcher is not forced.
const DOTTED_TAIL_PATTERN = "(_ x ... a . b)";
const DOTTED_TAIL_TEMPLATE = "(cons (list x ...) (cons a b))";

type ExpansionProbe = { bindings: false } | { bindings: true; expansion: string };

async function probeDottedTailExpansion(useSite: string): Promise<ExpansionProbe> {
  const [pattern] = await parse(DOTTED_TAIL_PATTERN);
  const [template] = await parse(DOTTED_TAIL_TEMPLATE);
  const [code] = await parse(useSite);
  // Glass Resolver(env) + unmetered RunContext — same mint execStateOverFrame uses
  // when the caller does not pass a live runCtx/resolver.
  const useResolver = new Resolver(env);
  const defResolver = new Resolver(env);
  const runCtx = new RunContext({ strict: false });
  const symbols: unknown[] = [];
  const ellipsis = "...";
  const bindings = extract_patterns(pattern, code, symbols, ellipsis, {
    useResolver,
    defResolver,
    capabilities: defResolver.capabilities,
    ctx: runCtx,
  });
  if (!bindings) return { bindings: false };
  const names = [];
  const transcribed = transform_syntax({
    bindings,
    expr: template,
    symbols,
    scope: defResolver.child("syntax"),
    names,
    ellipsis,
    ctx: runCtx,
  });
  const expansion = restore_data_gensyms(transcribed ?? template, names, runCtx);
  return { bindings: true, expansion: String(expansion) };
}

describe("syntax-rules dotted-tail expansion probe (form after restore_data_gensyms, no eval)", () => {
  it("LIPS / green: (m 1 2 3 4 5) has bindings and a transcribed form", async () => {
    const probe = await probeDottedTailExpansion("(m 1 2 3 4 5)");
    expect(probe.bindings).toBe(true);
    if (probe.bindings) {
      expect(probe.expansion).toBe("(#:cons (#:list 1 2 3 4) (#:cons 5 ()))");
    }
  });

  it("door / red: (m 1 2 3 4 . 5) has no bindings (extract_patterns miss)", async () => {
    const probe = await probeDottedTailExpansion("(m 1 2 3 4 . 5)");
    expect(probe).toEqual({ bindings: false });
  });
});
