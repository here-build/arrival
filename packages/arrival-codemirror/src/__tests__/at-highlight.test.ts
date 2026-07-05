// at-expression syntax highlighting (scheme-sweet StreamLanguage).
import { describe, expect, it } from "vitest";
import { StringStream } from "@codemirror/language";

import { parser } from "../scheme-sweet.js";

/** Drive the StreamParser over multi-line source → [text, tag] pairs (tag "" = null). */
function tokens(src: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const state = parser.startState!(2);
  for (const line of src.split("\n")) {
    const s = new StringStream(line, 2, 2, () => 0);
    while (!s.eol()) {
      s.start = s.pos;
      const tag = parser.token(s, state);
      if (s.pos === s.start) {
        s.pos++;
        continue;
      }
      out.push([line.slice(s.start, s.pos), tag ?? ""]);
    }
  }
  return out;
}

describe("at-expression highlighting", () => {
  it("single-line @{…}: opener keyword, prose string, interp variableName", () => {
    const toks = tokens("@{Pitch @product now}");
    expect(toks).toEqual([
      ["@{", "sweetAtOpen"],
      ["Pitch ", "string"],
      ["@product", "sweetInterp"],
      [" now", "string"],
      ["}", "sweetCurly"],
    ]);
  });

  it("@dedent head + @(graft) + quotes-as-literal", () => {
    const toks = tokens('@dedent{Say "@x" or @(f y)}');
    expect(toks).toEqual([
      ["@dedent{", "sweetAtOpen"],
      ['Say "', "string"],
      ["@x", "sweetInterp"],
      ['" or ', "string"],
      ["@(f y)", "sweetInterp"],
      ["}", "sweetCurly"],
    ]);
  });

  it("multi-line body carries the text mode across lines", () => {
    const toks = tokens("@dedent{first @a\n  second @b}");
    // spot-check: interps on both lines pop, close brace ends it
    expect(toks.filter(([, tag]) => tag === "sweetInterp").map(([txt]) => txt)).toEqual(["@a", "@b"]);
    expect(toks.at(-1)).toEqual(["}", "sweetCurly"]);
  });

  it("bare @foo (no brace) stays a symbol, not an at-opener", () => {
    const toks = tokens("(@ obj key)");
    expect(toks.some(([, tag]) => tag === "sweetAtOpen")).toBe(false);
  });
});
