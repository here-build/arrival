# `@inhuman.tools/arrival-env-capability-handlebars`

Reference **opt-in EnvCapability** package: owns the `handlebars` dependency and
teaches arrival two things.

## Import faces (only two exist)

| Face | This package |
|------|----------------|
| **import dict** | — (not data) |
| **import executable** | `.hbs` → scheme pretreat → lambda over `template/handlebars` |

There is no special `.hbs` import path. Pure convert:

```ts
import { hbsContentsToSchemeSource } from "@inhuman.tools/arrival-env-capability-handlebars";
hbsContentsToSchemeSource("Hi {{name}}");
// => (lambda (arg . rest) (template/handlebars "Hi {{name}}" (cons arg rest)))
```

Loader: `kind: "eval"` of those forms.  
Mercury: same pretreat, then `compileScmModule`.

## Runtime emit (mercury)

`Contract.emit` on the verbs lowers to `RuntimeRef`. Mercury’s
`RUNTIME_MANIFEST` maps those symbols to this package’s **`/runtime`** subpath
(no stage0 shim of handlebars itself):

```ts
import { templateHandlebars } from "@inhuman.tools/arrival-env-capability-handlebars/runtime";
```

## Capability

```ts
import { arrivalHandlebarsCapability } from "@inhuman.tools/arrival-env-capability-handlebars";
// root in assembly (or via arrival-run packs as arrivalUtilsCapability re-export)
```

Symbols: `template/handlebars`, `handlebars/parse`, `handlebars/run`,
`ext/handlebars/resolve` + prelude `(require/register-extension ".hbs" …)`.

Compat: `@inhuman.tools/llm-plane-arrival-env` re-exports this as
`arrivalUtilsCapability`.
