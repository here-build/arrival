// Fixture capability — the CONFIG-GATED arm: `greeting` is a declared-OPTIONAL
// enabling key (the loader's `fs` pattern). Present ⇒ the verb binds; absent under
// `degradation: "doors"` ⇒ a cause-carrying door, which the static pass reports as
// the causal "provide `greeting`" diagnostic (bucket c, missing-configuration).
import { EnvCapability } from "@here.build/arrival/capability";
import { custom } from "@here.build/arrival/scheme-zod";

export const configGreetCapability = new EnvCapability("fixture/config-greet", {
  configuration: {
    greeting: custom((v) => typeof v === "string").optional(),
  },
  symbols: ({ configuration, degradation }) => ({
    "greet/configured":
      configuration.greeting === undefined && degradation.active
        ? degradation.door(
            "greet/configured",
            ["greeting"],
            'greets with the host-provided greeting. Provide "greeting" to enable it.',
          )
        : () => `hello, ${configuration.greeting}`,
  }),
});
