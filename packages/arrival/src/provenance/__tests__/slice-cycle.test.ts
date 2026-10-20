/**
 * `writeForm` refuses a cyclic datum with the cycle error instead of hanging — including a cycle
 * that lives in the cdr SPINE (`(a . #0=(b . #0#))`), which never returns to the head pair.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { ResolvingAmbient } from "../../env/AmbientRuntime.js";
import { execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { freshEnv } from "../../__tests__/_fresh-env.js";
import { writeForm } from "../slice.js";

describe("writeForm — cyclic datum", () => {
  let env: ResolvingAmbient;
  beforeAll(async () => {
    env = await freshEnv();
  });

  const datum = async (src: string) => {
    const { values } = await execState(src, { env });
    return values.at(-1);
  };

  it.each([
    ["head cycle", "'#0=(a . #0#)"],
    ["spine cycle not through the head", "'(a . #0=(b . #0#))"],
    ["car cycle", "'#0=(#0# b)"],
  ])("%s throws the cycle error", async (_name, src) => {
    const v = await datum(src);
    expect(() => writeForm(v)).toThrow(/cyclic datum/);
  });

  it("an acyclic list still serializes", async () => {
    expect(writeForm(await datum("'(a b . c)"))).toBe("(a b . c)");
  });
});
