# `require`/`load` — two verbs, loaders typed by real inference

**Date:** 2026-06-25
**Status:** design, agreed — implement after the small rework: **de-brand the type dialect to plain TS** (§12), then settle the in-flight engine/ext work (§11).
**Supersedes:** the registration + typing parts of `require-as-capability-and-prompt-support-2026-06-15.md` (its §3/§5/§7). That doc's *separation discipline* and `define-library`/`load` framing stand; what changes is (a) `register-extension` carries a `transformFn`, not a scheme-symbol resolver, and (b) editor types come from tsserver inference over virtual modules, not a hand-rolled `RequireTypeProvider`.

---

## 1. Thesis

Collapse the loader story to **one axis (get vs enrich), two verbs**, and get editor types from **tsserver inferring real virtual modules** instead of any hand-written type code. Loaders, the lens, and `define-library` all hang off that single decision.

---

## 2. The model — two verbs

- **`load`** = **enrich**. Spills a file's `define`s into the **current lexical scope** — top-level → module scope; inside a closure (body start) → local `letrec*`, exactly like an internal `define`. Control comes from the *file*: a bare `.scm` spills all its defines; a `define-library` spills only its exports. A statement, no value.
- **`require`** = **get**. Returns a value — an expression, usable anywhere. Data files, opaque modules, and `define-library` modules (their exports as a typed record).

**The invariant that earns the split:** every registered extension is `require`-only. A file-type loader can hand you a value to bind; it *cannot* inject a name into scope. Scope pollution via an extension is not guarded against — it is **unrepresentable**. `load` (a builtin, not an extension) is the sole spill.

**Lexical-scope fix.** Today `defineRequireRosetta` closes over the run env, so a `(require)` buried in a lambda spills *globally regardless of position* — a local-looking statement with a hoisted global effect. `load` fixes this: enrich follows `define`'s lexical scoping (a `(load)` at a closure's body-start is local to that closure). Enrich is just bulk-`define`; it inherits `define`'s scoping.

---

## 3. Worked example

```
config.yaml →  title: Hi
               count: 3

(define cfg (require "config.yaml"))
   runtime → cfg = { title: "Hi", count: 3 }
   editor  → virtual config.yaml.ts:  export default { title: "Hi", count: 3 } as const
             (require) rewrites to:    import cfg from "config.yaml"   ⟹ tsserver types cfg
```

---

## 4. Extensions — three kinds, one capability each

```
(require/register-extension ".ext"
    (require/loader/json   transform : str => ExtendedJSON)               ; data
  | (require/loader/scheme transform : str => string | ArrivalAST)        ; compiles to scheme
  | (require/loader/opaque compile : str => Rosetta, types : str => str)) ; arbitrary value + its type
```

- **One `transformFn` serves both faces.** Runtime runs it to produce the value; the lens runs it to build the virtual module. The resolver/type drift the old paired handler guarded against is gone *by construction* — there is only one function.
- **`json`** — the transform yields *extended JSON* (JSON plus `Date`/`bigint`/`Infinity`); guard the plain case with `JsonType` (type-fest), allow the extended types through a real literal emitter (§6).
- **`scheme`** — the transform yields scheme source (or, aspirationally, an `ArrivalAST` — we have no full AST yet, keep it in mind). Fed through the existing scheme→TS pipeline.
- **`opaque`** — arbitrary `RosettaCompatible` value via `compile`, with an explicit `types(source) => string` for the editor (the escape hatch for non-data, non-scheme file-types, e.g. a sealed `.prompt` proc).
- **`compile` is pure + eager (V's call, 2026-06-25).** No transform is resource-armed: `.prompt`'s compile parses the template into a proc, and the *proc* reaches the infer resource at **call** time through the eval context (the normal verb mechanism) — never at compile time. So the by-name resolver table + late-binding + cross-run leak-risk all **dissolve**: the registry is `ext → { kind, transform }` holding pure fns the runtime *and* lens both run. Eager compilation is fine at our scale (small programs). This kills `loader-extensions.ts`'s `RESOLVERS`/`lookupExtensionResolver` by-name indirection.
- **`register-extension` is prelude-only** — bound only while capability preludes evaluate, then sealed. A running program structurally cannot teach the loader new file-types (a resolver is a capability grant, not user data). Another wrong-state-impossible. Registration is idempotent (same ext+fn = no-op; conflicting = error).
- Each file-type is its **own small capability** (`ext/json`, `ext/yaml`, …) composed into the capability array — granular, not one bulk. `.scm` is the builtin, not a registered ext.

---

## 5. Typing — the mercury move

Each required file becomes a **virtual `.ts` module**; **tsserver does the typing** (no hand-rolled type synthesis):

- `json` → `export default <extended-json literal> as const` → tsserver infers the shape.
- `scheme` → through the existing scheme→TS pipeline.
- `opaque` → `export default` stamped with `types(source)`.

…and the require/load → import rewrite at the lens level:

- `(define x (require "f"))` → `import x from "f"`
- ad-hoc nested `(require "f")` → `(await import("f")).default` (async hoisted at the typed level)
- `(load "lib.scm")` → inline the lib's defines (spill); a `define-library` → inline its exports.

**This deletes `valueToTsType` + `resolveRequireType` + the entire `RequireTypeProvider` seam** — the hand-rolled value→type-string synthesizer with its depth/breadth caps and SStr dialect. The editor type-seam we were stuck on does not get *fixed*; it ceases to exist.

**Edit-time guards** (these run in the IDE, per keystroke, over half-typed source):
- `transformFn`s must be pure, fast, and throw-safe — broken mid-edit source degrades to `any`/skip, never crashes Volar.
- size-cap huge data files (a 2 MB `.ndjson` → a 2 MB `as const` literal will choke tsserver) → degrade to a loose type past a threshold (the old `valueToTsType` capped depth/breadth for exactly this).

---

## 6. Extended-JSON literal emitter

`json` loaders need a serializer that emits a *valid TS literal*, not `JSON.stringify`: `Date` → `new Date("…")`, `bigint` → `123n`, `Infinity`/`-Infinity`/`NaN` → the identifiers. `as const` over the result must still produce the right inferred type (`new Date(…) as const` → `Date`, etc.).

---

## 7. `define-library` — scheme modules become typed values

`(export …)` promotes a scheme file from spillable-script → a typed, require-able module. **`require` always gets a value** — data's value is the data; a module's value is its exports, as a typed record. The export list *is* the get-interface, and it is exactly what the lens emits (`export const add: … `), so the require types from the exports via the same scheme→TS lens.

The file × verb matrix:

| | `load` (enrich/spill) | `require` (get/value) |
|---|---|---|
| bare `.scm` (top-level defines) | spills **all** defines (lens inlines) | error — no export interface |
| `define-library` (explicit exports) | spills **the exports** (controlled) | exports as a typed value record |
| `.json` / `.hbs` / opaque ext | error — not code to spill | the value (lens-typed) |

**Conscious divergence from R7RS:** `(require "math.scm")` *gets a namespace value* — `(@ math "add")` — it does not import names into scope. R7RS `import` enriches; we made `require`=get, so a module-require returns a record, and if you want the exports *in scope* you `load`. No `:as`/`:refer`/rename sugar — one bound value is the only path (the no-Clojure-style choice).

---

## 8. Capability layout

- **`arrival/require`** (core capability): the `Loader` as config (IO + the path-jail only — the resolver *table* moves off the Loader onto the global late-bound `ext → transformFn` registry); the `require` + `load` verbs; `register-extension` (prelude-only). No `compileInferUnit` config, no `RuntimeAssembler` for file-types, no raw `loader-core` pack.
- **`ext/*`** capabilities, one per file-type: `ext/json`, `ext/ndjson`, `ext/txt`, `ext/yaml` (owns `yaml`), `ext/toml` (owns `smol-toml`), `ext/handlebars`, `ext/prompt` (resource-armed via env-infer). Each `{ symbols: <transformFn>, prelude: (require/register-extension ".x" …) }`. This keeps the external parser deps (`yaml`/`smol-toml`/`handlebars`) out of the loader package (env-quasi-packages rule).
- **`.scm`** = builtin (load + recursive require). Never a registered extension.

---

## 9. Why it's bi-, not tri- (the R7RS framing)

R7RS `load` and `import` are **both enrich** (neither returns a value), split on **static vs dynamic**: `import` = static, by library *name*, declared *exports only*, controlled, compile-time; `load` = dynamic, by file *path*, whole-file, a runtime proc. **R7RS has no `get`** — it never imports data.

`require` is a third *name* only because it is `get`, an axis R7RS lacks (we load data → we need a value). We don't copy R7RS's two enrich verbs:
- controlled vs uncontrolled → derived from the **file** (`define-library`'s exports), not a verb.
- static vs dynamic → derived from the **path** (literal → statically typed; computed → loose `import()`), not a verb.

So R7RS `import` ≈ our `load` of a `define-library`; R7RS `load` ≈ our `load` of a bare file; `require` (get) is the thing R7RS lacks. The existing curated `import` (fs-free host registry) is **`require` with a registry backend** — it folds into `require`; keep it a separate verb only if you want a distinct *capability grant* (curated-without-fs), which is a privilege knob, not a concept.

---

## 10. What this kills

- the `valueToTsType` / `RequireTypeProvider` / `resolveRequireType` hand-rolled type machinery → real inference.
- the two-function resolver/type drift hazard → one `transformFn`.
- the "three verbs" confusion → curated `import` folds into `require`; R7RS's two enrich verbs fold into `load` + file-derived control.
- the global-spill-regardless-of-position wart → lexical define-scoping.

---

## 11. Plan & current state

**Committed:** arrival-chain → `second-foundation/` · `makeFsLoader` · the `@here.build/arrival-scheme-env-loader` extraction.

**The small rework (prerequisite):**
- **✅ Inline the scalar dialect → plain TS (§12)** — DONE (`c9ae163619`). Verified the dialect was *already* plain aliases (no brand). Inlined `SStr`/`SNum`/`SBool`/`Unit` → `string`/`number`/`boolean`/`void` across the type-lens leaves + `.cases.ts`; kept `List`/`Pair`/`Nil`/`Dict` structural; kept the alias DEFS as the rosetta-string + synthesizer compat bridge. Consumer inline (inhuman/sift, env-infer, examples) IN PROGRESS via a background agent. Residue to delete once that lands: the loader synthesizer's emission (below) + the type-lens defs.
- **Settle the in-flight work:** commit the engine extraction (`runProgram`, Plexus-free; `Project.run` delegates — green, orthogonal). **Revert** the in-flight `ext/*` capabilities (scheme-symbol resolvers + the type-seam patch + the `.yaml` red test): step 1 rebuilds them on the `transformFn` shape and step 2 deletes the type-seam, so they are redone, not extended — the surviving ideas (granular per-type, parsers out of the loader package) are captured above.

**Build, in order:**
1. `register-extension`'s three-kind shape + runtime `get` + the `load`/`require` split + lexical-scoped spill.
2. the Volar virtual-module pipeline + require→import/import() rewrite (this is what removes the type seam).
3. `define-library` (the typed scheme-module layer, reusing the same require-get path with exports as the value).
4. migrate `(require "*.scm")` → `(load "*.scm")` across arrival-chain's scheme tests + inhuman's example/saas scheme programs (TS packages untouched).

---

## 12. Type casing — already plain TS (the membrane made branding unnecessary) — RESOLVED

The scheme-type "dialect" is **already plain** — no brands. `prelude/types.d.ts` defines `type SStr = string`, `type SNum = number`, `type SBool = boolean`, `type List<T> = readonly T[]`, `Dict<…>` → a precise object, `Unit = void`. The LIPS↔JS membrane is *why*: a boundary value **is** its plain JS type, so the aliases are just *named vocabulary*, structurally identical to the primitives.

**Consequence: there is no misalignment and no cast.** A JSON-alike module imports with `export default … as const`; tsserver infers a plain type (`{title:"Hi";count:3}`) and the accessors (`@`, `car`, …) — typed against `SStr`=`string` / `List`=`readonly[]` / `Dict`=object — consume it directly. (The earlier "SStr open piece" was a phantom — branding was assumed that isn't there.)

**So the Volar simplification is just:** emit `export default … as const` and let tsserver infer; **drop the `valueToTsType` dialect-synthesizer** (§5). Nothing in the accessor vocabulary needs to change for imports to be cast-free.

**The one real trade:** the aliases are deliberately kept so a *deferred SNum numeric tower* can re-point one alias (`SNum` → an Exact/Inexact algebra) and upgrade every leaf for free — the prelude says "always write `SNum`, never `number`." Using plain `number` everywhere abandons that seam for present simplicity. So the choice is: **(a)** inline the vocabulary (`SStr`→`string`, `SNum`→`number`, …) across the ~34 leaf `.d.ts` + `.cases.ts` — mechanical, broad-but-shallow, and it gives up the numeric-tower seam — or **(b)** leave the (already-plain, harmless) aliases and just have the lens emit plain `as const` for imports. (b) is zero-churn and keeps the tower door open; (a) is the full simplification.

**Still pin — imported sequences:** an imported JSON array should cross as a **vector** (a real `readonly` array — indexable, `.length`), not a cons/`Pair` list, so `readonly T[]` is *true*. Today `jsToScheme` maps JS arrays → scheme lists; required data wants vectors. (Pure in-program `Pair`-lists remain their own concern, typed via list ops, not indexing.)

---

## 13. References

- Prior audit: `require-as-capability-and-prompt-support-2026-06-15.md` (this supersedes its §3/§5/§7 registration + typing).
- Lisp-family loader survey (the design space behind §9): `load`→idempotence→namespaces→exports→phasing arc; R7RS `define-library`/`import`/`load`; the *phasing* rung (macros-across-files) is a known future wall our single-phase eager `load` handles for now.
- env-quasi-packages rule (`.claude/rules/env-quasi-packages.md`) — why each external-dep loader is its own capability.
