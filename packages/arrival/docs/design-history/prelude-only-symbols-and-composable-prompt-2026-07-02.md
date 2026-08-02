# `preludeOnly:` on `symbol.*`, and a composable `.prompt` resolver

Design pass only — no code changed. Two coupled changes to the arrival Scheme system:

1. A declarative `preludeOnly:` flag on `symbol.native` / `symbol.rosetta`, generalizing the
   manual `sealRegisterExtension` pattern.
2. Splitting the monolithic `.prompt` resolver (`prompt/run`) into a pure `dotprompt/render` +
   an effectful `infer/run`, per V's sketch `(lambda args (infer/run (dotprompt/render <src> args)))`.

Both were read against the **live WIP state** as of this pass: `foundations/arrival/llm-plane-arrival-env/src/prompt.ts`
and `utils.ts` are new, untracked files that already re-home `.prompt`/`.hbs` off `arrival-chain`
into a monolithic `prompt/run` native verb (fixing the membrane-voiding bug the old
`second-foundation/arrival-chain/src/packs/ext-prompt.ts` had — see §2.0). `second-foundation/arrival-chain/src/packs/index.ts`
and `loader-core.ts` are mid-flight and may still reference the old local `ext-prompt.ts`/`ext-handlebars.ts`
depending on when this is read — that churn doesn't change the design below, only which file the
target code lands in.

---

## 1. `preludeOnly:` on `symbol.native` / `symbol.rosetta`

> **Model correction (this rework).** An earlier draft modeled `preludeOnly` as *bind-into-the-runtime-env,
> then seal after bootstrap* (a throwing stub). That is wrong. **The correct model, per V:** the prelude is
> evaluated as a **separate phase against an EXTENDED scope** — the runtime env PLUS the `preludeOnly`
> symbols layered on, "as if the prelude ran with extra imports." A `preludeOnly` symbol lives **only** in
> that prelude-evaluation scope; it is **never** bound into the runtime env. So there is **nothing to seal**:
> a running program that names a `preludeOnly` symbol just gets the ordinary unbound-variable error
> (`Environment.get`, `foundations/arrival/arrival/src/Environment.ts:226-229`), because the name genuinely
> isn't in its scope. This dissolves the "gap" the earlier draft flagged — `require/register-extension`
> becomes the mechanism's **first consumer**, not an out-of-scope special case (§1.4).

### 1.1 The existing precedent (what this replaces)

`foundations/arrival/arrival-scheme-env-loader/src/loader-extensions.ts` (`defineRegisterExtensionRosetta` +
`sealRegisterExtension`, lines 87–116) is the *manual, imperative* version of exactly this idea, done the
bind-then-stub way the new model retires. Today, in `second-foundation/arrival-chain/src/run-program.ts`:

```ts
// run-program.ts:52,57,69-70
const base = sandboxedEnv.inherit(opts.name);   // the RUNTIME env packs apply onto
...
defineRegisterExtensionRosetta(base);           // bind register-extension INTO the runtime env
...
const { env } = await assembleEnv<typeof base>(base, packs);  // C3 loop; every prelude may call it
sealRegisterExtension(env);                      // then OVERWRITE it with a throwing stub
```

`register-extension` is bound onto the runtime env, every capability's `prelude` may call it while
`assembleEnv`'s C3 loop applies each pack (`kernel.ts:206-220`), and only *after* the whole assembly
finishes does the host overwrite it with a throwing stub. Under the corrected model this becomes: bind
register-extension into the **shared prelude-overlay scope** (never the runtime env), and **delete the seal
call** — the overlay is discarded when assembly ends, so the name is simply gone at runtime. It's a
**shared, cross-capability** bootstrap verb (any capability's prelude may call it), which is precisely why
the overlay must be **shared and accumulated across the whole assembly** — the crux worked out in §1.3.

### 1.2 Where `preludeOnly` lives on the symbol (unchanged from the first draft — this part was right)

Both `symbol.native` and `symbol.rosetta` take a `Contract<I, O>` as their first call argument
(`foundations/arrival/arrival/src/common/symbols/native.ts:13-19`, `rosetta.ts:16-23`). `Contract` already
carries two kind-scoped opt-in flags with the same "declare here, `bake*` reads it" shape:

```ts
// foundations/arrival/arrival/src/common/symbols/_bake.ts:91-105
export interface Contract<I extends VectorSpec, O extends VectorSpec> {
  input: I;
  output: O;
  readonly pure?: boolean;     // ROSETTA-ONLY
  readonly fanout?: boolean;   // NATIVE/SEQUENCE
}
```

Add a third, kind-agnostic flag next to them:

```ts
readonly preludeOnly?: boolean;
```

`true` marks the symbol as prelude-scope-only. (Unlike the earlier draft, there is **no teaching-reason
string** — a `preludeOnly` symbol never surfaces a bespoke error; a runtime reference just misses, so there
is no message to author. Keep it a plain boolean.)

**No signature change to `native()`/`rosetta()` is needed** — `preludeOnly` rides the same `contract`
object callers already pass. `bakeNative`/`bakeRosetta` (`_bake.ts:445-460`, `462-580`) copy it onto the
baked def:

```ts
// NativeSymbolDef / RosettaSymbolDef gain:
readonly preludeOnly?: boolean;
```

`TaglessSymbolDef` / `SequenceSymbolDef` / `DoorSymbolDef` / `KeywordSymbolDef` / `MacroSymbolDef` are
untouched — the task scopes this to native/rosetta, and those other kinds don't take a `Contract` to hang
it on anyway.

### 1.3 The assembly-side mechanism — the shared, accumulating prelude overlay

**Two facts from reading the pipeline that constrain the whole design:**

1. **`define` in a prelude lands in the eval env directly.** `evalDefine` calls
   `ctxResolver(ctx).define(name, value)` → `Resolver.define` → `this.env.set(name, value)` on the *innermost*
   frame (`evaluator.ts:1368`, `eval/Resolver.ts:233-235`). So whatever env the prelude is `exec`'d against
   is where its top-level `define`s land.
2. **Base-pack preludes define runtime-visible bindings.** `scheme/core`'s prelude defines `true`/`false`
   and the `define-syntax` macro (`env/core/core.ts:24+`); `srfi-1`'s prelude defines `take-while`/`drop`/`span`
   (`env/srfi/srfi-1.ts:76+`). These MUST be visible at runtime. So **a prelude's `define`s must reach the
   runtime env R** — a naïve "eval the prelude in a child scope" would trap them in the child and lose them.

The extended prelude scope must therefore satisfy **both**: `(define …)` targets R (visible at runtime),
AND the `preludeOnly` symbols are visible for *lookup* but never bound into R. In arrival's parent-linked
`Environment` model (`Environment.ts:180-195`, lookup = own bindings → resolvers → parent), the only shape
that does both is to make the `preludeOnly` symbols a **parent** of R during the prelude phase, then drop
that parent:

```
build:   sandboxBase ← preludeOverlay ← R(runtime)          during assembly
run:     sandboxBase ← R(runtime)                            after assembly (overlay discarded)
```

- `preludeOverlay = sandboxBase.inherit("prelude-overlay")` — ONE overlay per assembly, child of the sandbox
  base (so it still sees SAFE_BUILTINS), initially empty.
- `R` (the runtime env) is parented on `preludeOverlay` **for the duration of assembly**. `define`s in any
  prelude land in R (fact 1); lookups miss R → hit `preludeOverlay` (the `preludeOnly` symbols) → `sandboxBase`.
- **The overlay is SHARED and ACCUMULATES.** As `assembleEnv`'s C3 loop applies each pack, that pack's
  `preludeOnly` symbols are `set` onto `preludeOverlay` (not R); its ordinary symbols go onto R as today.
  A pack applied earlier therefore contributes its `preludeOnly` symbols to the overlay that a *later*
  pack's prelude evaluates against — one shared accumulating scope, exactly what a cross-capability verb
  like `register-extension` needs.
- **After the loop, re-parent R back onto `sandboxBase` and discard `preludeOverlay`.** Nothing is sealed,
  nothing is deleted per-symbol — a whole scope simply falls out of the chain and is GC'd. This is the
  "nothing to seal" the corrected model wants. (Re-parenting R here is safe because R is not yet live —
  `assembleEnv` hasn't returned it to the program. Equivalent alternative: leave the overlay in the chain
  and clear its `__env__` — one step either way; re-parent-and-drop leaves no residual frame.)

**Ordering.** `register-extension` is seeded onto `preludeOverlay` **before** the C3 loop starts (the direct
move of today's `defineRegisterExtensionRosetta(base)` → `defineRegisterExtensionRosetta(preludeOverlay)`),
so every pack's prelude sees it with no dep edge required. A `preludeOnly` symbol *contributed by a
capability* that a **later** capability's prelude consumes obeys the ordinary C3 dep rule: `assembleEnv`
applies least-precedence-first (`kernel.ts:209`, `order.toReversed()` — deps before dependents), so the
consumer must `dep` on the contributor, exactly as for any runtime symbol. No new ordering machinery.

**Where the overlay is constructed + threaded.** `assembleEnv` (`kernel.ts:206-220`) is the natural owner,
since it already builds the per-assembly `PackContext` via `makeCtx` (`kernel.ts:186-199`). Two seam edits:

- `assembleEnv` creates `preludeOverlay`, temporarily re-parents `base` onto it, and exposes it to each
  pack. The cleanest thread is a new optional field on `PackContext` (`kernel.ts:27-32`):
  `readonly preludeScope?: SchemeEnv` — the scope a pack routes its `preludeOnly` symbols onto. After the
  loop, `assembleEnv` restores `base`'s parent and drops the overlay.
- `EnvCapability.lower(...).apply` (`capability.ts:205-297`) reads `ctx.preludeScope`. Its symbol-binding
  loop (the `switch (def.kind)` at `capability.ts:212-266`) gains one guard: **if `isBakedDef(def)` and
  `def.preludeOnly` and `ctx.preludeScope` exists, bind the symbol onto `ctx.preludeScope` instead of `env`
  — using the SAME bind form** (native → `set(verb, def.impl)`; rosetta → `set(verb, gatedRun)`), just a
  different target scope. So a `preludeOnly` rosetta is a fully-functional callable *in the prelude scope*,
  byte-identical to how it would bind at runtime — only its visibility differs. The prelude itself still
  evals with `env = R` via the existing `opts.evalScheme(env, spec.prelude)` (`capability.ts:295`),
  unchanged — the overlay is just R's transient parent, so the eval sees it for free.
- `kernel.ts` stays `EnvPack<E>`-generic: `preludeScope` is typed `SchemeEnv | undefined` and only the
  `SchemeEnv`-typed `capability.ts` layer reads it; a non-scheme `EnvPack` consumer (none exist yet) simply
  ignores the field. No `set`-shaped API is baked into the generic core.

### 1.4 `require/register-extension` as the first consumer (the "gap" dissolves)

Under the corrected model there is **no cross-capability gap**. `register-extension` is exactly the shared
prelude-overlay symbol the mechanism exists for:

- **Migration (minimal):** in `run-program.ts`, change `defineRegisterExtensionRosetta(base)` (line 57) to
  seed the overlay instead — either the assembler seeds it directly onto `preludeOverlay`, or
  `buildArrivalEnv` passes it in. **Delete `sealRegisterExtension(env)` (line 70)** and the
  `sealRegisterExtension` export itself (`loader-extensions.ts:107-116`) — there is nothing to seal. The
  overlay carrying `register-extension` is discarded at the end of `assembleEnv`, so the running program
  never has the name; `(require/register-extension …)` from user code is a plain unbound-variable error,
  strictly cleaner than today's bespoke throwing stub.
- **Imperative seed vs. declarative flag.** `register-extension` is currently a hand-written `defineRosetta`
  (`loader-extensions.ts:90-104`), not a `symbol.*` def, and it needs no owning capability, so the minimal
  migration keeps it an **assembler-seeded** overlay symbol (the one-line bind-target move above). The
  fully-declarative alternative — re-expressing it as `symbol.rosetta` with `preludeOnly: true` on a root
  pack that every `ext/*` capability deps on — is more uniform but drags in a new `symbol.*` def, an owning
  pack, and a dep edge from `.hbs`/`.prompt`/future `ext/*`. Recommend the imperative seed now; the
  declarative form is a clean follow-up once a *second* `preludeOnly` symbol appears and the pattern earns
  the generalization. Either way `register-extension` is the consumer that proves the mechanism.

**Mid-run application (`createRuntimeAssembler.require`, `kernel.ts:243-283`).** A pack applied *mid-run* via
`(require/extension :name)` (the P4 path, `require-extension.ts`) also has a prelude that may call
`register-extension`. Here the runtime env is **live and concurrently evaluating** the user program, so the
assembly-time trick of re-parenting R is **unsafe** (it would corrupt concurrent lookups — the shared-tree
hazard). The design for this path, and its one honest limitation:

- Per `require()`, the `RuntimeAssembler` evaluates each applied pack's prelude against a **child** scope
  `C' = liveEnv.inherit("prelude/<pack>")` seeded with `register-extension` + the packs' `preludeOnly`
  symbols. Lookups in the prelude: `C'` (the `preludeOnly` symbols) → `liveEnv` (the pack's ordinary symbols
  were already `set` onto `liveEnv` by the normal apply path) → base. `register-extension` is visible;
  runtime symbols are visible; `C'` is discarded when `require()` returns, so nothing leaks to `liveEnv`.
- **Limitation (state it plainly):** because `C'` is a *child* of `liveEnv`, a mid-run prelude's own
  `define`s land in `C'` and are lost when it's discarded (fact 1, inverted). So a pack applied via
  `require/extension` **cannot** contribute runtime bindings through its prelude — only through its declared
  `symbols`. This is a **feature, not a bug** for the mid-run security posture: a program reaching a
  capability by name (`:sql`) should get exactly that capability's *declared* surface on its env, not
  arbitrary names its prelude happened to `define` as a side effect. The base stdlib (whose preludes DO
  define runtime helpers) is assembled at bootstrap, never applied mid-run, so nothing regresses. For the
  only `preludeOnly` symbol that exists today — `register-extension`, consumed by define-free `ext/*`
  preludes — this path is exactly correct.

### 1.5 The crux: is any `.prompt`/`.hbs` verb `preludeOnly`-eligible? — recomputed under the new model

| Verb | Called by | When | `preludeOnly`? |
|---|---|---|---|
| `require/register-extension` | every capability's `prelude` (`.hbs`: `utils.ts:60`; `.prompt`: `prompt.ts:547`) | during assembly (and mid-run per §1.4) | **YES — the first consumer.** Lives on the shared prelude overlay, never the runtime env; discarded post-assembly, so no seal |
| `ext/prompt/resolve` (the `ContentResolver`) | `require`'s own internals, via `env.get(resolverName)` (`loader.ts:428-437`) | **every** `(require "x.prompt")` call site, i.e. arbitrary user-program runtime | **No** — must stay bound on the runtime env |
| `ext/handlebars/resolve` | same `env.get` path, `loader.ts:428-437` | same — every `(require "x.hbs")` | **No** |
| `prompt/run` (monolith) / `dotprompt/render` + `infer/run` (Topic 2 split) | the scheme lambda `require` hands back, invoked whenever the *user's program* calls the required proc | every invocation of the returned proc | **No** |

The verdicts for the resolver + run verbs are **unchanged** from the first draft — the reasoning didn't
depend on the (now-corrected) seal model, only on *when the verb is called*. `ext/prompt/resolve` runs
inside `require`'s own per-call body (`loader.ts:391-498`, `lookupExtensionResolver` → `env.get(resolverName,
{ throwError: false })`), fresh on every `(require …)`, so it must be present on the **runtime env** for the
life of the run — it can never be prelude-only. Confirmed against `Environment.get`
(`Environment.ts:206-232`): that lookup is a plain internal `_lookupWithResolvers` + `patch_value`, no
membrane crossing — TS-internal loader machinery, not a user scheme call, but still steady-state runtime.
This is also why the resolver is safely a raw `{ value: resolvePrompt }` binding rather than a
scheme-callable `symbol.*`: it is reached only via this internal `env.get` (which returns the stored fn
untouched), never through the `require` value channel (`jsToScheme`) that voids JS closures — the CALLABLE
RULE (`loader.ts:58-73`) governs what a *program* gets back from `(require …)`, not how the loader
dispatches to a registered resolver.

**Net effect on Topic 2: `preludeOnly` still contributes nothing to the `.prompt`/`.hbs`/`render`/`infer`
verbs** (§2.5) — they are all runtime-called. The mechanism's sole current consumer is `register-extension`.

---

## 2. Composable `.prompt` resolver: `dotprompt/render` + `infer/run`

### 2.0 Current state (what exists right now, on disk)

`foundations/arrival/llm-plane-arrival-env/src/prompt.ts:445-523` (new, untracked) already fixes the
membrane-voiding bug the historical `second-foundation/arrival-chain/src/packs/ext-prompt.ts` had (confirmed via
`git show HEAD:.../ext-prompt.ts` — it returned `{ kind: "value", value: sealPromptUnit(...) }`, a raw JS
closure, which `require`'s value channel voids to `#void` per the CALLABLE RULE). The current fix is
structurally correct (`kind: "eval"` → a scheme lambda over a directly-bound native verb, `prompt.ts:535-542`):

```ts
const src = `(lambda args (apply ${PROMPT_RUN} ${JSON.stringify(String(contents))} ${JSON.stringify(path)} args))`;
```

...but `prompt/run` (`promptRun`, `prompt.ts:451-523`) is one monolithic `createRosettaWrapper` doing
**everything**: parse-cache lookup, schema resolution (with its own env-eval), kwargs folding, model
resolution, argProvenance folding, node-metadata binding, template rendering, and the `infer/chat` vs.
`infer/agentic/end-to-end` dispatch — a single ~75-line `fn`. This is what V's sketch asks to split.

### 2.1 The verb boundary

Two verbs, matching V's sketch exactly:

```
(lambda args (infer/run (apply dotprompt/render <src> <path> args)))
```

(`apply` is needed on the inner call, exactly as today's `(apply prompt/run <src> <path> args)` —
`args` is the require-lambda's rest-list of the call-site's kwargs, spread positionally into
`dotprompt/render`.)

**`dotprompt/render`** — `symbol.rosetta` with `{ pure: true }` (a *transform*, forwards input
provenance, never mints its own point — see §2.3 for why this is load-bearing, not incidental).
Signature: `(src: string, path: string, ...kv: unknown[]) → bundle`.

Does everything `parsePromptUnit` + the first half of `promptRun` (through building `messages`) does
today, **unchanged in substance**:
- `parsePromptUnitCached(src, path)` — cache hit/parse (`prompt.ts:422-430`, moves verbatim).
- `buildDict(kv)` → strip `:meta`, fold `inputs` (`prompt.ts:459-465`).
- Model pick: `meta.model ?? unit.model`, throw if neither (`prompt.ts:466-475`) — **pure** (string/entity
  comparison, no env access).
- `resolveSchemaValue(unit.schemaSrc, env)` (`prompt.ts:433-443`) — the ONE place render still touches
  `ctx.resolver.env`, to `execExpr` the Picoschema-compiled `(s/object …)` source against the run env
  (`s/object`/`s/field/*` are `BUILTIN_PREAMBLE` scheme functions, `run-program.ts:453-473`). See §2.4 for
  a follow-up that could remove even this.
- `buildInputsProvenance(kv, ctx.argProvenance.slice(2))` (`prompt.ts:67-71`, `477-482`) — per-field
  attribution, computed HERE because this is where the fields are still separate call args (see §2.3).
- `templateReads(unit.sections)` (`prompt.ts:105-149`) — static per-slot field reads.
- `renderTemplateCall(s.source, [inputs])` per section → `messages` (`prompt.ts:502`).

Returns a plain scheme `dict` (membrane-safe DATA — built via the existing `dict`/pair primitives, no JS
closures cross this boundary, satisfying the CALLABLE RULE's spirit even though this is a `value` return,
not a lambda):

```
(dict :model modelArg
      :messages messages          ; ((role . rendered-text) ...)
      :schema schemaValue          ; the evaluated (s/object ...) VALUE, or #f
      :cache-key key
      :mcp-servers unit.mcpServers ; list of names, or #f
      :meta (dict :kind "prompt"
                   :path unit.path
                   :inputs inputs
                   :inputs-provenance inputsProvenance
                   :reads (templateReads unit.sections)))
```

**`infer/run`** — `symbol.rosetta`, SOURCE (default, non-pure — mints its own point). Signature:
`(bundle: unknown) → List<string>` (unary — it takes ONE bundle argument, not the render call's
variadic tail). Does the second half of `promptRun` (`prompt.ts:483-522`) unchanged in substance:
destructure the bundle, `if (inv) inv.setMetadata(nodeMeta)` using the bundle's carried `meta`
(`prompt.ts:488-501`), then dispatch via the *same JS-level `env.get(...)` call* `promptRun` already uses
today (`prompt.ts:509-521`, `env.get("infer/agentic/end-to-end", …)` / `env.get("infer/chat", …)`,
forwarding the *same* `ctx`).

`infer/run` is deliberately **not** `.prompt`-specific in its own right — it's "run this
model+messages+schema+optional-mcp-servers+optional-rich-metadata bundle through inference," reusable by
anything that wants to hand it a pre-rendered bundle. `.prompt`'s resolved lambda is just its first caller.
It lives in `prompt.ts` (not `infer.ts`) because it owns the `mcp:` agentic-dispatch branch and the
`kind: "prompt"` node-metadata shape, both of which are dotprompt-flavored, not general-infer concerns —
keeping `infer.ts`'s `infer`/`infer/chat` free of any `.prompt` knowledge (mirrors the existing file-split
rationale already documented at the bottom of `prompt.ts`, `553-559`, for `utils.ts` vs `prompt.ts`).

### 2.2 Concern-by-concern placement

| Concern | Lives in | Pure or effect? |
|---|---|---|
| Model resolution (frontmatter default + `:meta` override, `asLlmModel` name extraction is still done by `infer`/`infer/chat` themselves per `infer.ts:104-117` — render only picks *which* raw model arg wins) | `dotprompt/render` | Pure |
| Picoschema `output:` → schema value | `dotprompt/render` | Pure-ish (needs `ctx.resolver.env` to eval `s/object` forms — see §2.4) |
| `{{role}}` section split + handlebars render | `dotprompt/render` | Pure |
| `argProvenance` per-field attribution | `dotprompt/render` | Pure — **must** happen here; see §2.3 |
| Node metadata shape (`kind:"prompt"`, `path`, `model`, `inputs`, `inputsProvenance`, `reads`) — computed | `dotprompt/render` (packed into the bundle's `:meta`) | Pure |
| Node metadata — **attached** (`inv.setMetadata(...)`) | `infer/run` | Effect (needs `ctx.currentInvocation`, only meaningful at the mint site) |
| Provenance point (the mint) | `infer/run` | Effect |
| `mcp:` agentic branch (dispatch decision) | `infer/run` (reads `bundle.mcpServers`) | Effect |
| Actual inference call | `infer/run` → `env.get("infer/chat" \| "infer/agentic/end-to-end")` | Effect |

No third verb is needed — the schema/model/provenance concerns all resolve to "compute it as data in
render, attach it as effect in infer/run." A three-verb cut (e.g. splitting schema resolution out) would
only be justified if schema resolution needed to be independently reusable or independently cacheable
outside a `.prompt` render — it isn't; it's already cached by source string (`SCHEMA_VALUE_CACHE`,
`prompt.ts:432-443`) exactly where it sits today. **Recommendation: two verbs, as sketched.**

### 2.3 Why the ONE-node invariant survives the split (this is the part that's easy to get wrong)

`sealPromptUnit`/`promptRun` reach `infer/chat` today via a **JS-level** `env.get("infer/chat")(...)`
call, forwarding the *same* `ctx` — not a scheme-level `execExpr` dispatch. The in-file comment names this
explicitly: `prompt.ts:518-521` / historical `infer-kernel.ts:718-727` ("OPTION B... reach inference
through the env's verb directly... marks the prompt's OWN invocation, so this stays ONE node... TODO
(option A)... dispatch via `execExpr`... would give a NESTED node"). Only calls that go through the
evaluator (`execExpr`) create a new `Invocation` record; a raw JS function call forwarding an existing
`ctx` does not.

V's sketch composes `dotprompt/render` and `infer/run` as **scheme-level** calls (a lambda body — real
`execExpr` dispatch), which *would* create two separate `Invocation`s. The ONE-node invariant is preserved
by making `dotprompt/render` a **transform** (`pure: true`): per `bakeRosetta` (`_bake.ts:530-541`), a pure
rosetta never calls `markProvenancePoint()` on its own invocation, so `isProvenancePoint` stays false on
it — and the trace-to-chain projection filters on exactly that flag (the same reasoning `require` itself
uses to stay invisible, `loader.ts:392-403`: "a mint here surfaces `require` as a spurious extra chain
node"). `infer/run`'s own SOURCE mint becomes the *only* visible node. Two `Invocation`s exist under the
hood; one is visible. This is why `dotprompt/render` being `pure: true` is **load-bearing**, not a style
choice — get it wrong (leave it a default SOURCE) and every `.prompt` call regresses to a two-node
render→infer chain.

This is also why per-field `argProvenance` **must** be computed inside `dotprompt/render` and carried as
plain data in the bundle (`:meta :inputs-provenance`), not recomputed in `infer/run`: `infer/run` receives
exactly ONE argument (the bundle), so its own `ctx.argProvenance` could at best describe "what produced the
whole bundle," not per-field origins. The field-level attribution only exists while the fields are still
separate call args — i.e., inside render.

### 2.4 Deferred simplification (flagged, not designed here)

`dotprompt/render` still needs `ctx.resolver.env` for exactly one thing: evaluating the Picoschema-compiled
`(s/object …)` **source text** into a scheme VALUE (`resolveSchemaValue`, `prompt.ts:432-443`), because
`s/object`/`s/field/*` are scheme functions defined in `BUILTIN_PREAMBLE` (`run-program.ts:452-472`), not
TS functions. Since those functions are trivial (`(cons "object" fields)`, `(list name type desc)`), the
Picoschema compiler (`compilePicoschema`/`compilePicoField`/`scalarFieldSrc`, `prompt.ts:301-342`) could
construct the equivalent tagged-list scheme *value* directly in TS instead of emitting source text to eval
— making `dotprompt/render` need **zero** env access, a genuinely pure function of its args. This is a real
simplification but a separate, self-contained refactor of the Picoschema compiler; doing it inside this
split would conflate two changes in one commit against `.claude/rules/git-hygiene.md`'s atomicity rule.
**Recommendation: land the two-verb split first (§2.1) keeping schema resolution exactly as it works
today; do the Picoschema-compiles-to-value refactor as a follow-up if V wants it.**

### 2.5 `preludeOnly` applied to Topic 2

None of `dotprompt/render`, `infer/run`, or `ext/prompt/resolve`/`ext/handlebars/resolve` are
`preludeOnly`-eligible — see §1.5's table (all are runtime-called). The only `preludeOnly` symbol in this
whole path, `require/register-extension`, is unaffected by the split: it still lives on the shared prelude
overlay and is still called from `arrivalPromptCapability`'s `prelude` (`prompt.ts:547`) — the split changes
what the resolved lambda dispatches to (§2.1), not how the resolver is *registered*.

---

## 3. Risks / open questions

1. **Transiently re-parenting `R` during assembly (§1.3).** The overlay mechanism swaps `base.__parent__`
   onto `preludeOverlay` for the duration of `assembleEnv`, then restores it. This is safe *only because* R
   is not yet live (the program can't observe it mid-assembly). It must never be applied to a live env —
   which is exactly why the mid-run path (§1.4) uses a child scope instead. An explicit test should assert
   that after `assembleEnv` returns, `base.__parent__` is the original sandbox base (no residual overlay
   frame) and a `preludeOnly` name resolves to a plain unbound-variable error at runtime.
2. **Mid-run prelude `define`s are scoped-and-dropped (§1.4).** A pack applied via `(require/extension …)`
   cannot contribute runtime bindings through its prelude (its `define`s land in the discarded child scope).
   Argued as the correct security posture, but it *is* an asymmetry with bootstrap assembly (where prelude
   `define`s DO reach the runtime env). Worth a test: apply a mid-run pack whose prelude both calls
   `register-extension` (must work) and `define`s a name (must NOT leak to the live env), and a matching
   bootstrap test where the same defining prelude DOES reach runtime. Open question if a future mid-run pack
   genuinely needs prelude-defined runtime helpers — the answer today is "assemble it at bootstrap instead."
3. **Loss of the teaching error.** Today's `sealRegisterExtension` throwing stub gives a specific message
   ("bootstrap-only: a file-type resolver is a capability grant…", `loader-extensions.ts:110-114`). The
   corrected model replaces it with the generic unbound-variable error (`Environment.get`,
   `Environment.ts:226-229`). A resolver on the runtime env *could* re-add a teaching hint for known
   `preludeOnly` names, but a resolver must return a value — so it would have to return a throwing thunk,
   which is the stub-in-the-runtime-env pattern V is moving away from. Recommendation: accept the plain
   unbound error; the name genuinely isn't in scope, so a generic "does not exist" is honest.
4. **`Contract.preludeOnly` on `symbol.native`.** Native ops work on raw scheme values with no codec — a
   `preludeOnly` native symbol is a legitimate combination (e.g., a one-shot bootstrap value-binding verb),
   but there's no existing native-kind precedent to check the design against; worth a small `__tests__` case
   when a first native `preludeOnly` symbol appears.
5. **`dotprompt/render`'s bundle shape stability.** The `:meta` sub-dict's shape (`kind`, `path`, `inputs`,
   `inputs-provenance`, `reads`) is exactly `promptRun`'s current `nodeMeta` object
   (`prompt.ts:490-497`) — reusing it verbatim keeps `prompt-chain.test`-style expectations valid, but any
   future prompt-chain test should be re-run against the split before landing (not just typechecked).
6. **`asLlmModel`'s `middleware`/`params` are dropped at the render/infer boundary today too** — `infer/run`
   passes the raw `modelArg` (string or `(llm …)` entity) through to `infer/chat`, which re-runs
   `asLlmModel` itself (`infer.ts:155`, `168`) exactly as `promptRun` already does (`prompt.ts:476`,
   `521` — `asLlmModel(modelArg).name` is computed once for the metadata's `model` field, but the *raw*
   `modelArg` is what's actually sent to `infer/chat`). The split doesn't change this — just confirming it
   isn't a new regression introduced by moving code, since a bundle round-trip through scheme `dict` could
   have been a place to accidentally coerce the `(llm …)` entity to a bare string.

## 4. Smallest revertable implementation plan

**Topic 1 — the prelude-overlay mechanism + register-extension as its consumer:**

1. **`Contract.preludeOnly` (boolean) + baked-def field** (`_bake.ts:91-105`, `122-129`, `133-149`) —
   additive, zero behavior change until a caller sets it or the assembler routes it. Typecheck + existing
   `symbol.test-d.ts` proofs should pass unmodified.
2. **The shared prelude overlay in `assembleEnv`** (`kernel.ts:206-220`) + `preludeScope` on `PackContext`
   (`kernel.ts:27-32`, threaded via `makeCtx`, `186-199`): create `preludeOverlay = base.__parent__.inherit(…)`,
   re-parent `base` onto it, expose it as `ctx.preludeScope`, and after the apply loop restore `base`'s
   parent and drop the overlay. Behavior-neutral until a pack routes a symbol onto it (step 3) or something
   is seeded (step 4).
3. **Route `preludeOnly` symbols in `EnvCapability.apply`** (`capability.ts:212-266`): in the `switch
   (def.kind)` binding loop, if `isBakedDef(def) && def.preludeOnly && ctx.preludeScope`, bind onto
   `ctx.preludeScope` with the SAME form instead of `env`. No-op for the whole codebase until step 4, since
   no existing capability sets the flag. Unit-testable in isolation: a bare `EnvCapability` with one
   `preludeOnly` rosetta whose *prelude* calls it (works) and an assertion that the runtime env does NOT
   bind it afterward (plain unbound error).
4. **Migrate `register-extension` onto the overlay** (`run-program.ts:57,70`): seed `register-extension`
   onto `preludeOverlay` instead of `base` (the one-line bind-target move), and **delete
   `sealRegisterExtension(env)` (line 70)** plus the `sealRegisterExtension` export
   (`loader-extensions.ts:107-116`). This is the first real behavior change — verified by the existing
   `loader-extensions.test.ts` (update the "sealRegisterExtension replaces it with a throwing stub" case,
   `loader-extensions.test.ts:56-59`, to the new "not bound on the runtime env at all" expectation) plus an
   end-to-end assertion that `.hbs`/`.prompt` still resolve (their preludes still see `register-extension`
   on the overlay).
5. **Mid-run path in `createRuntimeAssembler`** (`kernel.ts:243-283`): evaluate each applied pack's prelude
   against a child `C' = liveEnv.inherit(…)` seeded with `register-extension` + the pack's `preludeOnly`
   symbols, discarded when `require()` returns (§1.4). Test: a mid-run `(require/extension …)` whose pack
   prelude calls `register-extension` succeeds, and a name its prelude `define`s does NOT leak to `liveEnv`.

**Topic 2 — the `.prompt` split (independent of Topic 1):**

6. **Split `promptRun` → `dotprompt/render` + `infer/run`** (`prompt.ts:445-523`). Land with the bundle
   shape from §2.1, `pure: true` on render (§2.3 — do not skip this), keeping schema resolution exactly as
   today (§2.4 deferred). Update the resolver's generated source (`prompt.ts:535-542`) to the two-call
   lambda. Update `arrivalPromptCapability.symbols` to bind three verbs (`dotprompt/render`, `infer/run`,
   `ext/prompt/resolve`) instead of two.
7. **Re-run/extend prompt-chain provenance tests** against the split (risk #5) before considering it done.
8. *(Optional, separate commit)* Picoschema-compiles-to-value refactor (§2.4), only if V wants
   `dotprompt/render` to need zero env access.

Each step is independently revertable and independently buildable. Steps 1-3 are behavior-neutral until
step 4 flips `register-extension` onto the overlay (the one real Topic-1 behavior change, and the migration
that *removes* code — the throwing stub — rather than adding a mechanism). Topic 2 (steps 6-8) does not use
`preludeOnly` at all (§2.5), so the two topics are fully independent and can land in either order.
`register-extension` is the mechanism's sole current consumer; the declarative `preludeOnly:` flag earns
its second use the day a capability needs an own-scoped or shared bootstrap verb of its own.
