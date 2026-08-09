# Arrival

**The first ever language built for AI[^1], finally built for AI.**

[^1]: Lisp was born in 1958 for AI research — the first language built *for* AI. arrival is a
    Lisp dialect finally built for AI *as the user*: the agent writes the programs. ![Elegant weapons,
    for a more civilized age.](./assets/xkcd-297-lisp-cycles.png)
    ([xkcd 297](https://xkcd.com/297/) by Randall Munroe, [CC BY-NC 2.5](https://creativecommons.org/licenses/by-nc/2.5/).)

Arrival is a symbolic stack built around LLMs' needs.
It is not the first attempt to create a "special language for AI",
and it is not even a special language designed for AI.

It is the behavior of the language that matters.

[Code Mode](https://blog.cloudflare.com/code-mode/) by Cloudflare proves the point:
give the agent an environment, and it will do everything it needs.

[Toon](https://github.com/toon-format/toon) proves the second side:
any format is good enough, as long as it's readable.

Arrival, as a stack, is the natural next step, consolidating that prior art.

## The language

Agents are good at intent and bad at materialization.
Arrival compensates for that — Scheme was chosen deliberately.
It is a faithful R7RS sandbox without dynamics or mutability (`set!` and `call/cc` eliminated);
taking those away makes strong predictions about the executed output possible.

Agents are not that good at writing Scheme, but they are good at writing Lisp in general.
The cumulative dataset of dialects is large enough to teach agents;
the problem is, what agents really know is not Scheme or any other dialect,
but rather DeepDream output with brackets instead of dogs.

That blur has a cost, and arrival pays it in syntax: extended to support well-known features from Clojure, Racket and Common Lisp.
Nothing violates R7RS — only spec-undefined behavior was adjusted.
Attempts to violate the spec, however, are not ignored — grammar errors are classified to identify
which expression the LLM tried to write, and the diagnostic explains how to do it right.

## Packages

> `arrival-manifold` (MCP multi-server collapse) and `arrival-bench` are
> **not packaged in this repository** yet — they remain experimental in the
> product monorepo and are not part of the publishable arrival workspace.

Everything else comes on top of the language, in a variety of shapes:

- `arrival` — the interpreter, environment/capability system, and stdlib.
  Environments compose from capability packs (C3-linearized); symbols carry
  declared contracts (provenance role, cache class, emission knowledge) that
  every tool downstream reads.
- `arrival-cli` — `arrival run file.scm`, the REPL, and static checking.
- `arrival-sugarcoat` — the syntax lens: classic ↔ sugarcoat rendering
  (indentation I-expressions, curly-infix, accessors).
- `arrival-serializer` — the JS ↔ S-expression wire: s-expression output
  that is more compact than JSON for agent consumption.
- `arrival-provenance` — analysis owner: forest, statechart, region tree,
  flow graph, reverse-chain slicer (`buildUneval`), and the grounding seal
  live natively here. Core (`arrival`'s `/provenance`) keeps only the capture
  spine (`EvalTrace`, stamping); this package re-exports capture for
  convenience and adds the mobx-reactive `ObservableEvalTrace` so studio/UI
  consumers get reactive semantics without core taking on a mobx dependency.
- `arrival-mcp` — the framework for MCP servers that run sandboxed code with
  predefined capabilities: Model Context Protocol tools as values (discovery +
  action tiers); `arrival-mcp-do` — the Durable Object session shell;
  `mcp-substrate` — the doors system: error enrichment, session replay,
  futility detection. Rejections teach and route; they do not ban.
- `mcp-typescript-lsp` — TypeScript code-intelligence MCP tool (hover,
  definition, references, impact analysis, …) as an arrival-mcp `McpTool`,
  with s-expression results for agent reasoning.
- `arrival-lsp` — the Scheme→TS type lens: arrival programs bite under
  `tsc`, and diagnostics lift back to their `.scm` spans.
- `arrival-mercury` — the Mercury compiler: arrival Scheme projected into
  human-grade TypeScript, designed around the reader's mental model rather
  than mechanically lowered.
- `arrival-mercury-oracle` — the differential oracle: interpreter vs
  compiled output, compared as black-box source-in/value-out outcomes;
  split out from arrival-mercury to isolate the `tsx` runtime dependency
  the compiler itself must not carry.
- `arrival-codemirror` — CodeMirror 6 for arrival Scheme (classic +
  sugarcoat): structural editing, ghost text, param hints, and the full IDE
  surface (lint/hover/completion/goto). Theme chrome lives in
  `@here.build/editor-theme` (commons).
- `arrival-ext-toml` / `arrival-ext-yaml` — opt-in EnvCapability packs that
  own the TOML/YAML parser dependencies (the extension mechanism's own
  examples of "package owns the dep").
- `arrival-env-capability-handlebars` — opt-in Handlebars pack (`.hbs`
  import-executable + template verbs); reference capability for mercury.
- `arrival-env-capability-sql` / `arrival-env-capability-http` — opt-in
  `(sql/query)` / `(http/get|post)` effect packs (host-bound resolvers;
  inert by default).

## Status

Early, moving fast, published as a dialogue invitation: read it, challenge
it, open issues. The API surface is still settling; we are not yet optimizing
for external PRs.

## License

Dual-licensed by package (see root [`LICENSE.md`](./LICENSE.md)):

- **MIT** — language core (`arrival`), CLI, sugarcoat, serializer, LSP, codemirror,
  env-capability packs, toml/yaml extensions, types-prelude, overridable-lens
- **FSL-1.1-MIT** — MCP stack (`arrival-mcp`, `arrival-mcp-do`, `mcp-substrate`,
  `mcp-typescript-lsp`), provenance, mercury compiler + oracle

Each package's `LICENSE.md` and `package.json` `"license"` field are authoritative.
