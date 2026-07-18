# arrival

An R7RS-subset Scheme built for AI-agent constraint-based execution —
transparent provenance, capability-safe environments, and tooling that treats
an agent as a first-class programmer.

The name is Ted Chiang's. In *Story of Your Life*, heptapod B is a language
whose sentences hold all their readings at once. Arrival programs are built
the same way: one semantic object, many simultaneous readings — the
interpreter runs it, the provenance plane explains it, the type lens checks
it, the compiler emits it as human-grade TypeScript. None of the readings is
privileged; all of them are the program.

## Why a Scheme, why for agents

Agents are good at intent and bad at materialization. Arrival is the
intent-side language: immutable, no dynamics (`set!` and `call/cc` are
structurally rejected), every effect crossing a declared capability membrane.
Wrong states are impossible by construction, which is what makes the rest
affordable — permanent narrowing proofs, non-exponential provenance, eager
whole-program optimization, and errors that teach instead of ban.

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

The wider toolchain — run engine, type lens, mercury compiler, effect
membrane — lives in
[inhuman-foundation](https://github.com/here-build/inhuman-foundation).
LLM inference is deliberately **not** part of this repo: it is an environment
capability pack built on arrival's extension mechanism, consumed by the
inhuman CLI — the same mechanism `arrival-effects` demonstrates in the open.

## Repository shape

A standalone pnpm/turbo workspace, and simultaneously an embedded directory
of the here.build product monorepo (where day-to-day development happens).
History is real development history — commits, dates, and messages as they
happened, including the AI-collaboration co-author trailers: this language is
built in extended collaboration with Claude, and that is part of the story.

## Status

Early, moving fast, published as a dialogue invitation: read it, challenge
it, open issues. The API surface is still settling; we are not yet optimizing
for external PRs.

## License

[Functional Source License, Version 1.1, MIT Future License](./LICENSE.md).
