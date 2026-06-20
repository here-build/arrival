# @here.build/arrival

**First ever language built for AI, finally built for AI**

> ⚠️ **version 0.x sandbox isolation is non-audited. **
>
> This is a fork of LIPS.js with known architectural security issues. We've identified potential sandbox escape
> strategies but haven't fixed all of them yet. **Assume the sandbox can be escaped.** Use only in isolated containers,
> unprivileged Worker threads and ShadowRealms, or any other environment that can be considered zero-trust.
>
> Version 1.x will be released after external audit verifying it is production-ready.

## Design foundations

The language stance — an R7RS-small sandboxed base, a forgiving superset layered *under* strict
(never beside it), and the reserved-zone rule that keeps it non-conflicting with any SRFI — is the
charter in [`docs/language-design-foundations.md`](../../../docs/foundations/arrival-scheme/language-design-foundations.md). Read it
before adding a reader macro, literal, or dialect borrowing.

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
npm install @here.build/arrival-scheme
```

### Basic Execution

```typescript
import { exec, sandboxedEnv, schemeToJs } from '@here.build/arrival-scheme';

const results = await exec(`
  (filter (lambda (x) (> x 5))
    (list 1 3 7 9 2))
`, { env: sandboxedEnv });

console.log(schemeToJs(results[0], {})); // [7, 9]
```

### Register Custom Functions

`@here.build/arrival-scheme` provides scheme-js interoperability layer capable of entities translation between runtimes.

```typescript
import { exec, sandboxedEnv, schemeToJs } from '@here.build/arrival-scheme';

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
import { exec, sandboxedEnv, schemeToJs, jsToScheme } from '@here.build/arrival-scheme';

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

sandboxedEnv.set('users', jsToScheme(users, {}));

const results = await exec(`
  (high-priority-users users)
`, { env: sandboxedEnv });

console.log(schemeToJs(results[0], {}));
// [{ id: "alice", priority: 15 }, { id: "charlie", priority: 20 }]
```

## Key Differences from LIPS.js

This is a **fork** of LIPS with fundamental architectural changes:

### 1. Sandboxed by Default

**LIPS.js**: Full JavaScript interop, call any JS function, access global scope
**arrival-scheme**: Isolated environment, only explicitly registered functions

```typescript
// LIPS.js: dangerous — has a JS member-access form that reaches the host
await exec(`(. console (log "pwned"))`); // Has console access

// arrival-scheme: safe — the host member-access form is gone; member-read
// goes through the `@` membrane, which has no `console` to reach
await exec(`(@ console :log)`, { env: sandboxedEnv });
// Error: console not defined
```

### 2. Rosetta Integration

**LIPS.js**: Manual conversion between JS and Scheme types
**arrival-scheme**: Automatic translation via Rosetta layer

```typescript
// Automatic conversion:
// - JS arrays ↔ Scheme lists (consider nil)
// - JS objects ↔ Scheme alists
// - JS functions → Scheme procedures
// - Natural interop in both directions
```

A registered rosetta is a **provenance SOURCE by default**: it introduces external
data, so its result mints a fresh provenance point (never silently lose an origin).
Pass `pure: true` to opt out to a pass-through **PIPE** — a transform that forwards
its inputs' provenance and mints nothing (use it for fns that only reshape their
arguments, like `string-append`).

### 3. Fantasy-land Support

**LIPS.js**: Fixed implementations of map, filter, etc.
**arrival-scheme**: Polymorphic operations defined by data structures

Custom data structures can implement `map`, `filter`, `reduce` following
the [fantasy-land](https://github.com/fantasyland/fantasy-land) spec, and Scheme primitives will use them. This is
exceptionally useful for complex structures like trees.

### 4. Polyglot runtime

Some features from other Lisp dialects were added as expression means — e.g. the `(dict :key value …)` map constructor (the canonical dict surface; the serializer prints it, and arrival-chain-view transpiles it to `{ }`) and its `(:key d)` accessor. See [`docs/language-design-foundations.md`](../../../docs/foundations/arrival-scheme/language-design-foundations.md).

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
const env1 = sandboxedEnv.clone();
const env2 = sandboxedEnv.clone();

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

LIPS.js (upstream) has deep JavaScript integration that creates attack surfaces. We've removed the biggest ones (
filesystem, process, network access) but sandbox escape is still feasible at least via property access and some rosetta
layer aspects.

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
env.set('config', jsToScheme({ timeout: 5000 }, {}));
```

## Fantasy-land Support

Data structures can implement algebraic operations via fantasy-land spec:

```typescript
// Custom list type implementing map
class MyList {
    ["fantasy-land/map"]<U>(fn: (value: T) => U): Tree<U> {
        return new MyList(
            fn(this.value),
            this.children.map((child) => child["fantasy-land/map"](fn))
        );
    }
}

// Scheme (map) will use the .map method
await exec(`(map double my-list)`, { env });
```

Supported algebras:

- Functor: `map`
- Apply: `ap`
- Chain: `chain` / `flatMap`
- Monoid: `empty`, `concat`

[request on collaboration: deeper fantasy-land integration and description is needed]

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

**`jsToScheme(value: any, options?: RosettaOptions): SchemeValue`**

Convert JavaScript value to Scheme representation.

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

**`env.clone(): Environment`**

Create isolated copy of environment.

TypeScript types coverage will be added eventually.

## Contributing

Early-stage fork. We're interested in:

- **Security review** - audit sandbox isolation
- **Performance benchmarks** - measure overhead
- **Fantasy-land docs** - document algebraic operations
- **Testing** - expand test coverage

## License

**[FSL-1.1-MIT](./LICENSE.md)** — Functional Source License 1.1, MIT Future License. Each version converts to MIT two years after its release date. Until conversion, the license permits everything *except* Competing Use (making the Software available in a commercial product or service that substitutes for the Software or offers substantially similar functionality). Internal use, non-commercial education and research, and professional services built on top of the Software are always permitted.

This is a fork of [LIPS.js](https://github.com/jcubic/lips) by Jakub T. Jankiewicz (MIT licensed). LIPS.js copyright
notices are preserved in source files.

For licensing questions, exemptions, or clarifications: team@here.build
