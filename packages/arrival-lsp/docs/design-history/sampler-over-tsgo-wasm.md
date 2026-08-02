# Sampler over tsgo-wasm: re-platforming the Σ∩T type oracle onto TypeScript 7

**Status**: spike PASSED (2026-06-11, verdict-parity green 118/118) — but the integration was deleted post-migration:
the `arrival-lsp-tsgo` package was removed in `90dfa792ac`; see git history. Kept as the design record.
**Ask (V)**: "rework sampler to make it work over the wasm-built ts 7.0 instead of js-based one."

## What "sampler over TS" actually means

`arrival-sampler` itself has no TypeScript dependency. The TS dependency is the **T of Σ∩T**: the
sampler's type gate (`narrowByType` → `getTypeValidCandidates`) and every IDE feature behind
`arrival-codemirror` bottom out in `arrival-lsp/src/service-core.ts`, which runs the **JS
`typescript@6.0.2` LanguageService** over virtual files. This rework re-platforms that substrate
onto **typescript-go (TypeScript 7) compiled to WebAssembly**, so the same oracle runs ~10–50×
faster, in a browser worker and under Node, from one hermetic artifact.

## Ground truth (2026-06-11)

Registry + repo + spike facts, verified today:

- `typescript@latest` = 6.0.3 (strada, JS). **TS 7 stable is weeks away** (beta 2026-04-21, no RC
  yet). Channel: `@typescript/native-preview` 7.0.0-dev dailies. A "stable programmatic API" is
  deferred to **7.1+**.
- **No official wasm build exists; it is explicitly Post-7.0** (microsoft/typescript-go#3478).
  The repo contains zero wasm support — and **builds clean anyway**:
  `GOOS=js GOARCH=wasm go build ./cmd/tsgo` → 53 MB `tsgo.wasm` (≈11 MB gzip / 9.6 MB brotli),
  needs Go's `wasm_exec.js` glue. Single-threaded (checker parallelism lost — irrelevant at our
  program sizes). Unofficial daily `tsgo-wasm` (sxzz, Vue core) proves the same build.
- The JS API client ships **inside** native-preview as `./unstable/*` (sync = pure-JS subprocess
  channel; async = vendored vscode-jsonrpc). Protocol **unversioned**; client and binary must be
  commit-matched. We therefore speak the wire protocol ourselves (~150 lines) instead of importing
  unstable internals.
- `tsgo --api -async`: JSON-RPC 2.0 over LSP framing on stdio. `-callbacks
  readFile,fileExists,directoryExists,getAccessibleEntries,realpath` delegates the FS to the
  client — **virtual files are first-class**. `readFile` reply is three-state
  (`{content: string}` / `{content: null}` = absent / bare `null` = fall through to base).
  `callbackFS` wraps the `bundled:///libs` layer (108 embedded `lib.*.d.ts` via go:embed), so we
  can **fall through to embedded libs or serve our own value-stripped lib world** — the
  "scheme has no JS env" doctrine survives intact (`-tags noembed` also available).
- Session model: `updateSnapshot {openProject | fileChanges{changed[]}}` → snapshot/project
  handles (+ `release`). Long-lived instance is mandatory (cold CLI runs ≈1 s; warm ≈ms).

### Spike numbers (Node, wasm_exec, warm instance, real es2022 lib world)

| op | time |
|---|---|
| spawn + 53 MB wasm boot + initialize | 117 ms |
| project load (tsconfig + libs) | 80 ms |
| first semantic check | 33 ms |
| **per-edit re-check** (updateSnapshot changed + getSemanticDiagnostics) | **2.6 ms median** |
| **per probe** (getTypeAtPosition + isTypeAssignableTo) | **0.3 ms** |

0.3 ms/probe makes the T-gate viable **per decode step** inside the sampler's logits mask — the
thing the JS LanguageService could never give us in-browser.

## The design inversion

The JS-TS-era service pushed *scheme-shaped* questions into TS because the LanguageService was the
only brain available: sentinel insertion + TS-AST walks for cursor role, whole-global-scope
completions minus a baseline, `checker.getContextualType` walks for param inference, conditional-
type probe programs (`__ok<T>` tuples) read back element-wise to dodge `typeToString` truncation.

Over the tsgo API each question goes to its **native layer**:

| question | old (JS ts) | new |
|---|---|---|
| cursor role (operator/argument/argIndex/callee) | sentinel + TS AST walk | **arrival reader** (`parseSexprs` + emitter roster) — we own the structure |
| in-scope locals for completions | tsc global scope − baseline | **Σ machinery / scheme scope walk** + `resolveName` for kinds/types |
| definition sites | LS.getDefinitionAtPosition + lift | **scheme-side binding sites** (defines/lambda params; dep mappers for requires); builtins stay `span: null` |
| slot param type | `Parameters<typeof callee>[i]` probe text | `getTypeAtPosition(callee)` → `getSignaturesOfType` → `getParameterType(sig, i)` |
| candidate verdict | `[T] extends [E]` probe tuple | `resolveName(name, file, pos)` → `getTypeOfSymbol` → `isTypeAssignableTo` (+ return-type unwrap via `getReturnTypeOfSignature`) |
| param inference (V's "infer from consumers") | `getContextualType` per use site (TS AST walk) | scheme-side use-site walk → call-arg slots → same slot-param-type machinery |
| diagnostics | LS.getSemanticDiagnostics | API getSemanticDiagnostics (structured messageChain — better than flatten) |
| hover | LS quickinfo displayParts | `getTypeAtPosition` + `typeToString` + **doc-map generated from our own .d.ts leaves** |
| semantic classifications | LS encoded classifications | batched `getSymbolsAtPositions` + flags→kind map |

Key enabler: **`resolveName` accepts `file` + `position` as location context** — no NodeHandle,
no client-side AST materialization, no binary AST decoder. Everything we need is position-based,
and the Mapper already owns scheme↔TS positions.

Probe-semantics equivalence: `[T] extends [E]` (tuple-wrapped, non-distributive) *is* the
assignability relation `isTypeAssignableTo` exposes; unresolvable candidates stay kept
(conservative contract unchanged: T only ever drops the provably ill-typed).

## Architecture

```
arrival-lsp
├── src/tsgo/transport.ts     spawn/worker transports, virtual stdio, wasm boot
├── src/tsgo/client.ts        ~150-line JSON-RPC client + vfs-callback server (own, stable)
├── src/tsgo/checker.ts       typed wrappers for the ~15 API methods we use
├── src/backend.ts            CheckerBackend seam (async)
├── src/service-core.ts       7-method SchemeLanguageService over the seam
│                             (async-native; ts-js impl retained behind same seam as AB canary)
└── ls-server/worker          per-call files plumbing (activeFiles swap-slot assumed sync — fix)
```

- **Browser**: the wasm instance lives inside the existing scheme-ls (Shared)Worker; virtual stdio
  = `globalThis.fs` shim; protocol identical. `ls-client`/CodeMirror untouched (already async).
- **Node**: spawn `node wasm_exec_node.js tsgo.wasm --api -async` (spike-proven). Native `tsgo`
  binary is a free opt-in later (same protocol, ~7.5× faster) for test-suite speed.
- **Sync story**: `narrowByType`'s sync `TypeLens` has **zero live compositions** (unit tests +
  a sift comment) — the core goes async-native. A sync facade (SAB/Atomics, synckit-style) is
  deferred until the sampler's generation path actually lands in-product (phase 2).

## Honest divergences (to verify with the AB canary)

1. Param inference covers **call-argument use sites** (the dominant case); `getContextualType`'s
   other contexts (return positions, initializers) conservatively skip → fewer auto-annotations,
   never wrong ones. Revisit via NodeHandle/AST if the gap bites.
2. Hover text shifts cosmetically (typeToString vs displayParts; docs from our leaf JSDoc map).
3. Diagnostics: TS7's wording/codes may drift from 6.0.2 on exotic cases; the lens's rewrite
   layer (2304/2552/2339 → scheme-speak) keys on codes, which are stable.
4. TS 7 checker behavior ≈ 6.x by design (the port is behavior-preserving), but the canary
   (run both backends on the test corpus, assert verdict equality) is the proof, not the promise.

## Vertical slice — landed 2026-06-11 (`src/tsgo/` in arrival-lsp)

`client.ts` (own ~200-line JSON-RPC client + vfs-callback server, zero unstable-npm imports) ·
`node-transport.ts` (spawn node+wasm_exec, artifacts in gitignored `.tsgo/`, `scripts/build-tsgo-wasm.mjs`
rebuilds from the pinned commit `cda7baffa`) · `type-lens.ts` (the T-gate) ·
`__tests__/tsgo-equivalence.test.ts` (the AB canary — loud-skips without the artifact).

Two drafts died honestly on the way to verdict parity, both now documented in the module header:

1. **Direct `isTypeAssignableTo(typeof C, paramType)` is NOT the probe's semantics**: builtins are
   generic (`car<T>(xs: List<T>): T`) and bare signature reads compare FREE type parameters
   (`List<T₂>` ⇸ `List<T>` — never assignable) → every generic slot narrowed to ∅.
   `Parameters<>`/`extends` instantiate through INFERENCE (→ `List<unknown>`).
2. **A direct/return-unwrap OR misses `__ok`'s tri-state**: a generic whose return instantiates to
   `any` collapses the conditional to `boolean` ("unprovable") which `__ok` defers to the direct
   test (witness: the `@` builtin).

Landed shape: the probe embeds service-core's `__ok<T>` **verbatim** (identical inference by
construction) and reads its tri-state via TWO assignment-tests per candidate
(`const __vNt: true = … as __ok<C>` / `const __vNf: false = …`): `true` keeps, `false` drops,
`boolean` (unprovable / error-any) errors both lines ⇒ kept. Verdicts come from **diagnostics**,
not `typeToString` tuple reads — the truncation bug class is structurally dead. The call slot
(callee + argIndex) comes from `scanInnermostCall`, a lexer-faithful scheme-side scan (no sentinel,
no TS AST). All 6 corpus rows verdict-identical js-ts ↔ tsgo; full package suite 118/118.

### Honest perf finding (corpus-scale programs, Node, warm)

| loop | js-ts (in-process) | tsgo-wasm (RPC) |
|---|---|---|
| per-slot `getTypeValidCandidates` (8 candidates) | **4.6 ms** | 5.9 ms |
| per-edit `getSemanticDiagnostics` | **1.4 ms** | 2.6 ms (spike, full un-stripped libs) |

**At small-program scale the JS LanguageService wins every measured loop** — the T-gate is
RPC-overhead-dominated (3 round-trips through child-process pipes + JSON), not checker-dominated,
and wasm loses tsgo's checker parallelism (single-threaded). The case for the flip is NOT today's
micro-perf:

- **Scale**: real arrival programs (require closures, sift host preludes) where strada's re-check
  grows worse than tsgo's checker core — unmeasured; the next bench decides.
- **Longevity**: strada is DONE upstream (6.x dailies stopped 2026-04-16); `typescript@6.0.2` is a
  frozen pin while TS 7 is the only continuing TypeScript.
- **Browser transport**: in-worker virtual stdio (same-thread calls through the wasm_exec fs shim)
  is much cheaper than process pipes — browser per-slot lands below the 5.9 ms, not above.
- **Pipelining**: concurrent in-flight probes amortize RPC overhead in the per-decode-step path —
  the sync LanguageService can't overlap at all.

**Recalibrated recommendation**: keep js-ts the default backend behind the seam for now; land tsgo
as the proven, opt-in backend; run the scale bench (a real sift-sized program) before flipping the
default. The sampler-critical path is proven over wasm TS7 either way.

## Open calls (V)

1. **Artifact hosting**: self-built `tsgo.wasm` from a pinned official commit (build script checked
   in). Where does the 53 MB binary live — gitignored + built-on-demand (needs Go toolchain),
   in-repo (repo weight), or our own published package? *Not* a dependency on sxzz's daily
   (third-party supply chain, per npm-pinning rule).
2. **AB canary retention**: keep the ts-js backend permanently behind the seam (fallback +
   equivalence tests) vs delete after the port stabilizes.

## Phases

1. ✅ Spike: wasm build + API protocol + virtual fs + perf (this doc).
2. **Vertical slice**: `getTypeValidCandidates` over tsgo-wasm with the real prelude, verdict-equal
   to the ts-js implementation on the existing corpus. ← in progress
3. Full core: remaining 6 methods, ls-server async plumbing, browser worker boot, codemirror smoke.
4. Validate: suites green (type-lens, codemirror, sift smoke), perf note, commit.
5. (Phase 2, separate) Sampler generation path: per-step Σ∩T in-browser — own decode loop or SAB
   sync facade; slot-keyed T-cache; ghost upgraded from Σ-only.
