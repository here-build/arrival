import { describe, it, expect } from "vitest";
import { exec, execStateOverFrame } from "../../../eval/generator-exec.js";
import { jsToScheme } from "../../../membrane/rosetta.js";
import { CONSTANT_CTX } from "../../../run/RunContext.js";
import { inferenceEnv } from "../../inference-env.js";

const run = async (src: string) => (await exec(src))[0];

describe("slice helpers door out-of-range instead of leaking JS slice semantics", () => {
  it.each([
    '(substring "hello" 3 1)',
    '(substring "hello" -1 2)',
    '(substring "hello" 1 99)',
    '(string-copy "abc" -1)',
    '(string->list "abc" 1 9)',
    '(string-copy "abc" 1.5)',
  ])("%s raises a taught range error", async (src) => {
    await expect(run(src)).rejects.toThrow(/out of range|range \[/);
  });

  it("in-range slices still answer, by code point", async () => {
    expect(String(await run('(substring "hello" 1 3)'))).toBe("el");
    expect(String(await run('(substring "a😀b" 1 2)'))).toBe("😀");
    expect(String(await run('(string-copy "abc" 1)'))).toBe("bc");
    expect(await run('(length (string->list "abc" 1 3))')).toBe(2);
  });
});

describe("string ops are code-point consistent", () => {
  it("string-map / string-for-each see one char per code point", async () => {
    expect(String(await run(String.raw`(string-map (lambda (c) #\x) "😀")`))).toBe("x");
    await expect(
      run(String.raw`(string-for-each (lambda (c) (if (char=? c #\😀) (error "hit") #f)) "😀a")`),
    ).rejects.toThrow("hit");
    expect(String(await run('(string-map (lambda (c d) c) "😀a" "xy")'))).toBe("😀a");
  });
  it("string-contains answers a code-point index, agreeing with string-index", async () => {
    expect(await run('(string-contains "😀ab" "a")')).toBe(1);
    expect(await run(String.raw`(string-index "😀ab" #\a)`)).toBe(1);
  });
  it("string-split with an empty delimiter splits per character", async () => {
    expect(await run('(string-split "a😀" "")')).toEqual(["a", "😀"]);
  });
  it("string->vector yields one character per code point, sliced by code point", async () => {
    expect(await run('(vector-length (string->vector "😀a"))')).toBe(2);
    expect(await run(String.raw`(char=? (vector-ref (string->vector "a😀b" 1 2) 0) #\😀)`)).toBe(true);
  });
});

describe("string-ci family folds (R7RS), not lowercases", () => {
  it.each([
    ['(string-ci=? "Straße" "STRASSE")', true],
    ['(string-ci=? "ΣΑΣ" "σας")', true],
    ['(string-ci<? "a" "B")', true],
    ['(string-ci>? "b" "A")', true],
    ['(string-ci<=? "a" "A" "b")', true],
    ['(string-ci>=? "b" "B" "a")', true],
    ['(string-ci<? "a" "A")', false],
  ])("%s", async (src, expected) => {
    expect(await run(src)).toBe(expected);
  });
});

describe("string->number accepts the R7RS specials", () => {
  it("+inf.0 / -inf.0 / +nan.0", async () => {
    expect(await run('(string->number "+inf.0")')).toBe(Infinity);
    expect(await run('(string->number "-inf.0")')).toBe(-Infinity);
    expect(await run('(string->number "+nan.0")')).toBeNaN();
    expect(await run('(inexact? (string->number " +inf.0 "))')).toBe(true);
  });
  it("bare inf.0 stays #f", async () => {
    expect(await run('(string->number "inf.0")')).toBe(false);
  });
});

describe("list->string walks a proper list", () => {
  it("builds from a list of chars", async () => {
    expect(String(await run(String.raw`(list->string (list #\a #\b))`))).toBe("ab");
    expect(String(await run("(list->string '())"))).toBe("");
  });
  it.each([
    "(list->string 5)",
    String.raw`(list->string (cons #\a #\b))`,
    String.raw`(let ((l (list #\a))) (set-cdr! l l) (list->string l))`,
  ])("%s is an error", async (src) => {
    await expect(run(src)).rejects.toThrow();
  });
  it("a non-char element is an error", async () => {
    await expect(run("(list->string (list 1))")).rejects.toThrow();
  });
});

describe("silent stringification is a door", () => {
  it("string-join rejects non-string elements and delimiters", async () => {
    await expect(run("(string-join (list 1 2))")).rejects.toThrow(/string-join: element 0 must be a string/);
    await expect(run('(string-join \'("a" "b") 5)')).rejects.toThrow(/delimiter must be a string/);
    expect(String(await run('(string-join (list "a" "b") "-")'))).toBe("a-b");
  });
  it("string-pad(-right) requires a non-negative integer length", async () => {
    await expect(run('(string-pad "abc" 2.5)')).rejects.toThrow(/non-negative integer/);
    await expect(run('(string-pad-right "abc" -1)')).rejects.toThrow(/non-negative integer/);
    expect(String(await run('(string-pad "abc" 5)'))).toBe("  abc");
  });
  it("string-map requires a character result", async () => {
    await expect(run('(string-map (lambda (c) 1) "ab")')).rejects.toThrow(/must return a character/);
    await expect(run('(string-map (lambda (c) "xy") "ab")')).rejects.toThrow(/must return a character/);
    expect(String(await run('(string-map char-upcase "ab")'))).toBe("AB");
  });
});

describe("string-trim family criterion", () => {
  it("a non-char non-procedure criterion is a taught error naming the op", async () => {
    await expect(run('(string-trim-right "x" 5)')).rejects.toThrow(/string-trim-right: criterion/);
  });
  it("only #f is a miss for a predicate criterion ('() is a match)", async () => {
    expect(await run('(string-index "abc" (lambda (c) \'()))')).toBe(0);
  });
});

describe("string-for-each with an async host callback", () => {
  it("waits for every callback before returning", async () => {
    const seen: string[] = [];
    const visit = async (c: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(String(c));
    };
    const env = inferenceEnv.child("string-for-each-async", { visit: jsToScheme(CONSTANT_CTX, visit) });
    await execStateOverFrame('(string-for-each visit "ab")', { env });
    expect(seen.toSorted()).toEqual(["a", "b"]);
  });
});
