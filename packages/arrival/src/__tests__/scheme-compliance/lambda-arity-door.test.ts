// Lambda arity door: a user lambda / named-let loop called with the wrong number of
// arguments is refused with a taught ArityMismatchError. Before the door, too FEW leaked the
// membrane's internal "bind: raw JS undefined refused" and too MANY were silently dropped.
import { describe, expect, it } from "vitest";
import { exec } from "../../index.js";
import { ArityMismatchError } from "../../errors.js";

const run = (src: string) => exec(src) as Promise<unknown[]>;
const last = async (src: string) => (await run(src)).at(-1);

describe("lambda arity door", () => {
  it("too few arguments names the missing parameter and the rest-accepting spelling", async () => {
    await expect(run("((lambda (a b) a) 1)")).rejects.toThrow(
      /takes exactly 2 arguments \(a b\), got 1 — supply `b`, or accept optional args with `\(a \. rest\)`/,
    );
    await expect(run("((lambda (a b) a) 1)")).rejects.toBeInstanceOf(ArityMismatchError);
  });

  it("too many arguments says to drop them or accept them", async () => {
    await expect(run("((lambda (a) a) 1 2)")).rejects.toThrow(
      /takes exactly 1 argument \(a\), got 2 — drop the extras or accept them with `\(a \. rest\)`/,
    );
  });

  it("a defined function is named in the message", async () => {
    await expect(run("(define (f a b) a) (f 1 2 3)")).rejects.toThrow(/^`f` takes exactly 2 arguments \(a b\), got 3/);
  });

  it("rest parameters accept any count at or above the positional minimum", async () => {
    expect(await last("((lambda (a . rest) rest) 1 2 3)")).toEqual([2, 3]);
    expect(await last("((lambda args args))")).toEqual([]);
    await expect(run("((lambda (a b . rest) a))")).rejects.toThrow(/takes at least 2 arguments \(a b \. rest\), got 0/);
  });

  it("exact calls still run", async () => {
    expect(await last("((lambda (a b) (+ a b)) 1 2)")).toBe(3);
    expect(await last("((lambda () 7))")).toBe(7);
  });

  it("named let enforces its binding count on recursive calls", async () => {
    expect(await last("(let loop ((i 0)) (if (< i 3) (loop (+ i 1)) i))")).toBe(3);
    await expect(run("(let loop ((i 0)) (if (< i 3) (loop (+ i 1) 9) i))")).rejects.toThrow(
      /^`loop` takes exactly 1 argument \(i\), got 2/,
    );
  });

  it("a higher-order callback with the wrong arity is refused", async () => {
    await expect(run("(map (lambda (x y) x) '(1 2))")).rejects.toBeInstanceOf(ArityMismatchError);
    expect(await last("(map (lambda (x) (* x x)) '(1 2 3))")).toEqual([1, 4, 9]);
  });
});
