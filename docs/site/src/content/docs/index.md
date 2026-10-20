---
title: Arrival
description: A sandboxed R7RS-subset Scheme for agents that need to compute, not just call tools.
template: splash
editUrl: https://github.com/here-build/arrival/edit/main/docs/site/src/content/docs/index.md
hero:
  tagline: A sandboxed Scheme for agents that need to compute, not just call tools.
  actions:
    - text: Learn Sugarcoat
      link: /arrival/language/sugarcoat/
      icon: right-arrow
    - text: Interpreter docs
      link: /arrival/internals/
      variant: minimal
---

Arrival executes a program as values and, when asked, as provenance over those values. The agent writes the program. The host supplies capabilities, data, and limits. The language is an R7RS subset without `set!` or `call/cc`. Sugarcoat is a reversible surface over that Scheme.

Embedding tutorials are still being written against checked examples. The pages below are the living documents, rendered from the files that own them.

## Read

- [Learn Sugarcoat](/arrival/language/sugarcoat/) and the [formal grammar](/arrival/language/sugarcoat-grammar/)
- [Language inventory](/arrival/agents/language/) and the [agent card](/arrival/agents/card/)
- [Writing capabilities](/arrival/capabilities/authoring/)
- [R7RS coverage](/arrival/reference/r7rs/), [SRFI coverage](/arrival/reference/srfi/), and the [symbol index](/arrival/reference/symbols/)
- [Packages](/arrival/packages/arrival/)
- [Interpreter docs](/arrival/internals/) — principles, rulings, the run model, provenance
