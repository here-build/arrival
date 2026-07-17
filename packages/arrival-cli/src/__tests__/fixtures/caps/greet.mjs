// Fixture capability — the SIMPLE arm: one verb, zero configuration. Loaded by the
// suite through the REAL channel (`--with <path>` on the built CLI), so it exercises
// specifier resolution + the instanceof identity check end-to-end.
import { EnvCapability } from "@inhuman.tools/arrival/capability";

export default new EnvCapability("fixture/greet", {
  symbols: {
    // Legacy bare-fn form (rosetta-wrapped by the capability machinery) — the smallest
    // authorable verb for a plain .mjs fixture.
    greet: () => "hello, world",
  },
});
