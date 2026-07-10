# @here.build/arrival

**The first ever language built for AI[^1], finally built for AI.** 


[^1]: Lisp was born in 1958 for AI research — the first language built *for* AI. arrival is a
    Lisp finally built for AI *as the user*: the agent writes the programs. ![Elegant weapons,
    for a more civilized age.](https://imgs.xkcd.com/comics/lisp_cycles.png)

Arrival is a programming medium, not a tool. The grain, stated by subtraction: take an ordinary
small Scheme and remove its ability to hide — where a value came from, what a tool call was, what
crossed the boundary. Most of what makes a language big is hiding: a produced value is an opaque
`7` that could have come from a config file, a database row, or thin air — opacity so total it's
invisible. arrival is that default, minus one bit; removing it costs almost nothing, because
*hiding* is the expensive feature, not *remembering*.

That subtraction pays out as several distinct claims, each demonstrated below against the shipped
package (every example on this page was executed as written; outputs are real):

1. [**Simple and friendly — while strict and formal.**](#simple-and-friendly--while-strict-and-formal)
   A typed tool in five lines, run in one call — on an R7RS subset proven against chibi's suite.
2. [**A totalic membrane.**](#the-totalic-membrane--everything-crosses) Everything crosses or is
   refused loudly: lambdas both directions, structures by borrowed identity, promises defanged.
3. [**Provenance penetrates that membrane.**](#provenance-penetrates-the-membrane) Every value
   remembers its origin, and a finished run reverses into the program that re-derives any value.
4. [**Polyglot by observation.**](#polyglot-by-observation-not-by-design) The extended dialect surface was
   reverse-engineered from LLM latent space, not designed.
5. [**An IDE stack.**](#an-ide-not-just-an-interpreter) A Scheme→TypeScript type lens where `tsc`
   is the checker, wired into a CodeMirror plugin with paredit-style structural editing.
6. [**A human-readable face.**](#sugarcoat--the-reversible-human-face) Sugarcoat renders stored
   s-expressions as JS/Python-shaped syntax and folds edits back losslessly.

And one measurement: the medium [demonstrably improves agent task completion](#does-the-medium-measurably-help)
on a grounded multi-server MCP benchmark — the claim is quantified, not vibes.

## Simple and friendly — while strict and formal

A tool is a declared symbol on an `EnvCapability`: a name, a doc line, a typed contract, an
implementation. `exec` assembles the capabilities per call and returns plain JS values — one per
top-level form. This is the whole registration ceremony:

```typescript
import { exec, EnvCapability, symbol, z } from '@here.build/arrival';

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

The contract is enforced at the boundary in both directions, and `provenance: "source"` declares
the lineage role — this verb introduces external data, so its results mint a fresh origin (a pure
transform declares `"pipe"` and forwards its inputs' lineage; `"source"` is the default).

Data enters the same way — as a **declared, typed parameter of the program**. `define/overridable`
names it, gives it an `s/*` type and a default, and the host supplies the value through `override`;
it is validated against the declared type at the membrane:

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

The program stays self-describing — pass `override: {}` and it runs on its declared defaults — and
a value that doesn't match the declared type is rejected with a door naming the binding, the
expected shape, and who supplied it (`define/overridable p: expected string, got {} (from an
environment override)…`).

The *friendly* half is not at strictness's expense. The language under these calls is honest,
faithful R7RS — a subset by subtraction (no IO, no dynamics, no mutation), not a lookalike — with
the reference suite borrowed from the implementation the spec's own community trusts:
chibi-scheme's `r7rs-tests.scm` runs against arrival form-by-form (`src/__tests__/conformance/`);
a documented gap is an `it.fails` that flips loudly the day it's fixed, never a silent skip. And
the subset is deep where it counts: **proper tail calls** via a flat trampoline
(Ganz–Friedman–Wand), **multiple values**, the **full R7RS exception tower**, an **exact numeric
tower** (bigint-backed rationals — `(+ (/ 1 3) (/ 2 3))` is exactly `1`, not `0.999…`), **datum
labels**. Real Scheme from the wider ecosystem is usable, not merely "inspirational": twelve
SRFIs assemble by default (1, 2, 8, 13, 26, 28, 43, 95, 128, 151, 189, 235 — `src/env/srfi/`);
the deliberately-absent ones (hash tables, random, time/date, …) are doored stubs naming why
they're out and what to use instead — exactly the symbols an LLM agent predictably reaches for.

Sessions, REPL-style accumulation, scope handles, and the execution budgets are their own short
read: [`docs/execution-sequences.md`](./docs/execution-sequences.md).

## The totalic membrane — everything crosses

JS ↔ Scheme interop is a recursive wrapper membrane in the object-capability lineage
(Miller / Van Cutsem), member-read protocol modeled on GraalVM's `InteropLibrary`. The design
goal is *totality*: every value crosses faithfully or is refused with a teaching door — no value
class silently degrades. Executed evidence:

**Lambdas cross both directions.** A Scheme lambda exits as a callable (async) host function —
``const [double] = await exec(`(lambda (x) (* x 2))`)`` hands back a real function, and
`await double(21)` is `42`. Callables also cross *into* host implementations — and back out of
them — through the contract-aware `z.procedure` codec, which marshals each call per-argument:

```typescript
const hof = new EnvCapability("demo/hof", {
  symbols: {
    "apply-twice": symbol.rosetta`apply-twice: call f on x, twice`(
      { input: [z.procedure(z.number, z.number), z.number], output: [z.number] },
      async (f, x) => (await f(await f(x))) as number,   // f IS a callable here
    ),
    "make-adder": symbol.rosetta`make-adder: a host closure that adds n`(
      { input: [z.number], output: [z.procedure(z.number, z.number)] },
      async (n) => async (x) => (x as number) + n,       // host closure enters scheme
    ),
  },
});

await exec(`(apply-twice (lambda (n) (+ n 10)) 1)`, { capabilities: [hof] });  // [21]
await exec(`((make-adder 5) 37)`, { capabilities: [hof] });                    // [42]
```

**Structures cross by borrowed identity.** A JS object or array enters as a thin, identity-cached
wrapper whose members box lazily on first read — a huge host graph crosses zero-copy — and exits
back to *the same reference*. Scheme values survive a host round-trip by identity too:

```typescript
// (the-payload) hands a host object across; echo pipes it out and back.
const [back] = await exec(`(echo (the-payload))`, { capabilities: [echo, p] });
back === payload;   // true — the borrowed wrapper unwrapped to its source

await exec(`(define s 'alpha) (eq? s (echo s))`, { capabilities: [echo] });   // #t
```

**Promises are defanged, not banned.** An async implementation's return is awaited before it
crosses (plain JS semantics); a Promise *inside* a structure settles lazily on first entry read —
an impl returning `{ user: Promise<string> }` still answers `(@ (user-row) :user)` with
`"carol"` — and a bare Promise handed directly to the membrane gets a teaching door, not a
mystery (the `override` example above doors the same way if handed a pending Promise).

**Refusals are loud.** A bare JS function crossing as a *value* (not through a contract) would be
an untraceable escape hatch, so it materializes as `#void` with a printed warning naming exactly
what happened. Registered JS symbols (`Symbol.for("status")`) enter as the keyword `:status`;
unique symbols, having no portable identity, void loudly the same way.

Critically, JS sits **beneath the language as a peer, not above it as a host** — no ambient
`console`, `process`, or `require` to escape to, so a real effect is always a recorded crossing,
never a side door. Every other claim on this page stands on that architectural fact.

## Provenance penetrates the membrane

Give a value a source and every derivation remembers it — across the membrane, through
containers, past collapsing ops. The source verb from the first example is already the whole
setup; attach a trace tap and read the lineage off the values themselves:

```typescript
import { execState, schemeToJs, deepProvenance } from '@here.build/arrival';
import { EvalTrace } from '@here.build/arrival/provenance';

const trace = new EvalTrace();
const { values: [line] } = await execState(
  `(string-append "today: " (forecast-for "berlin"))`,
  { capabilities: [weather], tap: trace },
);

schemeToJs(line, {});         // "today: cloudy in berlin"
[...deepProvenance(line)];    // [1] — the value confesses which crossing it descends from
```

Join two sources and the origins **union** — `(string-append (forecast-for "berlin") " / "
(forecast-for "tokyo"))` carries `[1, 2]` — while a literals-only value has no origin to confess
(`[]`). Nobody threads the origin by hand: a crossing stamps the value, a container threads its
stamp into every element read out of it, and a collapsing op (`string-append`, `join`) deep-walks
its inputs so the lineage survives even when the structure that carried it doesn't. (The mint is
trace-gated: lineage is a property of *observed* runs — attach the tap when you mean to ask.)

And the part that sounds impossible: granular provenance normally costs you the hot path. Here
it doesn't, because provenance is not instrumentation — it is a *second interpretation of the
same program* (the keystone principle, [`docs/PRINCIPLES.md`](./docs/PRINCIPLES.md) P0): the
value layer computes *what*, the box layer *where from*, and the same lineage is also derivable
*statically* (`classify` / `fullCone`, exported) and from the recorded trace — agreement between
the interpretations enforced as a tested law, not assumed.

### Then run it backward

Because the lineage lives on the values, a finished run can be *reversed*: reverse-slice the
trace by a chosen value's provenance into a **minimal re-runnable program that re-derives exactly
that value** (the Galois-slicing `uneval` of Perera–Cheney; purity is the theorem that makes the
least slice exist). This runs, today:

```typescript
import { EvalTrace, buildUneval } from '@here.build/arrival/provenance';

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

The unrelated `chatter` derivation is pruned; what remains is the backward dependence cone plus
the selector — a closed program a reviewer, or another agent, re-runs to re-derive the exact
value under question. "Why did you conclude X?" stops being post-hoc narration and becomes a
derivation you can hand over. (The slice is per top-level form today; intra-form slicing is next.
`buildUneval` still takes the run's scope frame — `state.scope.env` — as its one
below-the-program argument; that surface is converging as the environment privatization lands.)

### Then build the thing only you can see

We built it and the first thing that fell out was a **seal** — a verdict that walks every leaf of
a result, checks that each one traces to a real source, and *mathematically refuses to sign* one
that doesn't. Not a lint pass you can disable: a fabricated leaf has no signature to give, because
grounding is read per-leaf off the lineage the value already carries. With trace replay
(`src/provenance/replay.ts` — every crossing answered from the recorded payload stream, the live
world never consulted) this composes into a property nothing bolt-on offers: an output either
traces end-to-end — and a third party can re-derive it — or it has no signature at all. The
whole-result walker and the `whyOf` / `whereOf` / `howOf` queries live one layer up
(`@here.build/arrival-chain`, the sift work); what lives *here* is the boundary that makes them
sound — the carrying above, plus the **attestation brand** (`src/values/attestation.ts`): where
provenance unions forward, attestation *drops on compute*, so an agent must re-assert what a
derived value IS while reference-passing preserves it for free.

Two limits, stated plainly, because the seal invites overreading. First: it is a
**lineage-completeness oracle, not a truth oracle** — a lying tool's answer traces perfectly and
signs happily; what the seal forecloses is *unattributed* values, not wrong ones. Second: replay
never re-invokes a source — the frozen recorded payloads are authoritative — so replaying a run
whose crossings include model calls stays exact only as long as those recorded results are
retained; evict the cache they live in and a fresh live run may diverge from what was signed.

## Polyglot by observation, not by design

The thesis first, because without it this section reads as trivia: **the dialect roster was
reverse-engineered from LLM latent space, not designed.** It is a measurement of what
models trained on all of Lisp believe Scheme is, turned into a surface. It is still R7RS Scheme;
only the behaviors undefined by spec were enrichened to make the runtime polyglot. A model reaches for
Clojure's threading in one breath and CL's `mapcar` in the next; arrival meets the guess instead
of punishing it:

```scheme
(->> {:versions (list {:state "draft"} {:state "live"})} :versions last :state)  ; "live"
(map (lambda (x) (* x x)) [1 2 3])                                               ; #(1 4 9)
(mapcar car (list (list 1) (list 2)))                                            ; (1 2)
```

Four dialect packs carry this (`src/env/polyglot*.ts`): Clojure (`->` / `->>`, `comp`, `get-in`,
`zipmap`, …), Racket (`~>` / `~>>`, the `dict-*` family), Common Lisp (`mapcar`, `remove-if`, …),
and the shared core — `{:key value …}` dicts, `[ … ]` vectors, the `(:key obj)` accessor, the
`@` / `@?` / `@keys` member-read protocol. All of it canonicalizes at read time and stays
R7RS-compliant — borrowings are admitted only where R7RS leaves behavior undefined (PRINCIPLES
P13); the verbs that *can't* carry over honestly (`setf`, `loop`, …) aren't absent — they're
doored, with the reason and the working alternative.

## An IDE, not just an interpreter

Two sibling packages turn the language into an editing experience, and both are real today:

**`@here.build/arrival-type-lens`** is the Scheme→TypeScript type lens as a language service.
Scheme programs lower into a typed TS view against a declaration-merged prelude (one `.d.ts` leaf
per builtin), `tsc` checks that view, and diagnostics lift back to their `.scm` spans — `(car 5)`
produces a real type error without arrival growing a type checker. And because the checker is
`tsc`, contracts get **generics for free**: a contract's optional `type` field carries the full
TypeScript signature language, so the stdlib declares `map` as
`<R>(fn: (...args) => R, ...lists) => R[]` and `list-ref` as `<T>(index: number, list: T[]) => T
| null` — zod validates the monomorphic runtime at the membrane, the declared signature gives the
lens real parametric polymorphism, and the harvest prefers the declared form over the
schema-derived one. `SchemeLanguageService` is the
familiar IDE verb set in Scheme coordinates: semantic diagnostics, hover, completions (including
a completion-*context* API driven by the same Σ∩T machinery that masks the sampler's logits),
go-to-definition, semantic tokens. It runs in-process, or behind a provided worker/SharedWorker
protocol (`ls-client` / `ls-server`) so `tsc` never blocks an editor's main thread.

**`@here.build/arrival-codemirror`** is the CodeMirror 6 plugin that consumes it: language modes
for classic Scheme and Sugarcoat; `schemeIde(backend)` bundling linter squiggles, hover,
completion, goto, and semantic highlight; **paredit-style structural editing** (expand/contract,
slurp, barf, kill-sexp) over the real reader with a verify-reparse net so a structural op can
never corrupt the buffer; parameter inlay hints; and `schemeGhost` — inline ghost completion,
Tab to accept. Honest edges: full IDE on Sugarcoat buffers awaits span mapping between the two
faces (edits forward to canonical Scheme today); structural ops are classic-only by design.

## Sugarcoat — the reversible human face

`@here.build/arrival-sugarcoat` is a bidirectional lens over canonical s-expressions: the stored
form is always Scheme; Sugarcoat renders it as syntax a JS/Python/Kotlin programmer parses at a
glance — indentation-structured, curly-infix, subscripts, method chains, the `it` pronoun, dict
literals, at-expressions — and folds human edits back losslessly:

```
canonical: (map (lambda (it) (:family (normalize (car it)))) evidence)
sugarcoat: evidence.map{ it[0].normalize[:family] }
```

The guarantee is the round-trip law: `ast(sugarcoatToScheme(schemeToSugarcoat(x), x)) ≡ ast(x)`,
verified by round-tripping a real program corpus; saving an unedited view writes back identical
bytes. The original driver is AI–human collaboration — the LLM writes canonical Scheme, the editor
sweetens it for the person reviewing, their tweaks convert back; neither side ever holds a lossy
translation of the other's work. The package also ships the runtime-free s-expression reader
(`parseSexprs` / `printScheme`) half the toolchain uses to parse Scheme without evaluating it, a
TextMate grammar (`editors/`), and the formal grammar (`GRAMMAR.md`). The 5-minute syntax tour is
[`LEARN.md`](../arrival-sugarcoat/LEARN.md).

## Does the medium measurably help?

Yes — measured, with the noise floor stated. `@here.build/arrival-manifold` collapses N upstream
MCP servers' per-tool JSON-schema tools into one `scheme-repl` tool whose argument is an arrival
program. On **MCP-Atlas** (89 grounded multi-server tasks × 15 runs per configuration, LongCat-2.0
judge, per-task fixed effects + paired contrasts, post-neutralization, strictly neutral client):

| Arm | Coverage | Pass | Token cost |
|---|---|---|---|
| Best native (per-tool JSON calling, `native-5k`) | 0.658 | 56.2% | 1.0x (baseline) |
| Best scheme-REPL proxy (strictly neutral client) | 0.72–0.73 | 62–63% | ~1.15–1.25x |
| **Delta** | **+7pt** | **+6pp** | **+15–25%** |

Composing multiple tool calls inside one program eliminates round-trips a schema-constrained
native call can't avoid — pipe a result straight into the next call, filter/reduce before it ever
re-enters the transcript — so the token surcharge buys task completion, not verbosity. The noise
floor is real and no single run can be trusted alone; the methodology (and the forensics on the
pre-neutralization runs) is in
[`arrival-manifold`'s README](../../../second-foundation/arrival-manifold/README.md). A +7pt
shift on a grounded benchmark is as heavy a claim as anything above — it gets the same treatment.

## What's in the box

The claims above ride on a load-bearing stack; several pieces below are the reason the headlines
are possible at all.

### Everything is a pack — the C3 capability DAG

Every capability — the R7RS base, each SRFI, each dialect pack, your tools — is an
`EnvCapability`: a named, dependency-carrying, async contribution. `assembleEnv` C3-linearizes the
dependency DAG (the same monotonic linearization Python uses for MRO — cited, not invented),
dedups by identity, detects cycles, applies each pack once, disposes LIFO. The dep edge *is* the
capability grant; the base stdlib itself is assembled from the same packs you write.

### IO taken away — to come back with lineage

No ports, no filesystem, no clock, no `random`. Not as a security posture — as an *algebraic* one:
an ambient read has no construction site to root a value's lineage at, so admitting it would hole
the one guarantee the language makes (the full argument:
[`why-no-io-dataflow-algebra.md`](../../../docs/foundations/arrival-scheme/why-no-io-dataflow-algebra.md)).
Effects come back in as capability verbs that mint provenance at the membrane — a filesystem read
is a recorded crossing that stamps its result, not a stream from nowhere.

### One program, many interpreters

The same program is executed by several interpreters at once, and they cannot drift: the value
interpreter computes *what*, the provenance interpreter computes *where from* in lock-step, and
further interpreters read the same terms statically — the type lens, the static lineage
classifier, the sampler oracle's feasibility layers. N interpretations of one program, held in
agreement by tested laws — the whole architecture in one sentence (the keystone principle,
[PRINCIPLES P0](./docs/PRINCIPLES.md)). Every declared symbol also carries a **provenance role**
(`source` / `pipe` / `fan` / `sink` / `transparent` / `loop` / `opaque`), so the lineage reading
is declared per-verb, never guessed.

### Errors are doors, not walls

Every deliberate omission names the fact, the reason, and the exact alternative bound in *this*
environment — reach for a file port and the door routes you to the filesystem tool actually bound
here. The same discipline runs *before* execution: `exec(code, { staticValidation: "on" })`
checks the whole program against the assembled vocabulary and reports **every** problem at once,
eslint-style:

```
Static validation found 1 error — nothing was evaluated:
  • Unbound symbol `forecst-for` — did you mean `forecast-for`? Referenced at 1:19 — this
    program would crash there.
```

A missing capability is likewise diagnosed as a configuration fact, not a mystery. For an agent
this compounds into **zero-round-trip self-repair**: every diagnostic arrives at once, each
carrying its alternative — the crash-read-guess-crash loop collapses into one informed retry.

### A Curry-Howard type layer, in a language never designed for one

Every symbol is declared with a contract — `{ input: [z.string], output: [z.number] }` — through
the `scheme-zod` codec vocabulary; the schema DSL (`s/object`, `s/array`, `s/enum`, …) is the
language's explicit-type syntax. A schema tag is a *proposition* discharging three ways from one
canonical lowering: a runtime validator (zod), a wire schema (JSON Schema for structured
outputs), and a static projection — `@here.build/arrival/type-layer` prints harvested signatures
as TypeScript, so the checker is `tsc` itself. A side effect worth naming: **the schema cannot
drift** — wire schema, validator, and static type are three projections of one term.

### The oracle — the interpreter wired into the sampler

`@here.build/arrival/oracle` exposes the interpreter's own knowledge — structural validity and
the bound-symbol set (Σ) — as a **truncation-safe scanner**: pure, O(n), single pass, an
unterminated string a reported state, never a throw — what a constrained decoder consulting it
token-by-token needs. Under it an unbalanced program is *ungeneratable*; with a grant env, an
unbound symbol is *ungeneratable*. Against the capability DAG that reads: an ungranted tool is
**unwritable at generation time** — containment moves from the sandbox into the decoder. The
consumer is `@here.build/arrival-sampler` (substrate-free mask kernel, Σ∩T type-lens narrowing,
node-llama-cpp wiring, an OpenAI-compatible server); the mask kernel is tested machinery, the
decode strategies riding it keep the *experimental* tag.

### Boundable execution — the knobs

Execution is **boundable, not bounded by default** — and the default is stated on the tin.
`signal` (an `AbortSignal`) makes any run killable, always; `budgetMs` is an opt-in internal
wall-clock bound (the trampoline throws when it elapses); `heapBudget` is an opt-in allocation
cap charged at the collection-op choke points — the bound an O(n²)-churn loop actually hits. All
three observed with real errors in [`docs/execution-sequences.md`](./docs/execution-sequences.md).
Two more knobs change the interpretation itself: `strict: true` turns off nil-tolerance
(caller-scoped — a strict host and a forgiving REPL coexist), `freezeRosettaReturns` freezes
borrowed JS sources at the membrane.

### And a shelf that earns its weight

| | |
|---|---|
| First-class special forms | special-ness travels with the keyword *value* — `(define => lambda)` aliases a form; full lexical shadowing is a documented gap, not a silent wrong answer |
| Replay drivers | re-run a traced program with every membrane crossing answered from the recorded payload stream (`src/provenance/replay.ts`) |
| Trace analysis stack | flow graphs, region folds, span attribution, MDL trace collapse — the trace is a queryable artifact, not a log (`src/provenance/`) |
| `@here.build/arrival-serializer` | budget-bounded rendering: under a budget, per-element caps shrink fairly across siblings and re-render — never a tail-cut, every reduction signaled inline |
| `@here.build/arrival-mcp` | the language as an MCP surface — discovery/action tools over the same capability envs, serializer budgets on every result |
| `@here.build/arrival-manifold` | N MCP servers → one scheme-REPL tool (the measured claim above) |

## Quick Start

```bash
npm install @here.build/arrival
```

```typescript
import { exec } from '@here.build/arrival';

// One plain JS value per top-level form; the base assembles lazily on first call.
const [result] = await exec(`(filter (lambda (x) (> x 5)) (list 1 3 7 9 2))`);
console.log(result); // [7, 9]
```

From here: tools — `EnvCapability` + `symbol.rosetta` (first section); data —
`define/overridable` + `override`; sessions — `execState` + `scope`
([`docs/execution-sequences.md`](./docs/execution-sequences.md)); lineage — `execState` + `tap`
(provenance section).

## API surface

**Execution**

- `exec(code, options?) → Promise<unknown[]>` — parse + run, results unwrapped to plain JS.
- `execState(code, options?) → Promise<ExecState>` — boxed, provenance-bearing `values` plus the
  session `scope` handle for REPL-style continuation, and the run's `runCtx`.
- `ExecOptions`: `capabilities` (assembled per call), `config` (the shared bag capabilities
  read), `override` (host values for `define/overridable` parameters), `scope` (a `LexicalScope`;
  `.fresh()` mints an isolated session), `staticValidation: "on" | "off"`, `signal`,
  `budgetMs` / `heapBudget`, `strict`, `freezeRosettaReturns`, `tap` (trace recording), `env`
  (the lower-level glass path — the corner below).
- `parse(code)`, `tokenize(source)` — the reader, standalone.
- `initBridge()` — pre-warm the lazily assembled base (it otherwise assembles on first `exec`).

**Declaration**

- `EnvCapability`, `assembleEnv`, the `symbol` factory namespace (`symbol.native`,
  `symbol.rosetta`, `symbol.define`, `symbol.defineSyntax`, `symbol.tagless`,
  `symbol.notImplemented`, …), and the `z` scheme-zod codec namespace (`z.string`, `z.number`,
  `z.value`, `z.box`, `z.procedure(in?, out?)`, …).

**Static analysis & provenance**

- `validateProgram` / `vocabularyFromChain` — the complete-diagnostic-list validation pass.
- `classify`, `fullCone`, `fieldCone` — the static lineage carrier; `deepProvenance` — the deep
  provenance read; `schemeToJs` — the boxed→plain exit read.
- `EvalTrace` / `buildUneval` (from `/provenance`) — the traced-run recorder and reverse slicer.

**Subpath exports** — granular, tree-shaken entries: `/oracle`, `/type-layer`, `/symbol`,
`/scheme-zod`, `/schema-tag`, `/provenance`, `/srfi`, `/capability`, `/env`, `/resources`,
`/scheme-env`, `/attestation`, `/overridable`, `/schema`.

**Lower-level membrane API** — the pre-capability instance surface, for decomposed-processing
cases the three declared doors (`capabilities` / `override` / `scope`) don't cover: a custom
provenance stamp on ingress, or a persistent env assembled once and reused across many runs.
`sandboxedEnv.inherit(name)` + `env.set(name, jsToScheme(ctx, value, {}, provenance?))`, passed to
`exec`/`execState` as glass (`{ env }`). `@deprecated` on the simple API (still exported, still
fully functional); a first-class "assemble once, reuse across runs" product is being formalized on
the `/env` subpath (`docs/working-proposals/exec-phases-and-dynamic-metadata.md`, monorepo). One
naming honesty note: `sandboxedEnv` is the inference-plane base environment — the name predates
the sweep that deleted the host-reaching verbs, and it is not, by itself, a security boundary.

## Security Status

⚠️ **version 0.x - use at your own risk**

arrival's base reaches nothing ambient by construction — no filesystem, no process, no network, no
host globals (`window` / `global` / `process` / `require`). But at 0.x, sandbox escape is still
feasible — at least via property access and some rosetta-layer aspects — so do not yet treat the
isolation as a hard security boundary for untrusted input.

**Do not**:

- Expose to untrusted user input without additional isolation
- Use in security-critical contexts
- Deploy without containerization
- Trust sandbox isolation

We welcome security researchers to responsibly disclose findings and collaborate on improvements:
security@here.build

## Performance

Interpretation costs roughly 10–100× native JS — worth it for isolation, compositional
expressiveness, and lineage; not worth it for CPU-bound number crunching. Register
performance-critical functions as capability verbs and keep Scheme for orchestration. Precise
profiles are not yet benchmarked; arrival is simultaneously a runtime and an IR — designed to be
compilable *toward* JavaScript (Python and others are plausible too) — so raw speed is the
*target's* concern and interpretation cost stays an authoring-time property, not the ceiling.

## Design foundations

The language stance — an R7RS-small sandboxed base, a forgiving superset layered *under* strict
(never beside it), the reserved-zone rule keeping it non-conflicting with any SRFI — is the charter
in [`language-design-foundations.md`](../../../docs/foundations/arrival-scheme/language-design-foundations.md);
read it before adding a reader macro, literal, or borrowing. The governing principles of this
package — the two-interpreter keystone, the value plane, the membrane, provenance, the surface
rules — are [`docs/PRINCIPLES.md`](./docs/PRINCIPLES.md).

Two surface facts every example above relies on. The *core* grammar is `( … )` lists, `[ … ]`
vectors, and `{ … }` dicts (`{:key value …}`), canonicalized at read time; the core reader has no
infix mode (an infix-shaped `{a * b}` gets a teaching door — infix lives one layer up, in
Sugarcoat). The membrane is polyglot: `@` / `@?` / `:key` read members over a dict, an array, or
a lazy foreign wrapper uniformly, and JS is a **peer, not a host** beneath the language.

## Why Scheme for AI Agents?

Scheme matches how compositional reasoning works: an agent exploring data ("find all items where
priority > threshold") thinks in filter/map/compose, and Scheme is the notation for that.
Sandboxing prevents exploration from accidentally executing actions.

### Prior art

The stance above — *symbolic programming as the reasoning medium, not static tool-calling* — is argued
independently in Jordi de la Torre, [*From Tool Calling to Symbolic Thinking: LLMs in a Persistent Lisp
Metaprogramming Loop*](https://arxiv.org/abs/2506.10021) (arXiv:2506.10021, 2025): embed Lisp in
generation, intercept it through a **middleware layer**, give the model a **persistent REPL** in which it
defines, invokes, and evolves its own tools — the thought and the executable program are the same
artifact, not English-reasoning-then-translate-to-a-tool-call.

That paper offers *design principles*; arrival is the built system. Its middleware layer is our membrane
(`@`); its persistent REPL is the per-run capability environment; its "evolve your own tools" is the
capability DAG. And where it leaves the environment open, arrival's base is sandboxed, no-IO, and
R7RS-faithful — we add what a design framework omits: the boundary that makes a self-evolving symbolic
loop safe to run.

## Contributing

Early-stage and moving fast. We're interested in: **security review** (audit sandbox isolation),
**performance benchmarks**, **conformance** (grow the Chibi-suite pass set; every flipped
`it.fails` is a gift), and **doors** (find a dead-end error, turn it into a teaching door).

## License

**[FSL-1.1-MIT](./LICENSE.md)** — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date. Until conversion, the license permits everything *except* Competing Use (making the Software available in a commercial product or service that substitutes for the Software or offers substantially similar functionality). Internal use, non-commercial education and research, and professional services built on top of the Software are always permitted.

**What Competing Use means here, in plain words** (a clarification of intent, not a legal
instrument — the license text governs): the one reserved lane is **providing services around
custom AI-participating workflows in a self-service way** — a product whose *customers* build
their own pipelines on arrival (a hosted pipeline-builder). That is the product we are building
ourselves. Everything else is yours, explicitly:

- **Your own agentic pipelines** — personal, team, or company-internal, at any scale, including
  an internal platform where your own engineers build pipelines: **fair use, always.**
- **Agency / consulting work** — building bespoke pipelines *for* clients is professional
  services, always permitted.
- **Agents as users** — an agent building pipelines (via MCP or otherwise) acts on behalf of
  its operator; its operator's pipelines are personal use.

The test in one question: **who types the pipeline?** You or your engineers (for yourselves or
a client) — fair. Your customers, into your product — the reserved lane, for now.

Two standing commitments: clarifications of this boundary only ever *widen* fair use, never
narrow it retroactively — gray area? Ask, answers are public and bind us. And the reservation
is a head start, not a moat: every release MITs on its own two-year clock, and we are open to
conversations about converting the project to full MIT sooner.

arrival grew out of [LIPS.js](https://github.com/jcubic/lips) by Jakub T. Jankiewicz (MIT licensed), and its copyright notices are preserved in the source where shared code — the reader and tokenizer — remains. The interpreter itself is a ground-up rewrite: the term algebra, the trampoline-generator kernel, the rosetta membrane, the capability environment, and the provenance substrate share no code with LIPS.

For licensing questions, exemptions, or clarifications: team@here.build
