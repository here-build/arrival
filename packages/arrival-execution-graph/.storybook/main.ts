import type { StorybookConfig } from "@storybook/react-vite";

// The package's own gallery: the palette (every state, frame and edge kind on hand-built graphs),
// the constructs and the run lifecycle (live arrival runs).
const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx"],
  framework: { name: "@storybook/react-vite", options: {} },
};

export default config;
