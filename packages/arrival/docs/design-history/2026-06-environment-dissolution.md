# Environment dissolution (2026-06 → 2026-07)

Outcome: the LIPS-heritage `Environment` class (~560 LOC, later counted as six jobs in one 311-line
class) is gone. The surviving surface: `AmbientRuntime` (raw frame storage, birth via `mintFrame`),
`eval/LexicalScope.ts` (the lexical model — a glass over the base-linked runtime, swappable without
re-touching the engine), `eval/CompiledResolutionChain.ts` (BakedBase: sealed at bake, no write
surface — the write-window is a TYPE fact, not a convention), and `common/kernel.ts`
(`EnvPack`/`PackContext`/`createRuntimeAssembler`/`RuntimeAssembler` for mid-run `(require/extension)`
packs). Bootstrap assembly is `env/vocabulary.ts` `buildVocabulary` + `env/assemble-run.ts`.
Canonical present-tense doc: `../environments.md`.

Why dissolved — one class conflated four responsibilities:
1. lexical frame storage (the true core);
2. baked capability base (resolvers, `defineRosetta` registries) installed at assembly yet carried
   by every frame;
3. run metrics — the smoking gun: the heap meter was copied onto the env and restored around each
   exec, when `RunContext` already owned that state;
4. membrane-at-storage (boxing in `set()`, `patch_value` on `get()`).
Deeper: baked-vs-frame was a runtime convention (a documented write-window), not a type; and
capability composition rode single-inheritance — envs *happened* to inherit a capability instead of
declaring a grant, with no structural "this env has exactly these capabilities."

Decision path: shrink/split/un-export (June) → EnvPack + C3-linearized capability DAG with
`assembleEnv` as the composition door → a four-option decomposition study → ruling: **strip the
foreign organs first, then promote the wrappers to the only types** (meter → RunContext, boxing →
membrane face, resolvers → transient bake overlay that must be empty at seal, then delete the
class). Landed as four tranches in one day (2026-07-09); sealing the bake made the cut path ~50%
faster. The rename landed as `AmbientRuntime` — "inheritance dissolved, birth is the only door" —
not `Scope`, which `LexicalScope` already owns.

What outran the docs:
- The endgame's proposed `Env` interface (`ready`/`chain`/`topScope`/`defaultEnv`) never landed; its
  job went to `Vocabulary` + `assembleRun` + `RunContext`, and `assembleEnv`/`AssembledEnv`/`lower()`
  were deleted outright — which also dissolved the never-called `dispose`/windDown lifecycles.
- The interleaved resolver chain (`Step[]`, purity flags, negative caching) was designed but never
  built: the zero-resolver degenerate case became the only case at seal, so `steps` is a
  single-element tuple.
- The capability roster split in two: an automatic `BASE_ROSTER` folded into every run's tuple
  (never a child frame on `user_env`), and an opt-in public `./capabilities` export surface with
  per-pack tree-shakeable leaves — the roster became public product surface, which the design docs
  never addressed.

Rejected alternatives, with their failures:
- Value-ized persistent-map environments — changes the evaluator's hottest allocation path; waits
  for the wireframe era. Its content-addressing half shipped anyway (`CompiledResolutionChain.hash`).
- Resolution as a tagless-final term — per-lookup indirection on the hot path.
- Stopping after organ-stripping — leaves one class playing baked-root AND frame by convention.
- "Replace Environment with EnvCapability" — category error: capabilities are wiring, scope is
  scope; something must still hold `__parent__` and walk the chain.
- Meter on the env — an env is shared across concurrent runs; two concurrent execs would charge one
  budget.
- `Capabilities` absorbing the composition — re-fuses the two halves of the Resolver's cut
  (`scope.lookup(name) ?? capabilities.lookup(name)`).
- Custom precedence instead of C3 — cite the named spec, don't invent (parity with Python's C3,
  including rejecting what Python rejects).
- Packs binding raw host closures via `env.set` — leaks unwrapped host references across the
  value-only membrane; the rule survives in `EnvPack.apply`'s docstring.

Distilled 2026-08-02 from 6 working docs; see git history.
