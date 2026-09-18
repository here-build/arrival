# @inhuman.tools/arrival-types-bridge

Scheme → virtual TypeScript for the type lens: `emitTypes`, lossless ident serde
(`encodeSchemeIdent` / `schemeifyTsText`), and the parse/desugar/scope front
those run on.

Arrival-lsp and arrival-codemirror consume this package. Mercury (out of this
repository) re-exports the same emitter.

## Install

```bash
pnpm add @inhuman.tools/arrival-types-bridge
```

```typescript
import { emitTypes, schemeifyTsText } from "@inhuman.tools/arrival-types-bridge";

const { ts, mappings } = emitTypes(`(define (f x) (string-append x "!"))`);
schemeifyTsText("string$dash$append"); // "string-append"
```

## Subpaths

| Export    | For                                                                |
| --------- | ------------------------------------------------------------------ |
| `.`       | `emitTypes`, `schemeifyTsText`, ident serde                        |
| `./front` | parse / desugar / scope (`parseSexprs`, `desugar`, `resolveNames`) |
| `./names` | `cleanName`, `nameCandidates`, `RESERVED`                          |

## License

[MIT](./LICENSE.md)
