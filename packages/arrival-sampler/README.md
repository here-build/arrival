# @inhuman.tools/arrival-sampler

> ## ⚠️ EXPERIMENTAL — proof of concept
>
> This package is **not production software**. It is a satellite artifact of an argument —
> a working demonstration built to make a point about how grammar constraints on LLM decoding
> should be designed and costed. The API is unstable, the version stays 0.x, breaking changes
> land without ceremony, and the package's continued existence is justified by the point it
> makes, not by any production dependency. The argument itself is written up in
> [`PAPER.md`](./PAPER.md); the code and its model-free test suite are the evidence.

## The point

Constrained decoding is usually treated as a knob: mask the tokens you don't like, keep the
ones you do. This package exists to demonstrate that the design space has **laws**, and that
honoring them is the difference between a constraint that helps and one that silently harms:

1. **The soundness law.** A validity-only grammar gate can never score below unconstrained
   decoding under greedy decode — the model's own correct output consists of tokens the gate,
   by definition, never masks. The contrapositive is a *bug detector*: any measured negative
   lift means the grammar's "valid" is narrower than the scorer's "correct", somewhere. Three
   real decode bugs were found exactly this way (see `tests/kernel/honor-the-stop.test.ts`,
   `tests/kernel/backtick-tolerance.test.ts`, and PAPER.md §5).

2. **The minimal-intervention law.** The cost of a constraint is the **probability mass of
   the picks it forces**, not the count of overridden argmaxes. Forcing a token the model
   itself considered plausible (inside its uncertainty nucleus) is free — indistinguishable
   from sampling variance. Forcing a token from the <5% tail makes the model condition on text
   it considers implausible, and the damage compounds forward. The decode loop instruments
   exactly this (`tailPicks` / `tailMass` telemetry, `src/runners/local/strategies/common/types.ts`).

3. **The corollary discipline: validity, never style.** Σ admits *exactly* what arrival's
   reader reads. A validity gate on a competent model almost never fires (a safety net); a
   style gate fires on every fluent valid path (a steering wheel dragging the model
   off-distribution). The anti-drift gate is executable: the reader's own conformance corpus
   is driven through the real admission path, char by char
   (`tests/kernel/corpus-conformance.test.ts`) — reader-accepts ⟺ Σ-admits, with the single
   deliberate tightening (quasiquote) pinned and named.

What is honestly **unproven** — generality beyond one grammar (arrival Scheme tool calls),
behavior beyond greedy-dominant decoding, and the full envelope-pass-through architecture the
findings point at — is catalogued in PAPER.md §6. Don't cite the headline numbers without
reading that section.

## What's in the box

The package is organized around three autonomous primitives:

1. **Sampler kernel** (`@inhuman.tools/arrival-sampler`, the `.` export) — substrate-free. All
   logic lives in `isCandidateLive` / `selectConstrainedStep` + the structural + Σ gates. No
   LLM, no node-llama-cpp, no I/O. Fully covered by deterministic, model-free tests.
2. **Sampler ↔ LLM wiring** (`./server`, `./decode`, `./lmstudio`) — on-demand GGUF loading
   via node-llama-cpp (Metal), the manual constrained decode loop, and a thin OpenAI-compatible
   server (`/v1/chat/completions`). Models are JIT-loaded, reused, idle-offloaded and
   LRU-evicted.
3. **BFCL runner paths** (`scripts/bfcl_*`) — minimal wrappers. Reference numbers come from
   the official BFCL harness (or the lightweight `bfcl_reference` runner) pointed at an OpenAI
   endpoint (LM Studio for native baselines, or the sampler's own server for constrained runs).
   The TS side only provides the compatible endpoint + output shaping.

## Core guarantees (enforced at every decode step)

- **Structural** — unbalanced or misnested programs are ungeneratable. `)` cannot open a
  program; EOS is admitted only when the program is *closeable*.
- **Σ (bound-symbol)** — with a grant env, an unbound operator/argument atom is ungeneratable.
  Numbers and literals are exempt. Without an env the Σ layer degrades gracefully to
  structural-only.

The single shared decision primitive is `selectConstrainedStep` (lazy top-K walk + one widen +
structural fallback + EOS gate). It is used by all backends and proven equivalent to the
reference `compileMask` path (`tests/kernel/contract-parity.test.ts`,
`tests/kernel/session-parity.test.ts`).

## Using the kernel directly (primitive 1)

```ts
import { isCandidateLive, selectConstrainedStep, compileMask } from "@inhuman.tools/arrival-sampler";
import { makeOracle } from "@inhuman.tools/arrival/oracle";

const scanner = makeOracle(grantEnv);
// Use isCandidateLive or selectConstrainedStep with your own tokenizer/ranking source.
```

See `tests/kernel/` (especially `feasible-kernel.test.ts`, `constraint.test.ts`,
`structure-gate-e2e.test.ts`, `sigma.test.ts`) for the full contract proof. The kernel is the
only thing that ships under the `.` export.

## LLM wiring (primitive 2)

Node-only. The path is:

- `LlamaModelHandle` + `llamaCppGenerator` / `generateWithExplain` (decode layer,
  `src/runners/local/`)
- `makeRealDecode` + `ModelManager` (on-demand + lease + idle/LRU, `src/runners/server/`)
- `createOpenAIServer` (thin HTTP shell)

Point any OpenAI-speaking client at the server. Use the `contract` field or render strategies
to choose fc vs prompt shapes.

```ts
import { createOpenAIServer, makeRealDecode } from "@inhuman.tools/arrival-sampler/server";
const { decode, dispose } = makeRealDecode({ idleTimeoutMs: 5 * 60_000 });
const server = createOpenAIServer({ decode });
server.listen(1234);
```

See `src/runners/server/` and `src/runners/local/` for the seams (`DecodeFn`, `StepExplain`, etc.).

## BFCL integration (primitive 3)

- **Reference numbers**: Use `scripts/bfcl_reference/` (lightweight, points at LM Studio
  OpenAI) or the official harness via `scripts/bfcl_official/bfcl_lmstudio.py`.
- **Constrained sampler numbers**: Start the sampler's OpenAI server, set
  `OPENAI_BASE_URL=http://localhost:1234/v1`, and run the BFCL harness against it (the server
  emits `tool_calls` or python-ast shapes via its render strategies).
- The sampler's responsibility is the endpoint + correct lowering. Orchestration and scoring
  stay in the BFCL harness.

See `scripts/bfcl_official/README.md` and `scripts/README.md`.

## Importing the oracle

The kernel depends only on the structural `OracleScanner` contract (`src/oracle-types.ts`).
You inject a scanner produced by `makeOracle` from `@inhuman.tools/arrival/oracle`.

(The value injection keeps the sampler decoupled from arrival's internal evolution;
`tests/kernel/contract-parity.test.ts` goes loud if the contract drifts.)

`@inhuman.tools/arrival` publishes `makeOracle` at the `./oracle` subpath. The consuming app
supplies it (tests resolve the real one via a vitest source alias — see `vitest.config.ts`).

## Kernel implementation notes

The per-candidate liveness check (`isCandidateLive` / `classifyCandidate`) and the unified
per-step decision (`selectConstrainedStep`) are shared by every path. `compileMask` remains the
O(vocab) reference implementation; the real paths walk only a bounded ranked window (top-K +
one widen + structural-closer fallback), so constraint checking costs O(K) oracle consultations
per step, not O(vocab).

The session/resumable seam (`OracleSession.clone().advance`) is the documented incremental hook
when a scanner provides it (verdict-identity proven in `tests/kernel/session-parity.test.ts`).

All of this is model-free and substrate-free — exactly what primitive 1 exports.

## sift dedup note

`src/mask-compiler.ts` is the **canonical home** of the char-vs-token mask logic. The
dependency arrow runs foundation → foundation (`arrival-sampler` → `arrival`), never importing
sift. sift's duplicate was deleted when the sampler graduated; this is the sole home and it
carries the Σ gate. `applyMask` / `compileMask` / `Tokenizer` / `TokenMask` are the shared
surface.

## Experiments & research inventory

The package is deliberately a mix of kernel + a series of experiments, probes, benchmarks and
harness work — that mix is the *nature* of the package, not an accident to be cleaned up.

**See `EXPERIMENTS-AND-RESEARCH-INVENTORY.md`** for the full catalog and storage rules:

- Kernel/runner code vs. `tests/research` / `tests/custdev` / `tests/experiments` / `tests/benchmarks`
- Key studies (misprediction metrics, naming schemes, palettes, prelude×render matrices, etc.)
- Findings store, apple-intents fixtures, BFCL/tau-bench scripts
- How to run each category (and why default `test` stays model-free)

Update the inventory when experiments graduate into the kernel or are archived.

## License

**[FSL-1.1-MIT](./LICENSE.md)** — Functional Source License 1.1, MIT Future License; each version
converts to MIT two years after release. Same license and same plain-words boundary as
`@inhuman.tools/arrival` (the experimental status above changes the support promise, not the
license). Questions: team@here.build
