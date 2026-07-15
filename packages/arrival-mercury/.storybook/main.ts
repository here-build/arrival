import type { StorybookConfig } from "@storybook/react-vite";

// A MINIMAL, self-contained gallery for the attribution-circuit renderers
// (model/circuit-mermaid.ts) — co-located with the package that owns them so
// a circuit change is eyeballed here instead of via a hand-built HTML
// artifact. Deliberately independent of inhuman-studio's storybook (whose
// setup is separately broken): no shared config, no shared deps beyond the
// versions copied verbatim from that sibling's package.json.
const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx"],
  framework: { name: "@storybook/react-vite", options: {} },
};

export default config;
