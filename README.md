# Arrival

**The first ever language built for AI[^1], finally built for AI.**


[^1]: Lisp was born in 1958 for AI research — the first language built *for* AI. arrival is a
    Lisp dialect finally built for AI *as the user*: the agent writes the programs. ![Elegant weapons,
    for a more civilized age.](https://imgs.xkcd.com/comics/lisp_cycles.png)

Arrival is a symbolic stack built around LLMs needs.
It is not first attempt to create "special language for AI",
and is not even a special language designed for AI.

It is the behavior of language that matters.

[Code Mode](https://blog.cloudflare.com/code-mode/) by Cloudflare proves the point:
give agent the environment, and it will do everything it needs.

[Toon](https://github.com/toon-format/toon) proves the second side:
any format is good enough, as long as it's readable.

Arrival, as a stack, is organic next move, consolidating all the prior art.

## The language

Agents are good at intent and bad at materialization.
Arrival compensates that - Scheme was taken intentionally for multiple reasons.
It is faithful R7RS sandbox without dynamics and mutability (`set!` and `call/cc` eliminated),
and taking that away gives ability to make the strong predictions about output executed.

Agents are not that good at writing Scheme, but they are good at writing Lisp in general.
Cumulative dataset of dialects is large enough to teach agents;
problem is, it's not Scheme or other dialect agents really know,
but rather DeepDream output with brackets instead of dogs.

So, it comes with a cost - the syntax was extended to support well-known features from Clojure, Racket and Common Lisp;
Nothing that violates R7RS was done - only the spec-undefined behavior was adjusted.
The attempts to violate the spec, however, are not ignored - grammar errors are classified to identify
what exact expression LLM tried to write, and explains how to do it right.

## The stack

Everything else comes on top of it, in variety of shapes.

Arrival MCP is a framework on top of Model Context Protocol,
allowing to build the MCP servers that run the sandboxed code with predefined capabilities.

Arrival Manifold is proxy that wraps other MCP tools into the integrated execution environment, seamlessly.

Arrival Serializer is producing s-expressions as an output, producing more compact results.




## Packages

- `arrival` — the interpreter, environment/capability system, and stdlib.
  Environments compose from capability packs (C3-linearized); symbols carry
  declared contracts (provenance role, cache class, emission knowledge) that
  every tool downstream reads.
- `arrival-cli` — `arrival run file.scm`, the REPL, and static checking.
- `arrival-sugarcoat` — the syntax lens: classic ↔ sugarcoat rendering
  (indentation I-expressions, curly-infix, accessors).
- `arrival-serializer` / (protocol types live in `@here.build/arrival-env`) —
  JS ↔ S-expression wire.
- `arrival-provenance` — the trace-capture substrate and provenance surface.
- `arrival-mcp` — Model Context Protocol tools as values (discovery + action
  tiers); `arrival-mcp-do` — the Durable Object session shell;
  `mcp-substrate` — the doors system: error enrichment, session replay,
  futility detection. Rejections teach and route; they do not ban.
- `mcp-typescript-lsp` — TypeScript code-intelligence MCP tool (hover,
  definition, references, impact analysis, …) as an arrival-mcp `McpTool`,
  with s-expression results for agent reasoning.
- `mercury` — the Mercury compiler: an arrival-chain program projected into
  human-grade TypeScript, designed around the reader's mental model rather
  than mechanically lowered.
- `arrival-lsp` — the Scheme→TS type lens: arrival programs bite under
  `tsc`, and diagnostics lift back to their `.scm` spans.
- `arrival-mercury` — the differential-oracle harness: interpreter vs
  compiled output, compared as black-box source-in/value-out outcomes.
- `arrival-codemirror` — CodeMirror 6 for arrival Scheme (classic +
  sugarcoat): structural editing, ghost text, param hints, and the full IDE
  surface (lint/hover/completion/goto).
- `editor-theme` — the redistributable editor theme: self-hosted fonts
  (OFL) and the H-K-compensated Darcula syntax theme for CodeMirror. No CDN.
- `arrival-manifold` — collapse N MCP servers into one discovery-shaped
  tool: a scheme `expr` surface over every bound remote tool.
- `arrival-ext-toml` / `arrival-ext-yaml` — opt-in EnvCapability packs that
  own the TOML/YAML parser dependencies (the extension mechanism's own
  examples of "package owns the dep").

## Status

Early, moving fast, published as a dialogue invitation: read it, challenge
it, open issues. The API surface is still settling; we are not yet optimizing
for external PRs.

## License

[Functional Source License, Version 1.1, MIT Future License](./LICENSE.md).
