import { createElement } from "react";
import mermaid from "mermaid";
import type { Preview } from "@storybook/react-vite";

// `startOnLoad: false` — CircuitMermaid renders on demand via `mermaid.render`,
// never via mermaid's own DOM auto-scan (which would race the story's own
// re-render on prop change). `theme: "dark"` because a circuit's shapes and
// the fabrication-mark flag read best against a dark canvas — match the
// decorator's background below so there is no light-canvas/dark-diagram clash.
mermaid.initialize({ startOnLoad: false, theme: "dark" });

// The `backgrounds` PARAMETER below is inert on its own — Storybook 10 needs
// the `@storybook/addon-backgrounds` addon REGISTERED (main.ts's `addons`)
// for a `parameters.backgrounds` value to ever paint anything; this gallery
// deliberately has no addons (`main.ts`'s header: "no shared config, no
// shared deps"), so without a decorator the canvas defaults to plain white —
// eye-searing against every circuit's dark shapes/labels. A GLOBAL DECORATOR
// wraps every story's rendered output in its own dark container instead: it
// has zero addon dependency, so it paints regardless of which addons are (or
// aren't) registered, and it works exactly the same in `storybook dev` and in
// a static `build-storybook` bundle.
const preview: Preview = {
  parameters: {
    backgrounds: { default: "circuit", values: [{ name: "circuit", value: "#12161f" }] },
    layout: "fullscreen",
  },
  decorators: [
    (Story) =>
      createElement(
        "div",
        {
          style: {
            minHeight: "100vh",
            padding: 24,
            background: "#12161f",
            color: "#c9d1d9",
            boxSizing: "border-box",
          },
        },
        createElement(Story),
      ),
  ],
};

export default preview;
