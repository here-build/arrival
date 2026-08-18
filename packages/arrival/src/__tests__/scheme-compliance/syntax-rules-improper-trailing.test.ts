// Reproduction of the dotted-tail / ellipsis-escape holes.
//
// `(x ... a . b)` vs a proper list (LIPS) and vs an improper remainder
// (`(1 2 3 4 . 5)`, empty-ellipsis `(1 . 2)`) both match. The `(y . z)` tail
// accepts a proper singleton and a dotted pair; a longer rest (cdr is a pair)
// still misses so the empty-ellipsis arm cannot steal the LIPS trim path.
//
// `(x ... . b)` binds the remainder: proper → b=(), improper → the dotted cdr.
//
// Still open:
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
  it("R7RS: (x ... a . b) vs (1 2 3 4 . 5) binds a=4, b=5 → ((1 2 3) 4 . 5)", async () => {
    const out = await run(improperRemainder);
    expect(String(out)).toBe("((1 2 3) 4 . 5)");
  });

  it("empty ellipsis + exact tail already works: (x ... a b) vs (1 2)", async () => {
    const out = await run(
      `(let-syntax ((m (syntax-rules () ((_ x ... a b) (list (list x ...) a b))))) (m 1 2))`,
    );
    expect(String(out)).toBe("(() 1 2)");
  });

  it("empty ellipsis + dotted tail (x ... a . b) vs (1 . 2) → (() 1 . 2)", async () => {
    const out = await run(
      `(let-syntax ((m (syntax-rules () ((_ x ... a . b) (cons (list x ...) (cons a b)))))) (m 1 . 2))`,
    );
    expect(String(out)).toBe("(() 1 . 2)");
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

describe("syntax-rules (x ... . b) arm", () => {
  // This arm does NOT use the trailing-handler loop (`cdr.cdr` is the symbol `b`).
  it("(x ... . b) vs proper (1 2 3 4 5): x=(1 2 3 4 5), b=() → ((1 2 3 4 5))", async () => {
    const out = await run(
      `(let-syntax ((m (syntax-rules () ((_ x ... . b) (cons (list x ...) b))))) (m 1 2 3 4 5))`,
    );
    expect(String(out)).toBe("((1 2 3 4 5))");
  });

  it("(x ... . b) vs improper (1 2 3 4 . 5): x=(1 2 3 4), b=5 → ((1 2 3 4) . 5)", async () => {
    const out = await run(
      `(let-syntax ((m (syntax-rules () ((_ x ... . b) (cons (list x ...) b))))) (m 1 2 3 4 . 5))`,
    );
    expect(String(out)).toBe("((1 2 3 4) . 5)");
  });
});

// Probe stops after restore_data_gensyms: the transcribed form is not evaluated as Scheme.
const DOTTED_TAIL_PATTERN = "(_ x ... a . b)";
const DOTTED_TAIL_TEMPLATE = "(cons (list x ...) (cons a b))";
const ELLIPSIS_DOTTED_PATTERN = "(_ x ... . b)";
const ELLIPSIS_DOTTED_TEMPLATE = "(cons (list x ...) b)";

type ExpansionProbe = { bindings: false } | { bindings: true; expansion: string };

async function probeExpansion(
  patternSrc: string,
  templateSrc: string,
  useSite: string,
): Promise<ExpansionProbe> {
  const [pattern] = await parse(patternSrc);
  const [template] = await parse(templateSrc);
  return probeParsed(pattern, template, useSite);
}

async function probeDottedTailExpansion(useSite: string): Promise<ExpansionProbe> {
  return probeExpansion(DOTTED_TAIL_PATTERN, DOTTED_TAIL_TEMPLATE, useSite);
}

async function probeEllipsisDottedExpansion(useSite: string): Promise<ExpansionProbe> {
  return probeExpansion(ELLIPSIS_DOTTED_PATTERN, ELLIPSIS_DOTTED_TEMPLATE, useSite);
}

async function probeParsed(pattern: unknown, template: unknown, useSite: string): Promise<ExpansionProbe> {
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

  it("improper remainder: (m 1 2 3 4 . 5) transcribes to (#:cons (#:list 1 2 3) (#:cons 4 5))", async () => {
    const probe = await probeDottedTailExpansion("(m 1 2 3 4 . 5)");
    expect(probe.bindings).toBe(true);
    if (probe.bindings) {
      expect(probe.expansion).toBe("(#:cons (#:list 1 2 3) (#:cons 4 5))");
    }
  });

  it("empty ellipsis + dotted tail: (m 1 . 2) transcribes to (#:cons (#:list) (#:cons 1 2))", async () => {
    const probe = await probeDottedTailExpansion("(m 1 . 2)");
    expect(probe.bindings).toBe(true);
    if (probe.bindings) {
      expect(probe.expansion).toBe("(#:cons (#:list) (#:cons 1 2))");
    }
  });
});

describe("syntax-rules (x ... . b) expansion probe (form after restore_data_gensyms, no eval)", () => {
  it("proper: (m 1 2 3 4 5) transcribes to (#:cons (#:list 1 2 3 4 5) ())", async () => {
    const probe = await probeEllipsisDottedExpansion("(m 1 2 3 4 5)");
    expect(probe.bindings).toBe(true);
    if (probe.bindings) {
      expect(probe.expansion).toBe("(#:cons (#:list 1 2 3 4 5) ())");
    }
  });

  it("improper: (m 1 2 3 4 . 5) transcribes to (#:cons (#:list 1 2 3 4) 5)", async () => {
    const probe = await probeEllipsisDottedExpansion("(m 1 2 3 4 . 5)");
    expect(probe.bindings).toBe(true);
    if (probe.bindings) {
      expect(probe.expansion).toBe("(#:cons (#:list 1 2 3 4) 5)");
    }
  });
});
