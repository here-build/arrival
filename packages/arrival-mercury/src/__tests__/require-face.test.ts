// Types-only require faces — twin of build/prompt-module + build/hbs-module.
import { describe, expect, it } from "vitest";

import {
  emitDataRequireFace,
  emitHbsRequireFace,
  emitPromptRequireFace,
  emitRequireFaceModule,
} from "../type-emit/require-face.js";

describe("emitRequireFaceModule — types faces", () => {
  it("data face is typed default export", () => {
    const ts = emitDataRequireFace('List<{ "name": string }>');
    expect(ts).toContain("export default __default");
    expect(ts).toContain('List<{ "name": string }>');
  });

  it("prompt face: typed callable with key? + template holes", () => {
    const src = '{{role "user"}}\nHi {{name}}.';
    const ts = emitPromptRequireFace(src, "greet.prompt");
    expect(ts).not.toBeNull();
    expect(ts!).toContain("export default __default");
    expect(ts!).toContain('"key"?: string');
    expect(ts!).toContain('"name": unknown');
    expect(ts!).toMatch(/\(vars:/);
  });

  it("hbs face: pretreat → emitTypes → default export", () => {
    const ts = emitHbsRequireFace("Hello {{name}}");
    expect(ts).toContain("export default __default");
    expect(ts).toContain("template$slash$handlebars");
    expect(ts).toMatch(/\(arg/);
    expect(ts).not.toContain("export {};");
  });

  it("dispatch: .prompt uses content when present", () => {
    const ts = emitRequireFaceModule(
      "x.prompt",
      '{{role "user"}}\n{{topic}}',
      "(vars: any) => any",
    );
    expect(ts).toContain('"topic": unknown');
  });

  it("dispatch: data path uses registry type string", () => {
    const ts = emitRequireFaceModule("data.json", null, "{ a: number }");
    expect(ts).toContain("{ a: number }");
    expect(ts).toContain("export default");
  });
});
