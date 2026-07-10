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

## Then build the thing only you can see

We built it and the first thing that fell out was a **seal** — a verdict that walks every leaf of a
result, checks that each one traces to a real source, and *mathematically refuses to sign* one that
doesn't. Not a lint pass you can disable: a value with a fabricated leaf has no signature to give,
because the grounding is read per-leaf off the lineage the value already carries. (The seal, and the
human-readable `whyOf` / `whereOf` / `howOf` / `dagOf` lineage queries, live one layer up on this
substrate — in `@here.build/arrival-chain` and the sift work — built *on* the provenance this package
makes free.)

That's one thing. We don't fully know what else this medium is for; neither will you, until you build
it. A language that can't keep a secret from itself is a strange piece of clay — here it is.

## What's in the box

Provenance is the headline, but it is one of ten load-bearing pieces. The others are not garnish —
several of them are the reason the headline is possible at all.

### A real R7RS subset, proven against Chibi's own suite

arrival is honest, faithful, predictable R7RS — a subset by *subtraction* (no IO, no dynamics, no
mutation), not a lookalike. The test framework for this claim is not ours: the vendored
chibi-scheme `r7rs-tests.scm` — the reference suite the Chibi implementation tests itself with —
runs against arrival form-by-form (`src/__tests__/conformance/`). A documented gap is an `it.fails`
that flips loudly the day it's fixed, never a silent skip. Pure R7RS and SRFI code runs unchanged;
that's what makes real Scheme libraries usable rather than merely "inspirational."

### Polyglot by observation, not by design

The surface accepts more than one dialect's spelling — and the roster wasn't invented, it was
reverse-engineered from what LLMs *think* Scheme is. Models trained on all of Lisp reach for
Clojure's threading in one breath and CL's `mapcar` in the next; arrival meets them there instead
of punishing the guess:

```scheme
(->> {:versions (list {:state "draft"} {:state "live"})} :versions last :state)  ; "live"
(map (lambda (x) (* x x)) [1 2 3])                                               ; #(1 4 9)
(mapcar car (list (list 1) (list 2)))                                            ; (1 2)
```

Four dialect packs carry this (`src/env/polyglot*.ts`): Clojure (`->` / `->>`, `comp`, `get-in`,
`zipmap`, `frequencies`, `group-by`, `partial`, `juxt`, …), Racket (`~>` / `~>>`, the `dict-*`
family), Common Lisp (`mapcar`, `remove-if`, `remove-if-not`), and the shared core: `{:key value …}`
dict literals, `[ … ]` vector literals, the `(:key obj)` keyword accessor, and the `@` / `@?` /
`@keys` member-read protocol. All of it canonicalizes at read time and stays R7RS-compliant —
borrowings are admitted only where R7RS leaves behavior undefined (PRINCIPLES P13). The dialect
verbs that *can't* carry over honestly (`setf`, `loop`, `gethash`, `with-open-file`, …) aren't
absent — they're doored (see below) with the reason and the working alternative.

### IO taken away — to come back with lineage

There are no ports, no filesystem, no clock, no `random`. Not as a security posture — as an
*algebraic* one: an ambient read has no construction site to root a value's lineage at, so admitting
it would put a hole in the one guarantee the language makes (the full argument:
[`why-no-io-dataflow-algebra.md`](../../../docs/foundations/arrival-scheme/why-no-io-dataflow-algebra.md)).
Effects come back in as capability-pack tools that mint provenance at the membrane — a filesystem
read is a recorded crossing that stamps its result, not a stream that appears from nowhere.

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

And a missing capability is diagnosed as a configuration fact, not a mystery:

```
Configuration key `fs` (a filesystem) was not provided in the exec configuration. It disables
`require @ arrival/loader` (referenced at 1:35) — this program would crash there. Provide `fs`
to enable it.
```

### SRFIs that actually work — or explain precisely why not

Implemented and assembled by default (`src/env/srfi/`): SRFI 1 (lists), 2 (`and-let*`), 8
(`receive`), 13 (strings, the char/predicate subset), 26 (`cut`), 28 (`format`), 43 (vectors),
95 (sorting), 128 (comparators), 151 (bitwise), 189 (maybe/either), 235 (combinators).

Deliberately *not* implemented — and doored, not dropped (`src/env/srfi/srfi-stubs.ts`): SRFI-69/125
hash tables (dicts are native and immutable here), SRFI-27 random and SRFI-19 time/date (ambient
non-determinism has no lineage root), SRFI-14 char-sets (the string library takes a char or a
predicate), SRFI-113 sets (no set type exists — the door says so instead of pretending), string
ports. These stubs exist because they are the symbols an LLM agent *predictably* reaches for; each
one routes the caller back to the real dataflow instead of walling them off.

### Everything is a pack — the C3 capability DAG

The environment is not a monolith with registration bolted on. Every capability — the R7RS base, each
SRFI, each dialect pack, your tools — is an `EnvCapability`: a named, dependency-carrying, async
contribution. `assembleEnv` C3-linearizes the dependency DAG (the same monotonic linearization Python
uses for MRO — cited, not invented), dedups by identity, detects cycles, applies each pack once, and
disposes LIFO. The dep edge *is* the capability grant; the base stdlib itself is assembled from the
same packs you write. This is what "pluggable" means here: there is one composition mechanism and
everything, including the language's own standard library, goes through it.

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
always a recorded crossing, never a side door.

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

### A Curry-Howard type layer, in a language never designed for one

Every symbol is declared with a contract — `{ input: [z.string], output: [z.number] }` — through the
`scheme-zod` codec vocabulary, and the schema DSL (`s/object`, `s/array`, `s/enum`, …,
`src/env/schema.ts`) is the language's explicit-type syntax. A schema tag is a *proposition*; it
discharges three ways from one canonical lowering: as a runtime validator (zod), as a wire schema
(JSON Schema for structured outputs), and as a *static* projection — the type layer
(`@here.build/arrival/type-layer`) prints harvested signatures as TypeScript, so the checker is
`tsc` itself. Scheme programs get real type-checking without arrival growing a type checker: the
proofs are discharged by a checker that already exists.

### The oracle — the interpreter wired into the sampler *(experimental)*

`@here.build/arrival/oracle` exposes the interpreter's own knowledge — structural validity and the
bound-symbol set (Σ) — as a scanner a constrained decoder can consult token-by-token. Under it, an
unbalanced program is *ungeneratable*; with a grant env, an unbound symbol is *ungeneratable*. The
consumer is `@here.build/arrival-sampler` (a separate package): a substrate-free constrained-decoding
kernel plus node-llama-cpp wiring, an OpenAI-compatible server, and BFCL harness integration. This
is research-grade — a working proof-of-concept, not a shipped guarantee. But the idea
is the same grain as everything above: the language is small and honest enough that the interpreter
can sit *inside* the model's decode loop and make wrong programs impossible to emit.

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

There is also a low-ceremony legacy path — `env.defineRosetta(name, { fn, pure? })` — which still
works but carries no contract; prefer the declared form for anything that outlives a scratch session.

### Passing data across

```typescript
import { exec, sandboxedEnv, jsToScheme, CONSTANT_CTX } from '@here.build/arrival';

const env = sandboxedEnv.inherit('my-run');
env.set('users', jsToScheme(CONSTANT_CTX, [
  { id: "alice", priority: 15 },
  { id: "bob",   priority: 5  },
], {}));

const [highPriority] = await exec(
  `(filter (lambda (u) (> (@ u :priority) 10)) users)`,
  { env },
);
// [{ id: "alice", priority: 15 }]
```

Each `inherit`ed environment is an isolated child scope: its own `set` calls land locally, lookups
fall through to the base. Nothing leaks between sibling environments.

## API surface

**Execution**

- `exec(code, options?) → Promise<unknown[]>` — parse + run, results unwrapped to plain JS.
- `execState(code, options?) → Promise<ExecState>` — boxed, provenance-bearing `values` plus the
  session `scope` handle for REPL-style continuation (`LexicalScope`).
- `ExecOptions`: `env` (a live environment), `capabilities` (assembled per call), `config` (the
  shared configuration bag capabilities read), `scope`, `staticValidation: "on" | "off"`,
  `signal` / `budgetMs` (killable, bounded evaluation), `tap` (trace recording).
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

**Static analysis**

- `validateProgram` / `vocabularyFromChain` — the complete-diagnostic-list validation pass.
- `classify`, `fullCone`, `fieldCone` — the static lineage carrier; `deepProvenance` — the deep
  provenance read over a structured value.

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
