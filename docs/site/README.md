# Arrival documentation site

Starlight renders two kinds of pages.

Handwritten guides live in `src/content/docs/`. The landing page is one. A tutorial joins it when its examples have been run.

Every other page is a view of a file that already owns the text. [`mounts.mjs`](./mounts.mjs) names the source file, the URL, and the sidebar label. `scripts/mount.mjs` writes the Starlight page: it drops the source heading (Starlight shows the title), rewrites links between mounted pages to site URLs, and points Edit page at the source. Generated pages are gitignored. Edit the source file.

`internals/`, `packages/`, `reference/`, `agents/`, `language/`, and `capabilities/` are generated directories. Handwritten pages do not go there.

Scheme, `scm`, and `sugarcoat` fences become a read-only CodeMirror 6 editor: `schemeSugarcoat()` from `@here.build/arrival-codemirror/language` and the theme from `@here.build/editor-theme`. The code stays in the HTML, so the page can be read without JavaScript. Other fences use Starlight's highlighter.

Markdown links include the site base, for example `[Sugarcoat](/arrival/language/sugarcoat/)`. `base` in `mounts.mjs` is `/arrival`, which is where GitHub project Pages serves this repository.

## Run

From the repository root (Node >= 22.12):

```sh
pnpm install
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
```

The dev server prints a URL under `/arrival/`. Production output is `docs/site/dist/`. `.github/workflows/docs.yml` publishes `https://here-build.github.io/arrival/` on push to `main`.

## Add a mounted page

Add one object to `mounts.mjs`. `source` is the repository path of the owning file. `out` is the path under `src/content/docs/`. `order` is the sidebar position. `label` is the short sidebar name. The page title is the source file's first heading.
