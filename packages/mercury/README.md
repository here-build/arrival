# @inhuman.tools/mercury — **DEPRECATED**

> **Do not add features here.** This package is a **legacy predecessor** of the
> arrival Mercury *instance* and is being **dissolved into the inhuman CLI**.

## What went wrong (honest)

`@inhuman.tools/mercury` tried to be “compilation for humans” as a **string-concat
pass pipeline** (desugar → lower → eslint/prettier). The [Mercury
paradigm](../../../../docs/foundations/mercury/mercury-as-paradigm.md) is
different: a **semantic model answers decisions**, then a dumb materializer
prints via `ts.factory`. That instance lives at **`@inhuman.tools/arrival-mercury`**
(`SchemeSemanticModel` + Residual + render).

| | This package (legacy) | Arrival Mercury instance |
|--|----------------------|---------------------------|
| Role | Pass pipeline / glass experiments | Sole scheme→TS compiler |
| Middle-end | scattered analyses in lower | **`SchemeSemanticModel`** |
| Emit | string templates | Residual → `ts.factory` |
| Product client | was `inhuman compile` | **`inhuman build` / `inhuman compile`** → `buildProject` |

## Where to go

- **Compiler / model / oracle / build:** `@inhuman.tools/arrival-mercury`
- **CLI (disk I/O, flags):** `@inhuman.tools/inhuman` (`inhuman build`, `inhuman compile`)
- **Paradigm definition:** `docs/foundations/mercury/mercury-as-paradigm.md`

Package removal is the end of this migration. Until then, treat every export as
unstable and non-authoritative for product emit.

## License

[FSL-1.1-MIT](./LICENSE.md) — Functional Source License 1.1, MIT Future License.
