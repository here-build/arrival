/**
 * names-diff — the E1a review lens (engine plan risk 2): AST-equal-modulo-identifiers.
 * Contract under test lives in `../oracle/names-diff.ts`'s header; the rows here
 * pin both directions — equal means the diff IS just naming (with the exact rename
 * table); everything else honestly reports the first divergence.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assertFixtureNamesOnly, namesOnlyDiff } from "@inhuman.tools/arrival-mercury-oracle";

describe("namesOnlyDiff — self", () => {
  it("byte-identical input is equal with empty renames", () => {
    const src = `const a = 1;\nexport const out = a + 1;\n`;
    const d = namesOnlyDiff(src, src);
    expect(d.equalModuloNames).toBe(true);
    expect(d.renames.size).toBe(0);
    expect(d.divergence).toBeUndefined();
  });

  it("comments and whitespace are outside the comparison (trivia)", () => {
    const oldTs = `const a = 1;\nconst b = a + 2;\n`;
    const newTs = `// counting\nconst a = 1;\n\n\nconst b = a + 2; /* same program */\n`;
    const d = namesOnlyDiff(oldTs, newTs);
    expect(d.equalModuloNames).toBe(true);
    expect(d.renames.size).toBe(0);
  });
});

describe("namesOnlyDiff — positive: consistent local renames", () => {
  // Covers the brief's required shapes: an array-destructure pattern (head/rest),
  // an object-destructure ALIAS ({ size: bucket } — key stays, alias renames),
  // a lambda param (row), a function param (count), plus reference sites.
  const OLD = [
    `const [head, ...rest] = items;`,
    `const pick = (row) => row + head;`,
    `function tally(count) {`,
    `  const { size: bucket } = count;`,
    `  return pick(bucket) + rest.length;`,
    `}`,
    `export { tally };`,
  ].join("\n");
  const NEW = [
    `const [first, ...others] = items;`,
    `const pick = (r) => r + first;`,
    `function tally(c) {`,
    `  const { size: b } = c;`,
    `  return pick(b) + others.length;`,
    `}`,
    `export { tally };`,
  ].join("\n");

  it("renamed locals (destructure elements, lambda param, fn param) are equal-modulo-names", () => {
    const d = namesOnlyDiff(OLD, NEW);
    expect(d.divergence).toBeUndefined();
    expect(d.equalModuloNames).toBe(true);
    expect(d.renames).toEqual(
      new Map([
        ["head", "first"],
        ["rest", "others"],
        ["row", "r"],
        ["count", "c"],
        ["bucket", "b"],
      ]),
    );
  });
});

describe("namesOnlyDiff — negative: fixed positions", () => {
  it("property access name change is NOT a rename and the divergence names the position", () => {
    const d = namesOnlyDiff(`const n = xs.length;\n`, `const n = xs.size;\n`);
    expect(d.equalModuloNames).toBe(false);
    expect(d.divergence).toMatch(/property\/member name 'length' vs 'size'/);
    expect(d.divergence).toMatch(/PropertyAccessExpression/); // the position path names the node kind
    expect(d.divergence).toMatch(/not a renameable position/);
  });

  it("object-literal key change is NOT a rename", () => {
    const d = namesOnlyDiff(`const o = { mode: 1 };\n`, `const o = { kind: 1 };\n`);
    expect(d.equalModuloNames).toBe(false);
    expect(d.divergence).toMatch(/property\/member name 'mode' vs 'kind'/);
  });

  it("import specifier change is NOT a rename", () => {
    const d = namesOnlyDiff(
      `import { list } from "./stage0.mts";\nexport const out = list(1);\n`,
      `import { roster } from "./stage0.mts";\nexport const out = roster(1);\n`,
    );
    expect(d.equalModuloNames).toBe(false);
    expect(d.divergence).toMatch(/import\/export-bound name 'list' vs 'roster'/);
  });

  it("the import pin: renaming ONLY the call sites of an import is caught", () => {
    // Positionally this looks like a consistent rename of `list` at the call
    // site — but the untouched specifier registers list→list as identity, so
    // the bijection reports the drift (the new reference would be unbound).
    const d = namesOnlyDiff(
      `import { list } from "./stage0.mts";\nexport const out = list(1);\n`,
      `import { list } from "./stage0.mts";\nexport const out = roster(1);\n`,
    );
    expect(d.equalModuloNames).toBe(false);
    expect(d.divergence).toMatch(/inconsistent renaming: 'list'/);
  });

  it("module string change is NOT a rename", () => {
    const d = namesOnlyDiff(`import { list } from "./stage0.mts";\n`, `import { list } from "./stage1.mts";\n`);
    expect(d.equalModuloNames).toBe(false);
    expect(d.divergence).toMatch(/StringLiteral content "\.\/stage0\.mts" vs "\.\/stage1\.mts"/);
  });
});

describe("namesOnlyDiff — negative: structural changes", () => {
  it("an extra statement diverges on child count", () => {
    const d = namesOnlyDiff(`const a = 1;\n`, `const a = 1;\nconst b = 2;\n`);
    expect(d.equalModuloNames).toBe(false);
    expect(d.divergence).toMatch(/SourceFile has 2 children vs 3/); // statements + EndOfFileToken
  });

  it("a different numeric literal diverges on content", () => {
    const d = namesOnlyDiff(`const a = 1;\n`, `const a = 2;\n`);
    expect(d.equalModuloNames).toBe(false);
    expect(d.divergence).toMatch(/NumericLiteral content "1" vs "2"/);
  });

  it("a different string literal diverges on content", () => {
    const d = namesOnlyDiff(`const a = "x";\n`, `const a = "y";\n`);
    expect(d.equalModuloNames).toBe(false);
    expect(d.divergence).toMatch(/StringLiteral content "x" vs "y"/);
  });

  it("a different node kind diverges with both kinds named", () => {
    const d = namesOnlyDiff(`const a = f(1);\n`, `const a = [1];\n`);
    expect(d.equalModuloNames).toBe(false);
    expect(d.divergence).toMatch(/CallExpression .* vs ArrayLiteralExpression/);
  });
});

describe("namesOnlyDiff — negative: bijection violations", () => {
  it("one old name mapping to two new names is inconsistent", () => {
    const d = namesOnlyDiff(`const a = 1;\nconst b = a + a;\n`, `const x = 1;\nconst b = x + y;\n`);
    expect(d.equalModuloNames).toBe(false);
    expect(d.divergence).toMatch(/inconsistent renaming: 'a' → 'x' .* but also 'a' → 'y'/);
  });

  it("two old names collapsing to one new name is a collision", () => {
    const d = namesOnlyDiff(
      `const a = 1;\nconst b = 2;\nconst c = a + b;\n`,
      `const z = 1;\nconst z = 2;\nconst c = z + z;\n`,
    );
    expect(d.equalModuloNames).toBe(false);
    expect(d.divergence).toMatch(/name collision: 'a' → 'z' .* and 'b' → 'z'/);
  });
});

describe("namesOnlyDiff — realistic: a committed emission fixture, locals renamed", () => {
  it("multi-list-map with its two glue locals renamed is equal-modulo-names with the exact map", () => {
    const committed = readFileSync(
      fileURLToPath(new URL("fixtures/emitted/multi-list-map.ts", import.meta.url)),
      "utf8",
    );
    // Guard against fixture drift: this row renames __item/__i by hand. If E1a's
    // regeneration retires these glue names from the fixture, refresh the row by
    // picking any two locals from the new text (the seam below is the real consumer).
    expect(committed).toContain("__item");
    expect(committed).toContain("__i");
    const renamed = committed.replace(/\b__item\b/g, "element").replace(/\b__i\b/g, "position");
    const d = namesOnlyDiff(committed, renamed);
    expect(d.divergence).toBeUndefined();
    expect(d.equalModuloNames).toBe(true);
    expect(d.renames).toEqual(
      new Map([
        ["__item", "element"],
        ["__i", "position"],
      ]),
    );
  });
});

describe("assertFixtureNamesOnly — the E1a regeneration-review seam", () => {
  // E1a's fixture regeneration calls this once per emitted `.ts` fixture:
  //   const renames = assertFixtureNamesOnly(committedText, regeneratedText);
  // Equal → the returned table IS the review unit (the judge reads naming as
  // naming); not equal → the throw carries the first structural divergence and
  // the fixture falls back to ordinary byte-diff review. `.error.txt` door
  // fixtures never enter this seam.
  it("returns the rename table when the diff is names-only", () => {
    const renames = assertFixtureNamesOnly(
      `function OracleMain() {\n  const __x = 1;\n  return __x;\n}\n`,
      `function OracleMain() {\n  const seed = 1;\n  return seed;\n}\n`,
    );
    expect(renames).toEqual(new Map([["__x", "seed"]]));
  });

  it("throws with the divergence when the diff is more than naming", () => {
    expect(() => assertFixtureNamesOnly(`const n = xs.length;\n`, `const n = xs.size;\n`)).toThrow(
      /NOT equal modulo identifiers — .*property\/member name 'length' vs 'size'/,
    );
  });
});
