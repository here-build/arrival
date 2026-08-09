import { describe, expect, it } from "vitest";

import { collectEmittedDependencies, emittedPackageJson } from "../product/emitted-deps.js";

describe("emitted-deps", () => {
  it("detects ramda from printed imports", () => {
    const deps = collectEmittedDependencies([
      { path: "main.ts", content: `import { length as length_ } from "ramda";\nexport const x = length_([]);\n` },
    ]);
    expect(deps).toEqual({ ramda: "0.31.3" });
  });

  it("ignores relative stage0 imports", () => {
    const deps = collectEmittedDependencies([
      { path: "main.ts", content: `import { car } from "./stage0.js";\n` },
    ]);
    expect(deps).toEqual({});
  });

  it("emittedPackageJson omits dependencies when none needed", () => {
    const json = JSON.parse(emittedPackageJson([{ path: "a.ts", content: "export const x = 1;\n" }]));
    expect(json.dependencies).toBeUndefined();
    expect(json.type).toBe("module");
  });

  it("emittedPackageJson includes ramda when used", () => {
    const json = JSON.parse(
      emittedPackageJson([{ path: "a.ts", content: `import { maxBy } from "ramda";\n` }], { name: "demo" }),
    );
    expect(json.name).toBe("demo");
    expect(json.dependencies.ramda).toBe("0.31.3");
  });
});
