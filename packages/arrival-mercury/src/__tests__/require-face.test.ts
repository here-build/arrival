// Types-only require faces — twin of build/hbs-module + host-synthesized reqType.
import { describe, expect, it } from "vitest";

import {
  emitDataRequireFace,
  emitHbsRequireFace,
  emitRequireFaceModule,
} from "../type-emit/require-face.js";

describe("emitRequireFaceModule — types faces", () => {
  it("data face is typed default export", () => {
    const ts = emitDataRequireFace('List<{ "name": string }>');
    expect(ts).toContain("export default __default");
    expect(ts).toContain('List<{ "name": string }>');
  });

  it("host-synthesized callable face is the reqType stub", () => {
    const reqType = '(vars: { "key"?: string; "name": unknown }) => string';
    const ts = emitRequireFaceModule("greet.prompt", '{{role "user"}}\nHi {{name}}.', reqType);
    expect(ts).toContain("export default __default");
    expect(ts).toContain(reqType);
  });

  it("hbs face: pretreat → emitTypes → default export", () => {
    const ts = emitHbsRequireFace("Hello {{name}}");
    expect(ts).toContain("export default __default");
    expect(ts).toContain("template$slash$handlebars");
    expect(ts).toMatch(/\(arg/);
    expect(ts).not.toContain("export {};");
  });

  it("dispatch: non-hbs uses host reqType even when content is present", () => {
    const ts = emitRequireFaceModule("x.prompt", '{{role "user"}}\n{{topic}}', "(vars: any) => any");
    expect(ts).toContain("(vars: any) => any");
  });

  it("dispatch: data path uses registry type string", () => {
    const ts = emitRequireFaceModule("data.json", null, "{ a: number }");
    expect(ts).toContain("{ a: number }");
    expect(ts).toContain("export default");
  });
});
