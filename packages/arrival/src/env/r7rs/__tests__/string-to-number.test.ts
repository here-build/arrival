import { describe, it, expect } from "vitest";
import { exec } from "../../../eval/generator-exec.js";

describe("string->number sheds surrounding whitespace", () => {
  it.each([
    { name: "surrounding whitespace is shed", src: String.raw`(string->number " \t42\n ")`, value: 42 },
    { name: "padded rational stays exact", src: '(exact? (string->number "  1/3  "))', value: true },
    { name: "internal space is still #f", src: '(string->number "1 2")', value: false },
  ])("$name", async ({ src, value }) => {
    const [v] = await exec(src);
    expect(v).toBe(value);
  });
});
