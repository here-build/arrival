// polyglot-racket pack — assemble onto a real env, then RUN the threading-alias
// macros and the dict accessor family. Split out of polyglot.test.ts (V,
// 2026-07-10 dialect split — see polyglot.ts's header for the full rationale).
import {
  execState as bareExecState,
  execStateOverFrame,
  type ExecOptionsOverFrame,
} from "../../../eval/generator-exec.js";
// In-package test: internal-module access (the barrel export retired — privatization V5).
import { inferenceEnv as sandboxedEnv } from "../../inference-env.js";
import { applyCapability } from "../../../__tests__/_fresh-env.js";
import { harvestContracts } from "../../../__tests__/_symbols-harvest.js";
import { describe, expect, it } from "vitest";
import polyglotRacket from "../../polyglot/polyglot-racket.js";

async function exec(code: string, options: ExecOptionsOverFrame) {
  return [...(await execStateOverFrame(code, options)).values];
}

describe("@here.build/arrival/polyglot-racket", () => {
  it("installs ~>/~>> (aliasing Clojure's ->/->>) and dict-count, assembled STANDALONE", async () => {
    const env = sandboxedEnv.child("polyglot-racket-test");
    // Assembling JUST polyglot-racket pulls in scheme/polyglot-clojure (for the
    // ->/->> that ~>/~>> expand to, and str) transitively via its own declared
    // `deps` — the C3 dep walk this pack's header documents.
    await applyCapability(env, [polyglotRacket]);

    const num = async (src: string) => Number((await exec(src, { env }))[0]);
    // ~> is an alias of -> (thread-first)
    expect(await num("(~> 5 (+ 10))")).toBe(15);
    // ~>> is an alias of ->> (thread-last)
    expect(await num("(~>> 5 (- 20))")).toBe(15);
    expect(await num("(dict-count (dict :a 1 :b 2))")).toBe(2);
  });

  it("exports a well-formed SchemePackSpec", () => {
    expect(polyglotRacket.name).toBe("scheme/polyglot-racket");
    expect(polyglotRacket.spec.prelude).toBeUndefined();
    const symbols = polyglotRacket.spec.symbols as Record<string, { kind?: string; macroAttribute?: string }>;
    // A native entry is the minted procedure (value kind "procedure"). The contract
    // kind lives on `.contract`, which harvestContracts reads. An alias has no contract.
    const contracts = harvestContracts(symbols);
    expect(symbols["~>"]?.kind).toBe("define-syntax");
    expect(symbols["~>"]?.macroAttribute).toBe("expression");
    expect(symbols["~>>"]?.kind).toBe("define-syntax");
    expect(contracts["dict-ref"]?.kind).toBe("native");
    expect(contracts["%dict-guard"]?.kind).toBe("native");
    expect(symbols["assoc-ref"]?.kind).toBe("alias");
  });

  it("deps reach scheme/polyglot-clojure (for ->/->> and str) and the core/R7RS natives this pack's bodies use", () => {
    const names = (polyglotRacket.spec.deps ?? []).map((d) => d.name);
    expect(names[0]).toBe("scheme/polyglot-clojure"); // dependents-before-dependencies
    expect(names).toEqual(
      expect.arrayContaining([
        "scheme/polyglot-clojure",
        "scheme/polyglot",
        "scheme/equality",
        "scheme/numeric",
        "scheme/r7rs/exceptions",
        "scheme/vectors",
        "scheme/lists",
      ]),
    );
  });
});

// dict accessor family (Racket's dict library) — grain-completion: MCP-Atlas
// trajectory autopsy found models reaching for `dict-ref` on a dict-shaped tool
// result and getting stranded (Unbound variable). These are dict-SPECIFIC (guard
// the dict shape, unlike @'s origin-agnostic read) real bindings, not stubs.
// Default assembled env — polyglot-racket ships in BASE_PACKS in production.
describe("@here.build/arrival/polyglot-racket — dict accessor family (Bucket A)", () => {
  const str = async (src: string) => String((await bareExecState(src)).values[0]);
  const raw = async (src: string) => (await bareExecState(src)).values;

  it("dict-ref — reads by keyword, symbol, or string key, identically", async () => {
    expect(await str("(dict-ref (dict :a 1) :a)")).toBe("1");
    expect(await str('(dict-ref (dict "a" 1) \'a)')).toBe("1");
    expect(await str('(dict-ref (dict "a" 1) "a")')).toBe("1");
  });

  it("dict-ref — optional default, nil when missing and no default (same convention as get-in)", async () => {
    expect(await str("(dict-ref (dict :a 1) :b 99)")).toBe("99");
    const missing = await raw("(dict-ref (dict :a 1) :b)");
    expect(missing[0]).toEqual((await raw("'()"))[0]);
  });

  it("dict-ref — nested dicts", async () => {
    expect(await str("(dict-ref (dict-ref (dict :a (dict :b 2)) :a) :b)")).toBe("2");
  });

  it("dict-ref — errors with a door (fact + why + action) on a non-dict", async () => {
    await expect(raw("(dict-ref (list 1 2) :a)")).rejects.toThrow(
      /dict-ref: expected a dict .* got a pair\/list.*use @ for an origin-agnostic read/,
    );
    await expect(raw('(dict-ref "x" :a)')).rejects.toThrow(/dict-ref: expected a dict .* got a string/);
  });

  it("dict-has-key? — #t iff key resolves, #f when missing", async () => {
    const truthy = async (src: string) => str(`(if ${src} "yes" "no")`);
    expect(await truthy("(dict-has-key? (dict :a 1) :a)")).toBe("yes");
    expect(await truthy("(dict-has-key? (dict :a 1) :b)")).toBe("no");
  });

  it("dict-keys / dict-values — proper scheme lists, composable with map/filter", async () => {
    expect(await str("(length (dict-keys (dict :a 1 :b 2)))")).toBe("2");
    // dict-keys elements are raw JS strings lifted via array->list (same representation
    // as @keys elsewhere in this pack) — they print unquoted inside a list, same quirk
    // as any other raw-string-in-pair-spine value in this runtime.
    expect(await str("(map (lambda (k) k) (dict-keys (dict :a 1)))")).toBe("(a)");
    expect(await str("(dict-values (dict :a 1))")).toBe("(1)");
  });

  it("dict-count — the number of keys", async () => {
    expect(await str("(dict-count (dict :a 1 :b 2 :c 3))")).toBe("3");
    expect(await str("(dict-count (dict))")).toBe("0");
  });

  it("dict->alist / alist->dict — round trip through an alist of (key . value) pairs", async () => {
    expect(await str('(cdr (assoc "a" (dict->alist (dict :a 1))))')).toBe("1");
    expect(await str('(dict-ref (alist->dict (list (cons "a" 1) (cons "b" 2))) :b)')).toBe("2");
  });

  it("dict-set — an immutability DOOR, not a function (a 'set' verb in an immutable env is a silent-mutation trap)", async () => {
    await expect(raw("(dict-set (dict :a 1) :a 2)")).rejects.toThrow(
      /dict-set is not provided — dicts are immutable here.*assoc-in.*original d is unchanged/s,
    );
  });

  it("dict-update — an immutability DOOR pointing at update-in", async () => {
    await expect(raw("(dict-update (dict :a 1) :a (lambda (x) (+ x 1)))")).rejects.toThrow(
      /dict-update is not provided — dicts are immutable here.*update-in.*original d is unchanged/s,
    );
  });

  it("assoc-ref (Guile) — an alias of dict-ref, same key handling and default convention", async () => {
    expect(await str("(assoc-ref (dict :a 1) :a)")).toBe("1");
    expect(await str("(assoc-ref (dict :a 1) :b 42)")).toBe("42");
  });

  const truthy = async (src: string) => str(`(if ${src} "yes" "no")`);

  it("dict-ref — a stored nil is a hit, so the default is not substituted", async () => {
    expect(await str("(dict-ref (dict :a '()) :a 99)")).toBe("()");
    expect(await truthy("(dict-has-key? (dict :a '()) :a)")).toBe("yes");
    expect(await str("(dict-ref (dict :a '()) :missing 99)")).toBe("99");
    expect(await truthy("(dict-has-key? (dict :a '()) :missing)")).toBe("no");
  });

  it("dict-ref — a second default is ignored (the rest list's car)", async () => {
    expect(await str("(dict-ref (dict) :a 7 8)")).toBe("7");
    expect(await str("(assoc-ref (dict :a 1) :b 7 8)")).toBe("7");
  });

  it("empty dict — zero keys, missing read is nil, a default still applies", async () => {
    expect(await str("(dict-count (dict))")).toBe("0");
    expect(await truthy("(null? (dict-keys (dict)))")).toBe("yes");
    expect(await truthy("(null? (dict-values (dict)))")).toBe("yes");
    expect(await truthy("(dict-has-key? (dict) :a)")).toBe("no");
    expect(await str("(dict-ref (dict) :a 7)")).toBe("7");
  });

  it("dict-keys / dict-values / dict->alist keep insertion order and line up", async () => {
    expect(await truthy('(equal? (dict-keys (dict :b 1 :a 2)) (list "b" "a"))')).toBe("yes");
    expect(await truthy("(equal? (dict-values (dict :b 1 :a 2)) (list 1 2))")).toBe("yes");
    expect(await truthy('(equal? (dict->alist (dict :a 1)) (list (cons "a" 1)))')).toBe("yes");
  });

  it("alist->dict — keyword and string keys fold together, last write wins, empty alist is an empty dict", async () => {
    expect(await str('(dict-ref (alist->dict (list (cons :a 1) (cons "a" 2))) :a)')).toBe("2");
    expect(await str('(dict-count (alist->dict (list (cons :a 1) (cons "a" 2))))')).toBe("1");
    expect(await str("(dict-ref (alist->dict '()) :a 3)")).toBe("3");
  });

  it("alist->dict — a non-pair element is rejected", async () => {
    await expect(raw("(alist->dict (list 1))")).rejects.toThrow();
  });

  it.each([
    ["dict-ref", "(list 1)", "a pair/list"],
    ["dict-ref", "(vector 1)", "a vector"],
    ["dict-ref", '"x"', "a string"],
    ["dict-ref", "1", "a number"],
    ["dict-ref", "'()", "'() (empty list)"],
    ["dict-ref", "(lambda () 1)", "a procedure"],
    ["dict-ref", "#t", "a foreign/membrane value"],
    ["dict-has-key?", "(vector 1)", "a vector"],
    ["dict-keys", "1", "a number"],
    ["dict-values", "'()", "'() (empty list)"],
    ["dict-count", "(lambda () 1)", "a procedure"],
    ["dict->alist", "#t", "a foreign/membrane value"],
    ["assoc-ref", "(list 1)", "a pair/list"],
  ] as const)("%s on %s names the carrier (%s)", async (verb, carrier, phrase) => {
    const who = verb === "assoc-ref" ? "dict-ref" : verb;
    const call =
      verb === "dict-ref" || verb === "dict-has-key?" || verb === "assoc-ref"
        ? `(${verb} ${carrier} :a)`
        : `(${verb} ${carrier})`;
    const esc = (s: string) => s.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    await expect(raw(call)).rejects.toThrow(
      new RegExp(`${esc(who)}: expected a dict .* got ${esc(phrase)}.*use @ for an origin-agnostic read`),
    );
  });
});
