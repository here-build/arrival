// The file-type resolver registry behind (require/register-extension): by-name mapping,
// longest-suffix match, idempotent register / conflict-throw, and the prelude-only stub.
import { afterEach, describe, expect, it } from "vitest";

import { __resetExtensionRegistryForTest, lookupExtensionResolver, registerExtension } from "../loader-extensions.js";

afterEach(() => __resetExtensionRegistryForTest());

describe("registerExtension / lookupExtensionResolver", () => {
  it("maps a suffix to a resolver verb NAME and looks it up by path", () => {
    registerExtension(".hbs", "handlebars/lambda");
    expect(lookupExtensionResolver("templates/card.hbs")).toBe("handlebars/lambda");
    expect(lookupExtensionResolver("data/x.json")).toBeUndefined();
  });

  it("normalizes a dot-less suffix", () => {
    registerExtension("toml", "toml/parse");
    expect(lookupExtensionResolver("config.toml")).toBe("toml/parse");
  });

  it("longest matching suffix wins (.spec.json beats .json)", () => {
    registerExtension(".json", "data/json");
    registerExtension(".spec.json", "spec/parse");
    expect(lookupExtensionResolver("a.json")).toBe("data/json");
    expect(lookupExtensionResolver("a.spec.json")).toBe("spec/parse");
  });

  it("re-registering the SAME mapping is an idempotent no-op", () => {
    registerExtension(".prompt", "prompt/compile");
    expect(() => registerExtension(".prompt", "prompt/compile")).not.toThrow();
    expect(lookupExtensionResolver("x.prompt")).toBe("prompt/compile");
  });

  it("a CONFLICTING name for an already-claimed suffix throws", () => {
    registerExtension(".prompt", "prompt/compile");
    expect(() => registerExtension(".prompt", "other/compile")).toThrow(/already handled by "prompt\/compile"/);
  });
});

// The `(require/register-extension)` verb itself (the baked `symbol.native` def, bound at both
// its bootstrap and mid-run sites) is no longer unit-tested against a hand-rolled host here — it
// has no imperative `defineRosetta`-shaped helper left to drive in isolation; both real bind
// sites live in `loader-capability.ts` and are exercised end-to-end by
// `second-foundation/arrival-chain/src/__tests__/register-extension-prelude-overlay.test.ts`.
