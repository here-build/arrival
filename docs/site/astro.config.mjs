import { fileURLToPath } from "node:url";

import { satteri } from "@astrojs/markdown-satteri";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

import { base, site } from "./mounts.mjs";
import { mountAll, mountSources } from "./scripts/mount.mjs";
import { schemeSamplePlugin } from "./scripts/scheme-samples-md.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const codeMirrorModules = new URL("../../packages/arrival-codemirror/node_modules/", import.meta.url);

// Pages exist before Starlight scans the content collection.
mountAll();

function cm(name) {
  return fileURLToPath(new URL(name, codeMirrorModules));
}

/** One CodeMirror instance for the language mode and the editor theme. */
function codeMirrorAliases() {
  return {
    "@here.build/arrival-codemirror/language": fileURLToPath(
      new URL("../../packages/arrival-codemirror/src/scheme-sugarcoat.ts", import.meta.url),
    ),
    "@codemirror/state": cm("@codemirror/state"),
    "@codemirror/view": cm("@codemirror/view"),
    "@codemirror/language": cm("@codemirror/language"),
    "@lezer/highlight": cm("@lezer/highlight"),
  };
}

function docsMountPlugin() {
  const sources = new Set(mountSources());
  return {
    name: "arrival-docs-mount",
    configureServer(server) {
      server.watcher.add([...sources]);
      server.watcher.on("change", (file) => {
        if (sources.has(file)) mountAll();
      });
    },
  };
}

export default defineConfig({
  site,
  base,
  markdown: {
    processor: satteri({
      mdastPlugins: [schemeSamplePlugin()],
    }),
  },
  vite: {
    plugins: [docsMountPlugin()],
    resolve: { alias: codeMirrorAliases() },
    server: { fs: { allow: [repoRoot] } },
  },
  integrations: [
    starlight({
      title: "Arrival",
      description: "A sandboxed Scheme for agents that need to compute, not just call tools.",
      editLink: {
        baseUrl: "https://github.com/here-build/arrival/edit/main/docs/site/",
      },
      customCss: ["./src/styles/site.css"],
      expressiveCode: {
        themes: ["dark-plus", "dark-plus"],
        useStarlightUiThemeColors: false,
        styleOverrides: {
          borderRadius: "2px",
          codeFontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
          codeFontSize: "0.875rem",
          codeLineHeight: "1.55",
        },
      },
      components: {
        Footer: "./src/components/Footer.astro",
      },
      sidebar: [
        { label: "Language", items: [{ autogenerate: { directory: "language" } }] },
        { label: "Capabilities", items: [{ autogenerate: { directory: "capabilities" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        { label: "For agents", items: [{ autogenerate: { directory: "agents" } }] },
        { label: "Packages", items: [{ autogenerate: { directory: "packages" } }] },
        { label: "Internals", items: [{ autogenerate: { directory: "internals" } }] },
      ],
    }),
  ],
});
