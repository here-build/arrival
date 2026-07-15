import mermaid from "mermaid";
import type { Preview } from "@storybook/react-vite";

// `startOnLoad: false` — CircuitMermaid renders on demand via `mermaid.render`,
// never via mermaid's own DOM auto-scan (which would race the story's own
// re-render on prop change). `theme: "dark"` because a circuit's shapes and
// the fabrication-mark flag read best against a dark canvas — match the
// backgrounds default below so there is no light-canvas/dark-diagram clash.
mermaid.initialize({ startOnLoad: false, theme: "dark" });

const preview: Preview = {
  parameters: {
    backgrounds: { default: "circuit", values: [{ name: "circuit", value: "#15171f" }] },
    layout: "fullscreen",
  },
};

export default preview;
