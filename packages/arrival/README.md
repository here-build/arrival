# @inhuman.tools/arrival

**A small, sandboxed R7RS Scheme built for LLM agents to speak — where nothing hides: not
where a value came from, not what a tool call was, not what crossed the JS boundary.**

arrival is a programming medium, not a tool. The grain, stated by subtraction: take an ordinary
small Scheme and remove its ability to hide. Most of what makes a language big is hiding — a
produced `7` is opaque, it could have come from a config file, a database row, or thin air.
arrival is that default minus one bit; removing it costs almost nothing, because *hiding* is the
expensive feature, not *remembering*.

Little here is new, and that is the point. The reader that presents serialized text as structure
is a reader macro (McCarthy, 1965). The error that names the fix is the condition system (1974,
1984). Provenance riding values is a property list (1960). An environment that amends its own tool
signatures while running is the live image (1980). Interactive computing solved the agent's exact
problem — flattened text, no session, opaque errors, structure destroyed at every boundary —
between 1958 and 1984, and the industry stepped away from it when the web went stateless. The LLM
is the first new kind of user interactive computing has had since us; the fixes that survived
measurement turned out to already be on the shelf.

## Who this is for

You are building an LLM-agent system and you want the agent to *compute* — filter, map, compose,
pipe one tool's result straight into the next — inside a sandboxed symbolic medium, instead of
emitting a stream of opaque JSON tool calls. arrival gives the model an R7RS Scheme REPL with a
typed capability surface, a totalic JS interop membrane, value-level provenance, and static
validation that reports every error before anything runs. If you'd rather the agent's reasoning
and its executable program be the *same artifact* than translate English-reasoning into a
tool-call, this is for you.

## Quick Start

```bash
npm install @inhuman.tools/arrival
```

```typescript
import { exec } from '@inhuman.tools/arrival';

// One plain JS value per top-level form; the base assembles lazily on first call.
const [result] = await exec(`(filter (lambda (x) (> x 5)) (list 1 3 7 9 2))`);
console.log(result); // [7, 9]
```

## Tools — a typed capability in five lines

A tool is a declared symbol on an `EnvCapability`: a name, a doc line, a typed contract, an
implementation. `exec` assembles the capabilities per call and returns plain JS values — one per
top-level form.

```typescript
import { exec, EnvCapability, symbol, z } from '@inhuman.tools/arrival';

const weather = new EnvCapability("demo/weather", {
  symbols: {
    "forecast-for": symbol.rosetta`forecast-for: the current forecast for a city`(
      { input: [z.string], output: [z.string], provenance: "source" },
      async (city) => `cloudy in ${city}`,   // any real fetch goes here
    ),
  },
});

const [line] = await exec(`(string-append "today: " (forecast-for "berlin"))`,
                          { capabilities: [weather] });
// "today: cloudy in berlin"
```

The contract is enforced at the boundary in both directions. `provenance: "source"` declares the
lineage role: this verb introduces external data, so its results mint a fresh origin (a pure
transform declares `"pipe"` and forwards its inputs' lineage; `"source"` is the default). Writing
your own capabilities — the contract discipline, the lineage/cache axes, resources, MCP exposure —
is [`docs/writing-capabilities.md`](./docs/writing-capabilities.md).

## Data — a declared, typed program parameter

Data enters as a **declared, typed parameter of the program**. `define/overridable` names it,
gives it an `s/*` type and a default; the host supplies the value through `override`, validated
against the declared type at the membrane.

```typescript
const users = [{ id: "alice", priority: 15 }, { id: "bob", priority: 5 }];

const [, highPriority] = await exec(
  `(define/overridable users
     (s/array (s/object (s/field/string "id") (s/field/number "priority")))
     '())
   (filter (lambda (u) (> (@ u :priority) 10)) users)`,
  { override: { users } },
);
// [{ id: "alice", priority: 15 }]
```

Pass `override: {}` and the program runs on its declared defaults — it stays self-describing. A
value that doesn't match the declared type is rejected with a door naming the binding, the
expected shape, and who supplied it.

## Sessions — mint a scope, reuse it

Multi-turn agent sessions need no framework and no hidden layer: mint a scope, reuse it, and
top-level `define`s accumulate across calls.

```typescript
import { execState, schemeToJs, LexicalScope } from '@inhuman.tools/arrival';

const scope = LexicalScope.fresh("agent-session");             // the session's mutable frame
await execState(`(define (sq x) (* x x))`, { scope });         // turn 1 — defines land on the scope
const { values: [v] } = await execState(`(sq 7)`, { scope });  // turn 2 — sees turn 1's define
schemeToJs(v, {});                                             // 49
```

Sequence diagrams, budgets observed live, and the assemble-once/run-N-times idiom are in
[`docs/execution-sequences.md`](./docs/execution-sequences.md).

## The language

Honest, faithful R7RS — a subset by subtraction (no IO, no dynamics, no mutation), not a lookalike.
The reference suite is chibi-scheme's `r7rs-tests.scm`, run against arrival form-by-form
(`src/__tests__/scheme-compliance/conformance/`); a documented gap is an `it.fails` that flips loudly the day it's
fixed, never a silent skip (today: 651 forms green, 142 documented `it.fails` gaps, 289 exclusions
each naming the subtracted feature it exercises, of 1082 total).

The subset is deep where it counts: **proper tail calls** via a flat trampoline
(Ganz–Friedman–Wand), **multiple values** inside the runtime (user-facing binders doored by design
— free multi-return packaging is the weak form of continuation arity, and a value's identity is a
single construction site), the **full R7RS exception tower**, an **exact numeric tower**
(bigint-backed rationals — `(+ (/ 1 3) (/ 2 3))` is exactly `1`), **datum labels**. Twelve SRFIs
assemble by default (1, 2, 8, 13, 26, 28, 43, 95, 128, 151, 189, 235 — `src/env/srfi/`); the
deliberately-absent ones (hash tables, random, time/date, …) are doored stubs naming why they're
out and what to use instead — exactly the symbols an LLM agent predictably reaches for.

The language stance — an R7RS-small sandboxed base, a forgiving superset layered *under* strict
(never beside it), the reserved-zone rule keeping it non-conflicting with any SRFI — is the charter
in [`docs/design-history/language-design-foundations.md`](./docs/design-history/language-design-foundations.md);
read it before adding a reader macro, literal, or borrowing.

## The totalic membrane — JS is a peer, not a host

JS ↔ Scheme interop is a recursive wrapper membrane in the object-capability lineage
(Miller / Van Cutsem), member-read protocol modeled on GraalVM's `InteropLibrary`. The design goal
is *totality*: every value crosses faithfully or is refused with a teaching door — no value class
silently degrades.

- **Lambdas cross both directions.** A Scheme lambda exits as a callable async host function;
  host closures enter Scheme through the contract-aware `z.procedure` codec, which marshals each
  call per-argument.
- **Structures cross by borrowed identity.** A JS object or array enters as a thin,
  identity-cached wrapper whose members box lazily on first read (a huge host graph crosses
  zero-copy) and exits back to *the same reference*. Scheme values survive a host round-trip by
  identity too (`(eq? s (echo s))` ⇒ `#t`).
- **Promises are defanged, not banned.** An async return is awaited before it crosses; a Promise
  *inside* a structure settles lazily on first entry read; a bare Promise handed directly to the
  membrane gets a teaching door.
- **Refusals are loud.** A bare JS function crossing as a *value* (not through a contract)
  materializes as `#void` with a printed warning; unique JS symbols, having no portable identity,
  void loudly the same way. Registered symbols (`Symbol.for("status")`) enter as the keyword
  `:status`.

**JS sits beneath the language as a peer, not above it as a host** — no ambient `console`,
`process`, or `require` to escape to, so a real effect is always a recorded crossing, never a side
door. Every other claim here stands on that architectural fact as the *designed* boundary; at 0.x
the implementation still has known escapes ([Security Status](#security-status)), which are bugs
against this invariant, not sanctioned doors.

## Provenance — a second interpretation of the same program

The keystone principle ([`docs/PRINCIPLES.md`](./docs/PRINCIPLES.md) P0): the same program is run
by several interpreters that cannot drift. The value interpreter computes *what*; the provenance
interpreter computes *where from* in lock-step; the same lineage is also derivable *statically*
(`classify` / `fullCone`) and from the recorded trace — agreement between the interpretations is
enforced as a tested law, not assumed. That is why granular provenance does not cost the hot path:
it is a second interpretation, not instrumentation.

**The mint is trace-gated.** Pass a trace tap (`tap: new EvalTrace()`) when you mean to ask about
lineage; without one, every value's provenance reads `[]` while the values themselves look correct
(lineage is a property of *observed* runs — an audit pipeline that forgets the tap gets an empty
trail, not an error).

```typescript
import { execState, schemeToJs, deepProvenance } from '@inhuman.tools/arrival';
import { EvalTrace } from '@inhuman.tools/arrival/provenance';

const trace = new EvalTrace();
const { values: [line] } = await execState(
  `(string-append "today: " (forecast-for "berlin"))`,
  { capabilities: [weather], tap: trace },
);

[...deepProvenance(line)];    // [1] — the value confesses which crossing it descends from
trace.toolNameFor(1);         // "forecast-for" — the ordinal resolved to the minting verb
```

Join two sources and the origins **union**; a literals-only value has no origin (`[]`). Nobody
threads the origin by hand: a crossing stamps the value, a container threads its stamp into every
element read out of it, and a collapsing op (`string-append`, `join`) deep-walks its inputs so the
lineage survives even when the structure that carried it doesn't. Each declared symbol carries a
**provenance role** (`source` / `pipe` / `fan` / `sink` / `transparent` / `loop` / `opaque`), so
the lineage reading is declared per-verb, never guessed. The full design is
[`docs/PROVENANCE.md`](./docs/PROVENANCE.md).

### Run it backward

Because the lineage lives on the values, a finished run can be *reversed*: reverse-slice the trace
by a chosen value's provenance into a **minimal re-runnable program that re-derives exactly that
value** (the Galois-slicing `uneval` of Perera–Cheney; purity is the theorem that makes the least
slice exist).

```typescript
import { EvalTrace, buildUneval } from '@inhuman.tools/arrival/provenance';

const t = new EvalTrace();
const src = `
  (define chatter (string-append (chatter-feed) "!"))
  (define verdict (string-append "malware: " (scan-output)))
  (list verdict "benign")
`;
const state = await execState(src, { capabilities: [scanner], tap: t });

const run = buildUneval({ env: state.scope.env, result: state.values.at(-1), trace: t, source: src, forms: [] });
const head = await run.uneval('(car result)');

head.value;        // "malware: evil.exe"
head.provenance;   // [5] — descends from scan-output; chatter-feed never touched it
head.program;      // (define verdict (string-append "malware: " (scan-output)))
                   // (let ((result (list verdict "benign"))) (car result))
```

The unrelated `chatter` derivation is pruned; what remains is the backward dependence cone plus the
selector — a closed program a reviewer, or another agent, re-runs to re-derive the exact value
under question. (The slice is per top-level form today; intra-form slicing is next.)

### The seal, and its two limits

Built on the carried lineage: a **seal** walks every leaf of a result, checks that each traces to
a real source, and *mathematically refuses to sign* one that doesn't — a fabricated leaf has no
signature to give. With trace replay (`replayProgramWithPlayback`, the program re-run with every
membrane crossing answered from the recorded payload stream, the live world never consulted) this
composes into: an output either traces end-to-end (and a third party can re-derive it) or it has no
signature at all. What lives *here* is the boundary that makes this sound — the carrying above,
plus the **attestation brand** (the `/attestation` subpath): provenance unions forward, attestation
*drops on compute*, so an agent must re-assert what a derived value IS while reference-passing
preserves it for free. The whole-result walker `groundingVerdict` and the `whyOf` / `whereOf` /
`howOf` trace queries live one layer up, in `@inhuman.tools/arrival-provenance`.

Two limits, stated plainly:

1. It is a **lineage-completeness oracle, not a truth oracle** — a lying tool's answer traces
   perfectly and signs happily; what the seal forecloses is *unattributed* values, not wrong ones.
2. Replay never re-invokes a source — the frozen recorded payloads are authoritative — so replaying
   a run whose crossings include model calls stays exact only as long as those recorded results are
   retained; evict the cache and a fresh live run may diverge from what was signed.

## Polyglot by observation, not by design

**The dialect roster was reverse-engineered from LLM latent space, not designed.** It is a
measurement of what models trained on all of Lisp believe Scheme is, turned into a surface: agent
sessions are recorded, and every *phantom* (a verb the model confidently reached for that didn't
exist) is a logged feature request. It is still R7RS Scheme — only the behaviors undefined by spec
were enriched (PRINCIPLES P13).

```scheme
(->> {:versions (list {:state "draft"} {:state "live"})} :versions last :state)  ; "live"
(map (lambda (x) (* x x)) [1 2 3])                                               ; #(1 4 9)
(mapcar car (list (list 1) (list 2)))                                            ; (1 2)
```

Four dialect packs carry this (`src/env/polyglot*.ts`): Clojure, Racket, Common Lisp, and the
shared core — `{:key value …}` dicts, `[ … ]` vectors, the `(:key obj)` accessor, the `@` / `@?` /
`@keys` member-read protocol. All of it canonicalizes at read time; the verbs that *can't* carry
over honestly (`setf`, `loop`, …) aren't absent — they're doored, with the reason and the working
alternative.

## IO taken away — to come back with lineage

No ports, no filesystem, no clock, no `random`. Not as a security posture — as an *algebraic* one:
an ambient read has no construction site to root a value's lineage at, so admitting it would hole
the one guarantee the language makes (the full argument:
[`docs/design-history/why-no-io-dataflow-algebra.md`](./docs/design-history/why-no-io-dataflow-algebra.md)).
Effects come back in as capability verbs that mint provenance at the membrane — a filesystem read
is a recorded crossing that stamps its result, not a stream from nowhere.

## Errors are doors, not walls

Every deliberate omission names the fact, the reason, and the exact alternative bound in *this*
environment. The same discipline runs *before* execution: `exec(code, { staticValidation: "on" })`
checks the whole program against the assembled vocabulary and reports **every** problem at once,
eslint-style:

```
Static validation found 1 error — nothing was evaluated:
  • Unbound symbol `forecst-for` — did you mean `forecast-for`? Referenced at 1:19 — this
    program would crash there.
```

For an agent this compounds into **zero-round-trip self-repair**: every diagnostic arrives at once,
each carrying its alternative, so the crash-read-guess-crash loop collapses into one informed
retry. One scope limit: the pass cannot see the bindings a `(require …)` spills at runtime, so
consumers skip the pass for such programs (the runtime doors remain the backstop).

## API surface

**Execution**

- `exec(code, options?) → Promise<unknown[]>` — parse + run, results unwrapped to plain JS.
- `execState(code, options?) → Promise<ExecState>` — boxed, provenance-bearing `values` plus the
  session `scope` handle for REPL-style continuation, and the run's `runCtx`.
- `ExecOptions`: `capabilities` (assembled per call), `config` (the shared bag capabilities read),
  `override` (host values for `define/overridable` parameters), `scope` (a `LexicalScope`;
  `.fresh()` mints an isolated session), `staticValidation: "on" | "off"`, `signal`, `budgetMs` /
  `heapBudget` (opt-in wall-clock / allocation bounds; `signal` is the one that reaches into native
  calls), `strict` (turns off nil-tolerance, caller-scoped), `freezeRosettaReturns`, `tap` (trace
  recording), `env` (the lower-level glass path).
- `parse(code)`, `tokenize(source)` — the reader, standalone.
- `initBridge()` — pre-warm the lazily assembled base.

**Declaration**

- `EnvCapability`, `assembleEnv`, the `symbol` factory namespace (`symbol.native`, `symbol.rosetta`,
  `symbol.define`, `symbol.defineSyntax`, `symbol.tagless`, `symbol.notImplemented`, …), and the `z`
  scheme-zod codec namespace (`z.string`, `z.number`, `z.value`, `z.box`, `z.procedure(in?, out?)`,
  …). Every capability — the R7RS base, each SRFI, each dialect pack, your tools — is an
  `EnvCapability`; `assembleEnv` C3-linearizes the dependency DAG (the same monotonic linearization
  Python uses for MRO), dedups by identity, detects cycles, applies each pack once, disposes LIFO.

**Static analysis & provenance**

- `validateProgram` / `vocabularyFromChain` — the complete-diagnostic-list validation pass.
- `classify`, `fullCone`, `fieldCone` — the static lineage carrier; `deepProvenance` — the deep
  provenance read; `schemeToJs` — the boxed→plain exit read.
- `EvalTrace` / `buildUneval` (from `/provenance`) — the traced-run recorder and reverse slicer;
  `trace.toolNameFor(id)` / `trace.invocationById(id)` resolve a `deepProvenance` ordinal to the
  verb / invocation that minted it; `replayProgramWithPlayback` — the recorded-payload replay
  driver.

**Subpath exports** — granular, tree-shaken entries: `/oracle`, `/type-layer`, `/symbol`,
`/scheme-zod`, `/schema-tag`, `/provenance`, `/srfi`, `/capability`, `/env`, `/resources`,
`/scheme-env`, `/attestation`, `/overridable`, `/schema`.

**Decomposed processing** — for cases the three declared doors (`capabilities` / `override` /
`scope`) don't cover, the `/env` subpath carries the explicit phase products: `assembleAmbient`
assembles a capability base once (an `AssembledAmbient`, caller-owned, `AsyncDisposable`) and
`exec`/`execState(code, { ambient, scope })` reuses it across many runs. `LexicalScope.fresh()`
mints the session's mutable frame; its `.env` satisfies the structural `SchemeEnv` write contract,
so a session owner can register pack vocabulary against the frame it holds. Glass `{ env }` remains
only for embedder-held frames.

## The wider toolchain

Sibling packages build an editing and serving stack over the language; each has its own README.

| Package | What it is |
|---|---|
| `@inhuman.tools/arrival-lsp` | Scheme→TypeScript type lens as a language service — programs lower into a typed TS view against a declaration-merged prelude, `tsc` checks it, diagnostics lift back to `.scm` spans. Contracts get generics for free (a contract's `type` field carries the full TS signature language). `SchemeLanguageService`: diagnostics, hover, completions, goto, semantic tokens; in-process or behind a worker so `tsc` never blocks the editor. |
| `@inhuman.tools/arrival-codemirror` | CodeMirror 6 plugin: language modes for classic Scheme and Sugarcoat, `schemeIde(backend)`, paredit-style structural editing over the real reader with a verify-reparse net, inlay hints, `schemeGhost` inline completion. |
| `@inhuman.tools/arrival-sugarcoat` | Bidirectional lens over canonical s-expressions — renders Scheme as JS/Python/Kotlin-shaped syntax and folds edits back losslessly (`ast(sugarcoatToScheme(schemeToSugarcoat(x), x)) ≡ ast(x)`). Ships the runtime-free reader (`parseSexprs` / `printScheme`), a TextMate grammar, `GRAMMAR.md`, and the 5-minute tour `LEARN.md`. |
| `@inhuman.tools/arrival-sampler` | Constrained-decode consumer of `/oracle`: substrate-free mask kernel, Σ∩T type-lens narrowing, node-llama-cpp wiring, an OpenAI-compatible server. The mask kernel is tested; decode strategies keep the *experimental* tag. |
| `@inhuman.tools/arrival-provenance` | Read-only trace analysis: `groundingVerdict`, the `whyOf` / `whereOf` / `howOf` queries, render-models. |
| `@inhuman.tools/arrival-mcp` | The language as an MCP surface — discovery/action tools over the same capability envs, serializer budgets on every result. |
| `@inhuman.tools/arrival-manifold` | N MCP servers → one `scheme-repl` tool (the measured benchmark below). |
| `@inhuman.tools/arrival-serializer` | Budget-bounded rendering: under a budget, per-element caps shrink fairly across siblings and re-render — never a tail-cut. |

The oracle (`@inhuman.tools/arrival/oracle`) exposes the interpreter's own knowledge — structural
validity and the bound-symbol set (Σ) — as a truncation-safe scanner. Under it an unbalanced
program is *ungeneratable*; with a grant env, an unbound symbol is *ungeneratable*; against the
capability DAG, an ungranted tool is **unwritable at generation time** — containment moves from the
sandbox into the decoder. The type layer (`@inhuman.tools/arrival/type-layer`) prints harvested
signatures as TypeScript so the schema cannot drift: wire schema, runtime validator, and static
type are three projections of one contract term.

## Does the medium measurably help?

`@inhuman.tools/arrival-manifold` collapses N upstream MCP servers' per-tool JSON-schema tools into
one `scheme-repl` tool whose argument is an arrival program. On **MCP-Atlas** (89 grounded
multi-server tasks × 15 runs per configuration, LongCat-2.0 as judge, per-task fixed effects +
paired contrasts, post-neutralization, strictly neutral client):

| Arm | Coverage | Pass | Token cost |
|---|---|---|---|
| Best native (per-tool JSON calling, `native-5k`) | 0.658 | 56.2% | 1.0x (baseline) |
| Best scheme-REPL proxy (strictly neutral client) | 0.72–0.73 | 62–63% | ~1.15–1.25x |
| **Delta** | **+7pt** | **+6pp** | **+15–25%** |

Composing multiple tool calls inside one program eliminates round-trips a schema-constrained native
call can't avoid — pipe a result straight into the next, filter/reduce before it re-enters the
transcript — so the token surcharge buys task completion, not verbosity. The noise floor is real
and no single run can be trusted alone; the full methodology is in
`@inhuman.tools/arrival-manifold`'s own README.

## Security Status

⚠️ **version 0.x — use at your own risk**

arrival's base reaches nothing ambient by construction — no filesystem, no process, no network, no
host globals (`window` / `global` / `process` / `require`). But at 0.x, sandbox escape is still
feasible — at least via property access and some rosetta-layer aspects — so do not yet treat the
isolation as a hard security boundary for untrusted input.

One shared-state default hosts must know: bare `exec` calls (no explicit `scope`) land their
top-level `define`s on a realm-cached default root, so definitions accumulate across calls within
the process — the documented session semantic for a single-tenant REPL, and the wrong default for a
multi-tenant host. Give every tenant its own `LexicalScope.fresh()` (or a per-tenant assembled
ambient); without one, one tenant's program can read and clobber another's top-level bindings.

**Do not**: expose to untrusted user input without additional isolation; use in security-critical
contexts; deploy without containerization; trust sandbox isolation.

Responsible disclosure and collaboration on improvements: security@here.build

## Performance

Interpretation costs roughly 10–100× native JS — worth it for isolation, compositional
expressiveness, and lineage; not worth it for CPU-bound number crunching. Register
performance-critical functions as capability verbs and keep Scheme for orchestration. arrival is
simultaneously a runtime and an IR — designed to be compilable *toward* JavaScript — so raw speed is
the *target's* concern and interpretation cost stays an authoring-time property, not the ceiling.

## Design foundations

- [`docs/PRINCIPLES.md`](./docs/PRINCIPLES.md) — the governing principles: the two-interpreter
  keystone, the value plane, the membrane, provenance, the surface rules.
- [`docs/PROVENANCE.md`](./docs/PROVENANCE.md) — the provenance substrate in full.
- [`docs/design-history/language-design-foundations.md`](./docs/design-history/language-design-foundations.md)
  — the language charter; read before adding a reader macro, literal, or borrowing.
- [`docs/writing-capabilities.md`](./docs/writing-capabilities.md) — authoring your own capabilities.

## Why Scheme for AI Agents?

Scheme matches how compositional reasoning works: an agent exploring data ("find all items where
priority > threshold") thinks in filter/map/compose, and Scheme is the notation for that.
Sandboxing prevents exploration from accidentally executing actions.

### Prior art

The stance — *symbolic programming as the reasoning medium, not static tool-calling* — is argued
independently in Jordi de la Torre, [*From Tool Calling to Symbolic Thinking: LLMs in a Persistent
Lisp Metaprogramming Loop*](https://arxiv.org/abs/2506.10021) (arXiv:2506.10021, 2025): embed Lisp
in generation, intercept it through a **middleware layer**, give the model a **persistent REPL** in
which it defines, invokes, and evolves its own tools. That paper offers *design principles*; arrival
is the built system. Its middleware layer is our membrane (`@`); its persistent REPL is the per-run
capability environment; its "evolve your own tools" is the capability DAG. Where it leaves the
environment open, arrival's base is sandboxed, no-IO, and R7RS-faithful — the boundary that makes a
self-evolving symbolic loop safe to run.

## Contributing

Early-stage and moving fast. We're interested in: **security review** (audit sandbox isolation),
**performance benchmarks**, **conformance** (grow the Chibi-suite pass set; every flipped `it.fails`
is a gift), and **doors** (find a dead-end error, turn it into a teaching door).

## License

**[FSL-1.1-MIT](./LICENSE.md)** — Functional Source License 1.1, MIT Future License. Each version
converts to MIT two years after its release date. Until conversion, the license permits everything
*except* Competing Use (making the Software available in a commercial product or service that
substitutes for the Software or offers substantially similar functionality). Internal use,
non-commercial education and research, and professional services built on top of the Software are
always permitted.

**What Competing Use means here, in plain words** (a clarification of intent, not a legal instrument
— the license text governs): the one reserved lane is **providing services around custom
AI-participating workflows in a self-service way** — a product whose *customers* build their own
pipelines on arrival (a hosted pipeline-builder). That is the product we are building ourselves.
Everything else is yours, explicitly:

- **Your own agentic pipelines** — personal, team, or company-internal, at any scale, including an
  internal platform where your own engineers build pipelines: **fair use, always.**
- **Agency / consulting work** — building bespoke pipelines *for* clients is professional services,
  always permitted.
- **Agents as users** — an agent building pipelines (via MCP or otherwise) acts on behalf of its
  operator; its operator's pipelines are personal use.

The test in one question: **who types the pipeline?** You or your engineers (for yourselves or a
client) — fair. Your customers, into your product — the reserved lane, for now.

Two standing commitments: clarifications of this boundary only ever *widen* fair use, never narrow
it retroactively — gray area? Ask, answers are public and bind us. And the reservation is a head
start, not a moat: every release MITs on its own two-year clock, and we are open to conversations
about converting the project to full MIT sooner.

arrival grew out of [LIPS.js](https://github.com/jcubic/lips) by Jakub T. Jankiewicz (MIT licensed),
and its copyright notices are preserved in the source where shared code — the reader and tokenizer —
remains. The interpreter itself is a ground-up rewrite: the term algebra, the trampoline-generator
kernel, the rosetta membrane, the capability environment, and the provenance substrate share no code
with LIPS.

For licensing questions, exemptions, or clarifications: team@here.build
