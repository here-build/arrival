// EnvCapability.define — TYPE-LEVEL PROOF that `this` inside a symbol impl is narrowed to the
// capability's own declared `configuration`/`resources`: a mistyped `this.configuration.<unknown key>`
// must fail to typecheck, proving the inference does not silently widen `this` to `any`.
// (Runtime behavior lives in capability-define-symbols.test.ts; this file runs under
// `vitest --typecheck`, where `@ts-expect-error` reds if the marked line ever compiles.)
import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";

import { EnvCapability } from "../capability.js";

interface Shout {
  shout(s: string): string;
}

describe("EnvCapability.define — typed `this`", () => {
  test("a mistyped this.configuration property is a compile error", () => {
    EnvCapability.define("test/define-greeter-bad", {
      configuration: { key: z.string() },
      resources: (config): Shout => ({ shout: (s: string) => `${config.key}:${s.toUpperCase()}` }),
      symbols: (symbol, sz) => ({
        greet: symbol.rosetta`greet: negative assertion only, never invoked`(
          { input: [sz.string], output: [sz.string] },
          function (s: string) {
            // @ts-expect-error — "wrong" does not exist on `configuration` (only "key" does).
            void this.configuration.wrong;
            return this.resources.shout(s);
          },
        ),
      }),
    });
    expectTypeOf<true>().toEqualTypeOf<true>();
  });
});
