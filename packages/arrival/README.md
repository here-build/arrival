# @here.build/arrival

**The first ever language built for AI, finally built for AI**

Arrival is a programming medium, not a tool. The grain, stated by subtraction: take an ordinary
small Scheme and remove its ability to hide where a value came from. What's left is a language in
which every value remembers its own origin, and you can ask it.

Most of what makes a language big is hiding. A function body hides how a result was computed. An
abstraction hides what it stands on. A value, once produced, is opaque — a bare `7` that could have
come from a config file, a database row, a model's guess, or thin air, and nothing about the `7`
tells you which. Opacity is the default everywhere; it's so total it's invisible. arrival is that
default, minus the one bit — and removing it costs almost nothing, because *hiding* is the expensive
feature, not *remembering*.

Two tradeoffs that usually trade against each other, here don't:

- **Real, yet whitebox.** A whitebox language is normally a toy — a stepper over arithmetic. arrival
  reaches real I/O (HTTP, SQL, an LLM call) through a membrane that records each crossing, so the
  transparency survives contact with the outside world. The trick is that arrival is simultaneously
  a runtime and IR: it is designed to be compilable *toward* JavaScript (Python and others are
  plausible too), so raw speed is the *target's* concern, and whitebox/provenance stays an
  *authoring-time* property. You don't pay for transparency where it would hurt.
- **Small, not weak.** It's a formalized Scheme subset with a clear contour — R7RS-small is taken as
  the foundation, and it's taken seriously: chibi-scheme's own R7RS test suite is used as a test
  framework. IO and dynamics are taken away, to keep the execution linear. The smallness is the
  source of the power: a language that refuses to hide is a language a tool can reason about
  completely. It is homoiconicity at its finest.

## The one thing to see

Give a value a source, derive from it, and the derived value still knows where it came from. This is
real, in-package, and it's all you need to feel the grain:

```typescript
import { execState, sandboxedEnv, schemeToJs, jsToScheme, pointProvenance, CONSTANT_CTX } from '@here.build/arrival';

const env = sandboxedEnv.inherit('demo');

// A value crosses into the language carrying its origin (here: provenance point #7,
// as a real source — an HTTP read, a DB row — would mint at the membrane).
env.set('forecast', jsToScheme(CONSTANT_CTX, 'cloudy in berlin', {}, pointProvenance(7)));

// Derive from it through ordinary Scheme. Nobody threads the origin by hand.
const { values: [result] } = await execState(`(string-append "today: " forecast)`, { env });

schemeToJs(result, {});      // "today: cloudy in berlin"
[...result.provenance];      // [7]  — the value confesses where it descends from
```

Join two sources and the origins **union** (`[1, 2]`); a value made of nothing but literals has no
origin to confess. The carrying lives on the value itself, not in a sidecar logging layer — a
crossing stamps the value, a container threads its stamp into every element read out of it, and a
collapsing op (`string-append`, `join`) deep-walks its inputs so the lineage survives even when the
structure that carried it doesn't.

And this is the part that sounds impossible: granular provenance normally costs you the hot path.
Here it doesn't, because provenance is not instrumentation — it is a *second interpretation of the
same program* (the keystone principle, [`docs/PRINCIPLES.md`](./docs/PRINCIPLES.md) P0). The value
layer computes *what*, the box layer computes *where from*, and the same lineage is also derivable
*statically* (`classify` / `fullCone`, exported) and from the recorded trace — with agreement
between the interpretations enforced as a tested law, not assumed. Eager per-op accumulation is a
dial (an oracle the CI cross-check runs), not a tax the production path pays.

## Then run it backward

Because the lineage lives on the values, a finished run can be *reversed*. A traced run builds a
container whose `uneval` takes a selector — "the head of the result", "the `:PID` of the third
row" — and reverse-slices the trace by the effective value's provenance into a **minimal
re-runnable program that re-derives exactly that value** (the Galois-slicing `uneval` of
Perera–Cheney; purity is the theorem that makes the least slice exist). This runs, today:

```typescript
import { execState, sandboxedEnv, jsToScheme, pointProvenance, CONSTANT_CTX } from '@here.build/arrival';
import { EvalTrace, buildUneval } from '@here.build/arrival/provenance';

const env = sandboxedEnv.inherit('demo');
env.set('scan-output', jsToScheme(CONSTANT_CTX, 'evil.exe', {}, pointProvenance(1)));
env.set('noise', jsToScheme(CONSTANT_CTX, 'irrelevant', {}, pointProvenance(2)));

const trace = new EvalTrace();
const src = `
  (define chatter (string-append noise "!"))
  (define verdict (string-append "malware: " scan-output))
  (list verdict "benign")
`;
const { values } = await execState(src, { env, tap: trace });

const run = buildUneval({ env, result: values.at(-1), trace, source: src, forms: [] });
const head = await run.uneval('(car result)');

head.value;        // "malware: evil.exe"
head.provenance;   // [1] — descends from scan-output; noise never touched it
head.program;      // (define verdict (string-append "malware: " scan-output))
                   // (let ((result (list verdict "benign"))) (car result))
```

The unrelated `chatter` derivation is pruned; what remains is the backward dependence cone plus the
selector — a closed program a reviewer, or another agent, re-runs to re-derive the exact value under
question. "Why did you conclude X?" stops being post-hoc narration and becomes a derivation you can
hand over. (The slice is per top-level form today; intra-form slicing is the documented next step.)

## Then build the thing only you can see

We built it and the first thing that fell out was a **seal** — a verdict that walks every leaf of a
result, checks that each one traces to a real source, and *mathematically refuses to sign* one that
doesn't. Not a lint pass you can disable: a value with a fabricated leaf has no signature to give,
because the grounding is read per-leaf off the lineage the value already carries. Together with
trace replay this composes into a property nothing bolt-on offers: an output either traces
end-to-end — and a third party can re-derive it — or it has no signature at all. The whole-result
walker and the human-readable `whyOf` / `whereOf` / `howOf` / `dagOf` queries live one layer up (in
`@here.build/arrival-chain` and the sift work); what lives *here* is the boundary that makes them
sound — the provenance carrying above, plus the **attestation brand** (`src/values/attestation.ts`),
a second, deliberately different algebra: where provenance unions forward through computation,
attestation *drops on compute* — a derived value loses its inputs' attestation, so an agent must
re-assert what a new value IS, while plain reference-passing preserves it for free. Core carries the
brand and its stamp sites; enforcement at the tool boundary lives in the manifold layer.

Two limits, stated plainly, because the seal invites overreading. First: it is a
**lineage-completeness oracle, not a truth oracle** — a lying tool's answer traces perfectly and
signs happily; what the seal forecloses is *unattributed* values, not wrong ones. Second: replay
never re-invokes a source — the frozen recorded payloads are authoritative
(`src/provenance/replay.ts`) — so replaying a run whose crossings include model calls stays exact
only as long as those recorded results are retained; evict the cache they live in and a fresh live
run may diverge from what was signed. (Resampling an inference is likewise no hidden reset verb:
it's an explicit cache-key change at the call site, one layer up in the LLM plane.)

That's one thing. We don't fully know what else this medium is for; neither will you, until you build
it. A language that can't keep a secret from itself is a strange piece of clay — here it is.

## What's in the box

Provenance is the headline, but it rides on a load-bearing stack. The rest is not garnish — several
pieces are the reason the headline is possible at all.

### A real R7RS subset, proven against Chibi's own suite

arrival is honest, faithful, predictable R7RS — a subset by *subtraction* (no IO, no dynamics, no
mutation), not a lookalike. The test framework for this claim is not ours: the vendored
chibi-scheme `r7rs-tests.scm` — the reference suite the Chibi implementation tests itself with —
runs against arrival form-by-form (`src/__tests__/conformance/`). A documented gap is an `it.fails`
that flips loudly the day it's fixed, never a silent skip.

And the subset is deep where it counts, not just wide: **proper tail calls** via a flat trampoline
(trampolined style after Ganz–Friedman–Wand — unbounded mutual recursion without stack growth),
**multiple values** (`values` / `call-with-values`), the **full R7RS exception tower** (`raise`,
`raise-continuable`, `with-exception-handler`, `guard`, error objects with irritants), an **exact
numeric tower** (bigint-backed rationals — `(+ (/ 1 3) (/ 2 3))` is exactly `1`, not `0.999…`), and
**datum labels** (`#0=` / `#0#`), so circular literals read without infinite descent.

Twelve SRFIs are implemented and assembled by default — 1 (lists), 2, 8, 13, 26, 28, 43, 95, 128,
151, 189, 235 (`src/env/srfi/`) — so real Scheme libraries are usable rather than merely
"inspirational." The deliberately-absent ones (hash tables, random, time/date, char-sets, sets,
string ports) are doored stubs, not silence — each names why it's out and routes back to the real
dataflow (`src/env/srfi/srfi-stubs.ts`); they are exactly the symbols an LLM agent predictably
reaches for.

### Everything is a pack — the C3 capability DAG

The environment is not a monolith with registration bolted on. Every capability — the R7RS base, each
SRFI, each dialect pack, your tools — is an `EnvCapability`: a named, dependency-carrying, async
contribution. `assembleEnv` C3-linearizes the dependency DAG (the same monotonic linearization Python
uses for MRO — cited, not invented), dedups by identity, detects cycles, applies each pack once, and
disposes LIFO. The dep edge *is* the capability grant; the base stdlib itself is assembled from the
same packs you write. This is what "pluggable" means here: there is one composition mechanism and
everything, including the language's own standard library, goes through it.

### IO taken away — to come back with lineage

There are no ports, no filesystem, no clock, no `random`. Not as a security posture — as an
*algebraic* one: an ambient read has no construction site to root a value's lineage at, so admitting
it would put a hole in the one guarantee the language makes (the full argument:
[`why-no-io-dataflow-algebra.md`](../../../docs/foundations/arrival-scheme/why-no-io-dataflow-algebra.md)).
Effects come back in as capability-pack tools that mint provenance at the membrane — a filesystem
read is a recorded crossing that stamps its result, not a stream that appears from nowhere.

### The rosetta membrane — peers, not host

JS ↔ Scheme interop is a recursive wrapper membrane in the object-capability lineage (Miller / Van
Cutsem), with a member-read protocol modeled on GraalVM's `InteropLibrary`. Values cross as thin,
identity-cached wrappers, lazily and recursively — a JS object crosses as a borrowed wrapper whose
members box on first read, carrying the wrapper's provenance:

```typescript
env.set('users', jsToScheme(CONSTANT_CTX, [{ id: 'alice', priority: 15 }, { id: 'bob', priority: 5 }], {}));

await exec(`(map (lambda (u) (:id u)) users)`, { env });                       // [["alice", "bob"]]
await exec(`(filter (lambda (u) (> (@ u :priority) 10)) users)`, { env });     // [[{ id: "alice", priority: 15 }]]
```

Crossings round-trip to identity both directions (arrays ↔ vectors, objects ↔ borrowed wrappers,
dicts ↔ plain objects, `null`/`undefined` ↔ nil, booleans ↔ `#t`/`#f`). Two things are banned at
the boundary, with teaching doors: a bare `Promise` entering value space (await it, or hand over the
structure holding it and let the entry settle lazily), and a bare JS function coming back out of a
rosetta (untraceable). Critically, JS sits **beneath the language as a peer, not above it as a
host** — there is no ambient `console`, `process`, or `require` to escape to, so a real effect is
always a recorded crossing, never a side door. That is the architectural fact every other safety
claim on this page stands on; it also means a huge host graph crosses zero-copy, borrowed, with no
hidden effect channel riding along.

### One program, many interpreters — the tagless-final algebra

Operations live *on* the values: each primitive carries `arrival/tagless-final/<op>` methods
(`map`, `filter`, `get`, `apply`, …) and the builtins are thin dispatchers over them. That's not a
style choice — it's the load-bearing structure. The value interpreter and the provenance interpreter
execute the *same terms* in lock-step, and further interpreters read those same terms statically:
the type lens, the static lineage classifier, the sampler oracle's feasibility layers. N
interpretations of one program, held in agreement by tested laws — that is the whole architecture
in one sentence (PRINCIPLES P0/P15). Every declared symbol also carries a **provenance role**
(`source` / `pipe` / `fan` / `sink` / `transparent` / `loop` / `opaque`) on its contract, so the
lineage reading is declared per-verb, never guessed.

### Errors are doors, not walls

A modern compiler's error message teaches; a bare `Unbound variable` is a dead end. Every deliberate
omission in arrival is a **door**: it names the fact, the reason, and the exact alternative bound in
*this* environment. Reach for a file port and you get:

```
open-input-file @ scheme/r7rs/host is not available.
  Why: no file ports in this sandbox — files arrive through tools, not streams; call the
  filesystem tool bound in this environment (e.g. (filesystem/read_file :path "...")) and
  use the returned value directly
```

The same discipline runs *before* execution: `exec(code, { staticValidation: "on" })` checks the
whole program against the assembled vocabulary and reports **every** problem at once, eslint-style,
instead of crashing on the first:

```
Static validation found 1 error — nothing was evaluated:
  • Unbound symbol `forecst-for` — did you mean `forecast-for`? Referenced at 1:0 — this
    program would crash there.
```

A missing capability is likewise diagnosed as a configuration fact, not a mystery ("Configuration
key `fs` … was not provided. It disables `require @ arrival/loader` (referenced at 1:35) — this
program would crash there. Provide `fs` to enable it."). For an agent, this compounds into
**zero-round-trip self-repair**: every diagnostic arrives at once, each carrying its alternative,
so the usual failure loop — crash, read one error, guess, crash again — collapses into a single
informed retry.

### Polyglot by observation, not by design

The thesis first, because without it this section reads as trivia: **the dialect roster was
reverse-engineered from LLM latent space, not designed for humans.** It is a measurement of what
models trained on all of Lisp believe Scheme is, turned into a surface. A model reaches for
Clojure's threading in one breath and CL's `mapcar` in the next; arrival meets the guess instead of
punishing it:

```scheme
(->> {:versions (list {:state "draft"} {:state "live"})} :versions last :state)  ; "live"
(map (lambda (x) (* x x)) [1 2 3])                                               ; #(1 4 9)
(mapcar car (list (list 1) (list 2)))                                            ; (1 2)
```

Four dialect packs carry this (`src/env/polyglot*.ts`): Clojure (`->` / `->>`, `comp`, `get-in`,
`zipmap`, …), Racket (`~>` / `~>>`, the `dict-*` family), Common Lisp (`mapcar`, `remove-if`, …),
and the shared core — `{:key value …}` dict literals, `[ … ]` vectors, the `(:key obj)` accessor,
the `@` / `@?` / `@keys` member-read protocol. All of it canonicalizes at read time and stays
R7RS-compliant — borrowings are admitted only where R7RS leaves behavior undefined (PRINCIPLES
P13); the verbs that *can't* carry over honestly (`setf`, `loop`, `gethash`, …) aren't absent —
they're doored, with the reason and the working alternative.

### A Curry-Howard type layer, in a language never designed for one

Every symbol is declared with a contract — `{ input: [z.string], output: [z.number] }` — through the
`scheme-zod` codec vocabulary, and the schema DSL (`s/object`, `s/array`, `s/enum`, …,
`src/env/schema.ts`) is the language's explicit-type syntax. A schema tag is a *proposition*; it
discharges three ways from one canonical lowering: as a runtime validator (zod), as a wire schema
(JSON Schema for structured outputs), and as a *static* projection — the type layer
(`@here.build/arrival/type-layer`) prints harvested signatures as TypeScript, so the checker is
`tsc` itself. Scheme programs get real type-checking without arrival growing a type checker: the
proofs are discharged by a checker that already exists. A side effect worth naming: **the schema
cannot drift** — advertised wire schema, enforced validator, and static type are three projections
of one term, so there is no second copy to fall out of sync with the first.

### The oracle — the interpreter wired into the sampler

`@here.build/arrival/oracle` exposes the interpreter's own knowledge — structural validity and the
bound-symbol set (Σ) — as a **truncation-safe scanner**: pure, O(n), single pass, where an
unterminated string or comment is a reported state, never a throw (`src/oracle/scanner.ts`) —
exactly what a constrained decoder consulting it token-by-token needs. Under it, an unbalanced
program is *ungeneratable*; with a grant env, an unbound symbol is *ungeneratable*. Read that back
against the capability DAG: an ungranted tool is not merely uncallable at runtime — it is
**unwritable at generation time**. Containment moves from the sandbox into the decoder.

The consumer is `@here.build/arrival-sampler` (a separate package), and it is more than a sketch:
a substrate-free mask kernel — Σ + structural gates, a tool-call grammar profile, a per-step
EXPLAIN record for every veto — pinned by its own kernel test corpus; an async **Σ∩T** layer that
narrows the symbol mask through a type lens between forward passes (a cache miss degrades
conservatively to Σ, never to a wrong restriction); node-llama-cpp wiring; an OpenAI-compatible
server. The honest split: the mask kernel is tested machinery; the decode strategies riding it
keep the *experimental* tag.

### Boundable execution — the knobs

Execution is **boundable, not bounded by default** — and the default is stated on the tin. `signal`
(an `AbortSignal`) makes any run killable, always. `budgetMs` is an opt-in *internal* wall-clock
bound — the trampoline throws when it elapses, no external controller needed. `heapBudget` is an
opt-in allocation cap charged at the collection-op choke points — the bound an O(n²)-churn list
loop actually hits, where a wall-clock tick can't see inside a single native pass. Sandbox and
agent hosts opt in (the MCP layer passes its own defaults); embedded library use pays nothing.
Two more knobs change the interpretation itself — `strict: true` turns off nil-tolerance
(projecting into nil throws, R7RS-strict; caller-scoped, so a strict host and a forgiving REPL
coexist), `freezeRosettaReturns` freezes borrowed JS sources at the membrane — and `execState`
returns the session `scope`: REPL-style continuation, so a long agent session accumulates
definitions instead of resending the world each turn.

### And a shelf that earns its weight

| | |
|---|---|
| First-class special forms | special-ness travels with the keyword *value* — `(define => lambda)` aliases a form; full lexical shadowing is a documented gap, not a silent wrong answer |
| Replay drivers | re-run a traced program with every membrane crossing answered from the recorded payload stream — the live world is never consulted (`src/provenance/replay.ts`) |
| Trace analysis stack | flow graphs, region folds, span attribution, MDL trace collapse — the trace is a queryable artifact, not a log (`src/provenance/`) |
| `@here.build/arrival-sugarcoat` | a bidirectional lens over canonical s-expressions — `evidence.map{ it[0].normalize[:family] }` renders for humans, folds edits back losslessly |
| `@here.build/arrival-serializer` | budget-bounded rendering: under a budget, per-element caps shrink fairly across siblings and re-render — never a tail-cut, and every reduction is signaled inline |
| `@here.build/arrival-mcp` | the language as an MCP surface — discovery/action tools over the same capability envs, serializer budgets on every result |

## Quick Start

```bash
npm install @here.build/arrival
```

### Basic execution

```typescript
import { exec, sandboxedEnv } from '@here.build/arrival';

// exec returns plain JS values — one per top-level form.
const [result] = await exec(`
  (filter (lambda (x) (> x 5))
    (list 1 3 7 9 2))
`, { env: sandboxedEnv });

console.log(result); // [7, 9]
```

`exec` is the simple tier ("run, get JS"). When you need the boxed, provenance-bearing values or a
reusable session, use `execState` — it returns `{ values, scope, … }` with the real Scheme values.

### Register your own tools — the capability path

A tool is a declared symbol on an `EnvCapability`: a name, a doc line, a typed contract, an
implementation. The contract is enforced at the membrane in both directions.

```typescript
import { exec, EnvCapability, symbol, z } from '@here.build/arrival';

const weather = new EnvCapability("demo/weather", {
  symbols: {
    "forecast-for": symbol.rosetta`forecast-for: the current forecast for a city`(
      { input: [z.string], output: [z.string], provenance: "source" },
      async (city) => fetchForecast(city),
    ),
  },
});

const [line] = await exec(
  `(string-append "today: " (forecast-for "berlin"))`,
  { capabilities: [weather] },
);
// "today: cloudy in berlin"
```

`provenance: "source"` declares the lineage role: this verb introduces external data, so its results
mint a fresh origin. A pure transform declares `"pipe"` and forwards its inputs' lineage instead.
(A low-ceremony legacy path — `env.defineRosetta(name, { fn, pure? })` — still works but carries no
contract; prefer the declared form for anything that outlives a scratch session.)

### Passing data across

Data enters as a **declared, typed parameter of the program** — `define/overridable` names it,
gives it an s/* type and a default, and the host supplies the value through `override`. No
conversion call, no environment mutation; the value is validated against the declared type and
boxed at the membrane:

```typescript
import { exec } from '@here.build/arrival';

const users = [
  { id: "alice", priority: 15 },
  { id: "bob",   priority: 5  },
];

const [, highPriority] = await exec(
  `(define/overridable users
     (s/array (s/object (s/field/string "id") (s/field/number "priority")))
     '())
   (filter (lambda (u) (> (@ u :priority) 10)) users)`,
  { override: { users } },
);
// [{ id: "alice", priority: 15 }]
```

The program stays self-describing (it runs on its defaults with no host at all), and a value that
doesn't match the declared type is rejected with a door naming the binding, the expected shape, and
who supplied it — the host's override and the author's default validate against the same type. For
run-neutral values wired below the program level there is still the manual membrane path
(`env.set(name, jsToScheme(CONSTANT_CTX, value, {}))` on an `inherit`ed environment; each child
scope is isolated), but prefer the declared parameter for anything a program consumes by name.

## API surface

**Execution**

- `exec(code, options?) → Promise<unknown[]>` — parse + run, results unwrapped to plain JS.
- `execState(code, options?) → Promise<ExecState>` — boxed, provenance-bearing `values` plus the
  session `scope` handle for REPL-style continuation (`LexicalScope`).
- `ExecOptions`: `env` (a live environment), `capabilities` (assembled per call), `config` (the
  shared configuration bag capabilities read), `override` (host values for the program's
  `define/overridable` parameters — seamless, validated, no `jsToScheme`), `scope`,
  `staticValidation: "on" | "off"`, `signal` (killable, always), `budgetMs` / `heapBudget`
  (opt-in wall-clock / allocation bounds), `strict` (nil-tolerance off), `freezeRosettaReturns`,
  `tap` (trace recording).
- `parse(code)`, `tokenize(source)` — the reader, standalone.
- `initBridge()` — pre-warm the lazily assembled base (it otherwise assembles on first `exec`).

**Membrane**

- `jsToScheme(ctx, value, options?, provenance?)` / `schemeToJs(value, options)` — the two
  crossings; use `CONSTANT_CTX` for run-neutral values registered before `exec`.
- `env.set(name, value)` / `env.get(name)` / `env.inherit(name?)`.

**Declaration**

- `EnvCapability`, `assembleEnv`, the `symbol` factory namespace (`symbol.native`, `symbol.rosetta`,
  `symbol.define`, `symbol.defineSyntax`, `symbol.tagless`, `symbol.notImplemented`, …), and the
  `z` scheme-zod codec namespace.

**Static analysis & provenance**

- `validateProgram` / `vocabularyFromChain` — the complete-diagnostic-list validation pass.
- `classify`, `fullCone`, `fieldCone` — the static lineage carrier; `deepProvenance` — the deep
  provenance read over a structured value.
- `EvalTrace` / `buildUneval` (from `/provenance`) — the traced-run recorder and the reverse
  slicer: the `{ result, meta, uneval }` container shown above.

**Subpath exports** — granular, tree-shaken entries: `/oracle`, `/type-layer`, `/symbol`,
`/scheme-zod`, `/schema-tag`, `/provenance`, `/srfi`, `/capability`, `/env`, `/resources`,
`/scheme-env`, `/attestation`, `/overridable`, `/schema`.

One naming honesty note: `sandboxedEnv` is the inference-plane base environment; the name predates
the sweep that deleted the host-reaching verbs and is kept because external code uses it. It is not,
by itself, a security boundary — see below.

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
overhead and memory profiles are not yet benchmarked; remember also that the compile-toward-JS
stance above means interpretation speed is an authoring-time cost, not the ceiling.

## Design foundations

The language stance — an R7RS-small sandboxed base, a forgiving superset layered *under* strict
(never beside it), and the reserved-zone rule that keeps it non-conflicting with any SRFI — is the
charter in [`language-design-foundations.md`](../../../docs/foundations/arrival-scheme/language-design-foundations.md).
Read it before adding a reader macro, literal, or dialect borrowing. The governing principles of
this package — the two-interpreter keystone, the value plane, the membrane, provenance, the surface
rules — are [`docs/PRINCIPLES.md`](./docs/PRINCIPLES.md). The peers-not-host membrane stance and the
no-IO argument have their own foundations docs beside the charter.

Two surface facts every example above relies on. The grammar is `( … )` lists, `[ … ]` vector
literals, and `{ … }` dict literals (`{:key value …}`), each canonicalized at read time; there is no
curly-infix mode (an infix-shaped `{a * b}` gets a teaching door, not a silent parse). The membrane
is polyglot: `@` / `@?` / `:key` read members over a dict, an array, or a lazy foreign wrapper
uniformly, and JS is a **peer, not a host** beneath the language.

## Why Scheme for AI Agents?

Scheme matches how compositional reasoning works. When AI agents explore data ("find all items where
priority > threshold"), they think in filter/map/compose patterns. Scheme is the notation for
compositional thinking.

Sandboxing prevents exploration from accidentally executing actions.

### Prior art

The stance above — *symbolic programming as the reasoning medium, not static tool-calling* — is argued
independently in Jordi de la Torre, [*From Tool Calling to Symbolic Thinking: LLMs in a Persistent Lisp
Metaprogramming Loop*](https://arxiv.org/abs/2506.10021) (arXiv:2506.10021, 2025). It proposes embedding
Lisp in generation, intercepting it through a **middleware layer**, and giving the model a **persistent
REPL** in which it defines, invokes, and evolves its own tools — so the thought and the executable program
are the same artifact, not English-reasoning-then-translate-to-a-tool-call.

That paper offers *design principles*; arrival is the built system. Its middleware layer is our membrane
(`@`); its persistent REPL is the per-run capability environment; its "evolve your own tools" is the
capability DAG. And where it leaves the environment open, arrival's base is sandboxed, no-IO, and
R7RS-faithful — we add what a design framework omits: the boundary that makes a self-evolving symbolic
loop safe to run.

## Contributing

Early-stage and moving fast. We're interested in:

- **Security review** - audit sandbox isolation
- **Performance benchmarks** - measure overhead
- **Conformance** - grow the Chibi-suite pass set; every flipped `it.fails` is a gift
- **Doors** - find a dead-end error and turn it into a teaching door

## License

**[FSL-1.1-MIT](./LICENSE.md)** — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date. Until conversion, the license permits everything *except* Competing Use (making the Software available in a commercial product or service that substitutes for the Software or offers substantially similar functionality). Internal use, non-commercial education and research, and professional services built on top of the Software are always permitted.

arrival grew out of [LIPS.js](https://github.com/jcubic/lips) by Jakub T. Jankiewicz (MIT licensed), and its copyright notices are preserved in the source where shared code — the reader and tokenizer — remains. The interpreter itself is a ground-up rewrite: the tagless-final term algebra, the trampoline-generator kernel, the rosetta membrane, the capability environment, and the provenance substrate share no code with LIPS.

For licensing questions, exemptions, or clarifications: team@here.build
