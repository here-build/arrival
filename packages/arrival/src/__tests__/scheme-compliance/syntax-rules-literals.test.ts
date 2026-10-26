// syntax-rules' literal list must be a proper list of identifiers. Anything else is the
// "wrong identifier" error at definition time, never a crash reading past the list's end.
import { describe, expect, it } from "vitest";
import { freshEnv } from "../_fresh-env.js";
import { execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { toJS } from "../../membrane/rosetta.js";

const env = await freshEnv();

async function run(form: string): Promise<unknown> {
  const { values } = await execState(form, { env });
  return toJS(values[0]!);
}

describe("syntax-rules literal list", () => {
  it.each([
    ["an improper list", "(a . b)"],
    ["a non-symbol element", "(a 1)"],
    ["a non-list", "5"],
  ])("%s is rejected: %s", async (_label, literals) => {
    await expect(run(`(define-syntax bad (syntax-rules ${literals} ((_ x) x)))`)).rejects.toThrow(
      /syntax-rules: wrong identifier/,
    );
  });

  it("a proper list of identifiers is accepted, and its literals match", async () => {
    expect(await run("(begin (define-syntax kw (syntax-rules (=>) ((_ a => b) (list a b)))) (kw 1 => 2))")).toEqual([
      1, 2,
    ]);
  });

  it("an empty literal list is accepted", async () => {
    expect(await run("(begin (define-syntax id (syntax-rules () ((_ x) x))) (id 7))")).toBe(7);
  });
});
