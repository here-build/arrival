// R7RS §4.2.4: each `do` iteration rebinds the loop variables to FRESH locations, so a
// closure captured in one iteration keeps that iteration's value.
import { describe, expect, it } from "vitest";
import { exec } from "../../index.js";

const last = async (src: string) => ((await exec(src)) as unknown[]).at(-1);

describe("do rebinds loop variables per iteration", () => {
  it("closures capture per-iteration values", async () => {
    expect(
      await last(`
        (do ((i 0 (+ i 1))
             (acc '() (cons (lambda () i) acc)))
            ((= i 3) (map (lambda (f) (f)) acc)))`),
    ).toEqual([2, 1, 0]);
  });
  it("a step-less variable keeps its value across iterations", async () => {
    expect(await last("(do ((i 0 (+ i 1)) (k 10)) ((= i 3) (+ i k)))")).toBe(13);
  });
  it("steps see the previous iteration's values", async () => {
    expect(await last("(do ((i 0 (+ i 1)) (s 0 (+ s i))) ((= i 4) s))")).toBe(6);
  });
});
