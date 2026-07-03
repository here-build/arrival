# @here.build/arrival

**A small language that can't keep a secret from itself — small because hiding is what makes languages big.**

arrival is a programming medium, not a tool. The grain, stated by subtraction: take an ordinary
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
  transparency survives contact with the outside world. The trick is that arrival is an **IR, not a
  runtime**: it compiles *toward* JavaScript (Python and others are plausible), so raw speed is the
  *target's* concern, and whitebox/provenance stays an *authoring-time* property. You don't pay for
  transparency where it would hurt.
- **Small, yet not weak.** It's smaller than Scheme — an R7RS-small base, no IO in the base, a
  forgiving layer that fires only *under* strict (never beside it). The smallness is the source of
  the power: a language that refuses to hide is a language a tool can reason about completely.

## The one thing to see

Give a value a source, derive from it, and the derived value still knows where it came from. This is
real, in-package, and it's all you need to feel the grain:

```typescript
import { exec, sandboxedEnv, schemeToJs, jsToScheme, pointProvenance, CONSTANT_CTX } from '@here.build/arrival';

const env = sandboxedEnv.inherit('demo');

// A value crosses into the language carrying its origin (here: provenance point #7,
// as a real source — an HTTP read, a DB row — would mint at the membrane).
env.set('forecast', jsToScheme(CONSTANT_CTX, 'cloudy in berlin', {}, pointProvenance(7)));

// Derive from it through ordinary Scheme. Nobody threads the origin by hand.
const [result] = await exec(`(string-append "today: " forecast)`, { env });

schemeToJs(result, {});      // "today: cloudy in berlin"
[...result.provenance];      // [7]  — the value confesses where it descends from
```

Ask any result `result.provenance` and it answers truthfully — not because a logging layer was
wired in, but because the value *carries* its lineage and every builtin propagates it. Join two
sources and the origins **union** (`[1, 2]`); a value made of nothing but literals has no origin to
confess. There is no honest way for a derived value to disown its sources, because the carrying lives
on the value itself, not in a sidecar that a builtin could forget to update — a builtin can only fail
to *propagate* (a visibly empty result), never to *carry*.

That `pointProvenance(7)` is a stand-in for the real story: a registered function is a **source by
default** (its result is born at the membrane carrying a fresh origin); pass `pure: true` to make it
a forwarding pipe that mints nothing and just relays its inputs' lineage. See the `defineRosetta`
reference below.

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

## Design foundations

The language stance — an R7RS-small sandboxed base, a forgiving superset layered *under* strict
(never beside it), and the reserved-zone rule that keeps it non-conflicting with any SRFI — is the
charter in [`docs/language-design-foundations.md`](../../../docs/foundations/arrival-scheme/language-design-foundations.md). Read it
before adding a reader macro, literal, or dialect borrowing.

Two surface facts the examples below rely on. The grammar is `( … )` lists plus `{ … }` SRFI-105
curly-infix, canonicalized at read-time (`{1 + 2 * 3}` → `7`, plain PEMDAS); there is no `[ … ]` —
it was removed from the grammar, so a stray bracket is a clean parse error. The membrane is polyglot:
`@` / `@?` / `:key` read members over a dict, an array, or a lazy proxy uniformly, and JS is a
**peer, not a host** beneath the language — there is no ambient host to reach, so real effects stay
recorded crossings rather than escape hatches.

## Why Scheme for AI Agents?

Scheme matches how compositional reasoning works. When AI agents explore data ("find all items where priority >
threshold"), they think in filter/map/compose patterns. Scheme is the notation for compositional thinking.

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

## Quick Start

```bash
npm install @here.build/arrival
```

### Basic Execution

```typescript
import { exec, sandboxedEnv, schemeToJs } from '@here.build/arrival';

const results = await exec(`
  (filter (lambda (x) (> x 5))
    (list 1 3 7 9 2))
`, { env: sandboxedEnv });

console.log(schemeToJs(results[0], {})); // [7, 9]
```

### Register Custom Functions

`@here.build/arrival` provides scheme-js interoperability layer capable of entities translation between runtimes.

```typescript
import { exec, sandboxedEnv, schemeToJs } from '@here.build/arrival';

// Rosetta: automatic JS ↔ Scheme conversion
sandboxedEnv.defineRosetta('double-all', {
  fn: (numbers: number[]) => numbers.map(x => x * 2)
});

const results = await exec(`
  (double-all (list 1 2 3 4 5))
`, { env: sandboxedEnv });

console.log(schemeToJs(results[0], {})); // [2, 4, 6, 8, 10]
```

### Complex Data

```typescript
import { exec, sandboxedEnv, schemeToJs, jsToScheme, CONSTANT_CTX } from '@here.build/arrival';

// Register function filtering objects
sandboxedEnv.defineRosetta('high-priority-users', {
  fn: (users: Array<{id: string, priority: number}>) =>
    users.filter(u => u.priority > 10)
});

// Pass JS data to Scheme
const users = [
  { id: "alice", priority: 15 },
  { id: "bob", priority: 5 },
  { id: "charlie", priority: 20 }
];

sandboxedEnv.set('users', jsToScheme(CONSTANT_CTX, users, {}));

const results = await exec(`
  (high-priority-users users)
`, { env: sandboxedEnv });

console.log(schemeToJs(results[0], {}));
// [{ id: "alice", priority: 15 }, { id: "charlie", priority: 20 }]
```

## How it's built

arrival isn't a general Scheme that happens to be sandboxed — the architecture is shaped end-to-end by the two goals above: stay transparent, and be a medium a self-evolving symbolic loop can run safely. Four pieces carry it.

### Sandboxed by construction

The base reaches nothing ambient. There is no host member-access form — `(. console …)` doesn't exist — so the only way outward is the `@` membrane, and the membrane has no `console`, no `process`, no `require` to reach. Real effects are *recorded crossings*, not escape hatches.

```typescript
await exec(`(@ console :log)`, { env: sandboxedEnv });
// Error: console not defined — there is no host to reach
```

### The rosetta membrane

JS ↔ Scheme crossings go through a translation layer (`defineRosetta`) that is **provenance-aware by default**: a registered function is a *source* — its result is born carrying a fresh origin — unless you mark it `pure: true`, making it a *pipe* that mints nothing and forwards its inputs' lineage. Conversion is automatic both directions (arrays↔lists, objects↔alists, functions→procedures), and JS sits **beneath the language as a peer, not above it as a host**.

### Tagless-final term algebra

Operations live ON the values, not inside the interpreter. Each value carries its own `arrival/tagless-final/<op>` method — `map`, `filter`, `reduce`, `car`, `cdr`, `length`, `lte`, `equals` — and the builtins are thin dispatchers over them. That's why the *same* `map` preserves element identity on a list yet strips it crossing out to a foreign functor: the per-primitive behaviour is a fact about the term, not a branch inside `map`. A new countable type implements the method and the standard library reaches it for free; a type that doesn't carry it gets a clear "does not support" error, never a silent coercion.

### Polyglot surface

A few constructs from beyond R7RS are admitted as deliberate, bounded supersets — the `(dict :key value …)` keyword-map constructor and its `(:key d)` accessor, and `{ … }` SRFI-105 curly-infix — each canonicalized at read-time. They complete the grammar's grain; they are not an open extension surface. See the [charter](../../../docs/foundations/arrival-scheme/language-design-foundations.md).

## Sandbox Architecture

### What's Allowed

**Standard Scheme library**:

- List operations: `car`, `cdr`, `cons`, `list`, `append`, etc.
- Higher-order: `map`, `filter`, `reduce`, `fold`, etc.
- Logic: `and`, `or`, `not`, `if`, `cond`, etc.
- Math: `+`, `-`, `*`, `/`, `>`, `<`, `=`, etc.
- Lambda functions and closures

**Explicitly registered functions**:

- Via `env.defineRosetta(name, { fn })`
- Via `env.set(name, value)`

### What's Blocked or NonExistent

**Filesystem access**: No `open-input-file`, `open-output-file`, etc.
**Network access**: No fetch, HTTP, sockets
**Process execution**: No `system`, shell commands
**Global JavaScript**: No `window`, `global`, `process`, `require`
**Unregistered functions**: Attempting to call undefined function throws error

### Isolation Boundaries

```typescript
// Environment is isolated per execution
const env1 = sandboxedEnv.inherit();
const env2 = sandboxedEnv.inherit();

env1.set('x', 10);
env2.set('x', 20);

await exec(`x`, { env: env1 }); // 10
await exec(`x`, { env: env2 }); // 20
```

Each environment maintains separate bindings. Global state variance don't leak between executions.

### Error Handling

Errors are thrown with extra metadata at `publicMessage` on potential issues.

This provides valuable feedback instead of opaque, unclear behavior.

## Security Status

⚠️ **version 0.x - use at your own risk**

arrival's base reaches nothing ambient by construction — no filesystem, no process, no network, no host globals (`window` / `global` / `process` / `require`). But at 0.x, sandbox escape is still feasible — at least via property access and some rosetta-layer aspects — so do not yet treat the isolation as a hard security boundary for untrusted input.

**Do not**:

- Expose to untrusted user input without additional isolation
- Use in security-critical contexts
- Deploy without containerization
- Trust sandbox isolation

We welcome security researchers to responsibly disclose findings and collaborate on improvements: security@here.build

## Rosetta Translation Layer

Automatic conversion between JavaScript and Scheme:

### JS → Scheme

| JavaScript           | Scheme                        |
|----------------------|-------------------------------|
| `[1, 2, 3]`          | `(list 1 2 3)`                |
| `{x: 10, y: 20}`     | `((x . 10) (y . 20))` (alist) |
| `(a, b) => a + b`    | `(lambda (a b) (+ a b))`      |
| `null` / `undefined` | `nil`                         |
| `true` / `false`     | `#t` / `#f`                   |

### Scheme → JS

| Scheme                | JavaScript             |
|-----------------------|------------------------|
| `(list 1 2 3)`        | `[1, 2, 3]`            |
| `((x . 10) (y . 20))` | `{x: 10, y: 20}`       |
| `#t` / `#f`           | `true` / `false`       |
| `nil`                 | `null`                 |
| Symbols               | Strings (configurable) |

### Registering Functions

```typescript
// Simple function — a provenance SOURCE by default (its result mints a point)
env.defineRosetta('add', {
  fn: (a: number, b: number) => a + b
});

// With type conversion hints
env.defineRosetta('process-users', {
  fn: (users: User[]) => users.filter(u => u.active),
  // Automatic conversion of return value to Scheme list
});

// `pure: true` opts out to a PIPE — forwards its inputs' provenance, mints nothing
env.defineRosetta('shout', {
  pure: true,
  fn: (s: string) => s.toUpperCase()
});

// Direct Scheme value
env.set('pi', 3.14159);
env.set('config', jsToScheme(CONSTANT_CTX, { timeout: 5000 }, {}));
```

## Extending the term algebra

A custom data structure carries its own operations by implementing the `arrival/tagless-final/<op>` methods; the standard builtins dispatch to them with no registration.

```typescript
// A tree that knows how to map over itself
class Tree<T> {
  ["arrival/tagless-final/map"]<U>(fn: (value: T) => U): Tree<U> {
    return new Tree(
      fn(this.value),
      this.children.map((child) => child["arrival/tagless-final/map"](fn)),
    );
  }
}

// Scheme `(map …)` reaches the method directly — no special case
await exec(`(map double my-tree)`, { env });
```

The protocol covers the value algebra the builtins need — `map`, `filter`, `reduce`, `car`/`cdr`, `length`, `lte` (total order), `equals` (structural). A term implements what it supports; each per-primitive choice (a pair's `map` preserves element boxes, a vector's strips them crossing to a foreign functor) lives on the term, so the builtins stay type-agnostic dispatchers.

## Performance Characteristics

**Overhead vs native JS**:

- Interpretation cost: ~10-100x slower than native
- Worth it for: Isolation, sandboxing, compositional expressiveness, AI intent expression
- Not worth it for: CPU-intensive computation

**Optimization**:

- Register performance-critical functions in JS via Rosetta
- Use Scheme for orchestration, JS for computation
- Limit expression complexity

**Not yet benchmarked**:

- Precise overhead measurements
- Memory usage profiles
- Comparison with other sandboxing approaches

## API Reference

### Core Functions

**`exec(code: string, options?: ExecOptions): Promise<SchemeValue[]>`**

Execute Scheme code, return results.

```typescript
const results = await exec(`(+ 1 2 3)`, { env: sandboxedEnv });
console.log(results[0]); // 6
```

**`jsToScheme(ctx: RunContext, value: any, options?: RosettaOptions): SchemeValue`**

Convert JavaScript value to Scheme representation. `ctx` is the per-run context (use the exported
`CONSTANT_CTX` for run-neutral values registered before `exec`).

**`schemeToJs(value: any, options?: RosettaOptions): any`**

Convert Scheme value to JavaScript.

### Environment Methods

**`env.defineRosetta(name: string, { fn: Function, pure?: boolean })`**

Register JS function with automatic type conversion. By default the rosetta is a
provenance **source** — its result mints a fresh provenance point. Pass
`pure: true` to make it a pass-through **pipe** that forwards its inputs'
provenance instead of minting.

**`env.set(name: string, value: SchemeValue)`**

Set binding in environment (use `jsToScheme` for JS values).

**`env.get(name: string): SchemeValue`**

Get binding from environment.

**`env.inherit(name?: string): Environment`**

Create an isolated child scope: own `set` calls land locally (shadowing the parent), while lookups
still fall through to it.

TypeScript types coverage will be added eventually.

## Contributing

Early-stage and moving fast. We're interested in:

- **Security review** - audit sandbox isolation
- **Performance benchmarks** - measure overhead
- **Term-algebra docs** - document the tagless-final operations
- **Testing** - expand test coverage

## License

**[FSL-1.1-MIT](./LICENSE.md)** — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date. Until conversion, the license permits everything *except* Competing Use (making the Software available in a commercial product or service that substitutes for the Software or offers substantially similar functionality). Internal use, non-commercial education and research, and professional services built on top of the Software are always permitted.

arrival grew out of [LIPS.js](https://github.com/jcubic/lips) by Jakub T. Jankiewicz (MIT licensed), and its copyright notices are preserved in the source where shared code — the reader and tokenizer — remains. The interpreter itself is a ground-up rewrite: the tagless-final term algebra, the trampoline-generator kernel, the rosetta membrane, the capability environment, and the provenance substrate share no code with LIPS.

For licensing questions, exemptions, or clarifications: team@here.build
