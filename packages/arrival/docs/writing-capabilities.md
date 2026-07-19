# Writing capabilities

An `EnvCapability` is the one shape every arrival environment is built from: a named,
composable contribution of **symbols** (verbs), **configuration** (per-env, validated),
**resources** (external ports), **prelude** (scheme bootstrap), and **deps** (grants). The
R7RS base, every SRFI, every dialect pack, and your domain tools are all this same shape;
`assembleEnv` C3-linearizes the dependency DAG and applies each capability once. There is no
second registration mechanism — if the stdlib can be built from capabilities, your tools can
too.

This file is the **cross-module contract** — the laws that span the capability machinery, the
membrane, provenance, resources, and the MCP layer. The per-API mechanics (the `symbol.*`
factory roster, tagged-template syntax, exact bake-gate error texts) live in the JSDoc of the
entry points: `common/symbol.ts`, `common/capability.ts`, `rosetta.ts`, `common/scheme-zod.ts`,
and `@inhuman.tools/arrival-mcp`'s `McpEnvCapability` / `tool`.

**The one law that governs everything below: dependencies point down, only down.** Verbs
depend on the capability machinery, the machinery lowers to the kernel's `EnvPack`, and the
kernel interprets nothing above itself. A capability never reaches sideways into another
capability's internals — it declares a `deps` edge and uses the granted names. A capability is
a **module singleton** (one `new EnvCapability(name, spec)`, exported as a value): the five
spec keys are a closed taxonomy, configured by composition, never subclassed.

## Contracts are codecs, not annotations

A rosetta contract's schemas are the membrane **crossing**, not documentation. `z.list(z.number)`
*is* the transform: the scheme proper-list decodes to a real JS `number[]` before the impl runs,
and the return encodes back through the output codec. The impl reads and returns plain JS; nothing
scheme-shaped leaks in. One contract has **four readers** that must agree — runtime validation, the
impl's inferred static types, the harvested `.d.ts` the type lens checks, and the crossing itself —
and declaring the honest codec is the single act that keeps all four in agreement. "Take the raw
value and sort it out inside" is a debt, not a shortcut.

`z.value` is the declared no-transform escape hatch, for slots **genuinely untypeable at the
boundary** (a value that must keep its scheme identity, an opaque handle, arbitrary-shaped data no
codec names). Every such slot is invisible to the type lens, unvalidated at the boundary, and barred
from `cacheClass: "view"` (a raw crossing doesn't serialize — the bake gate refuses it). Declare the
codec whenever one exists; `grep schemeToJsUntyped` is the audit list of every place the untyped
crossing was reached for.

## Two axes that never mix: lineage and cache

Every symbol carries a **provenance role** (the lineage axis — where results come from) and,
optionally, a **cache class** (a serialization/replay axis). They are orthogonal, and the same word
`pure` names a value on *each* — the standing trap for migrators.

- Lineage: `"source"` mints a fresh origin (external data), `"pipe"` forwards its inputs' lineage
  (a pure transform mints nothing), `"sink"` has no egress at all (an effect). The declaration is
  load-bearing, not documentation: a `"pipe"` that minted would fabricate origins — the
  seal-laundering class of bug — and the provenance seal and reverse slicer read this declaration
  directly.
- Cache: `cacheClass: "view"` is a persisted boundary snapshot (demands a serializable contract),
  `"pure"` is deterministic-from-args (recovery is re-call, nothing persisted), absent is the safe
  default (re-runs on replay). Both `view` and `pure` stay provenance `source` — a cacheable read
  still introduces external data (`infer` is the standing proof: a `source` declaring
  `cacheClass: "pure"`).

**Naming hazard.** Legacy `defineRosetta`'s `pure: true` meant provenance **pipe** (mints nothing).
Today's `cacheClass: "pure"` is a cache class **on a source**. Different axes, same word: a legacy
`pure: true` ports to `provenance: "pipe"`, never to `cacheClass: "pure"`.

## Effects are sinks, and danger is a property of the verb

An effect declares `provenance: "sink"` and returns **void by law** — the bake gate rejects a sink
whose contract carries a real return. Void-by-law is what makes **gather-then-burst** sound: a host
running in deferred mode collects sink penetrations instead of firing them, and because a sink's
contract *proves* it returns nothing, deferring it cannot change any value the program computes — the
run proceeds identically and the collected effects fire (or don't) as one reviewed burst. If an
"effect" must hand a result back into the program, it is not a sink — it is a source with
consequences, and it must say so.

Whether an effect is *dangerous* is a separate static fact — **danger is an attribute of the action,
not the argument set.** It is declared once at the verb (`tool.effect` for a plain mutation,
`tool.risky` for an irreversible one), on every call it will ever receive, never flipped by a caller
argument or a runtime condition.

## Dynamics belong to the rig, not to behavior

Describe-time personalization — a per-session catalog line, a live welcome screen — is sanctioned and
has a declared channel (`dynamicDescription`). A verb whose *runtime behavior* silently depends on who
is calling is not: an actor-dependent input is a **declared argument the actor passes**, visible in the
program text, never ambient state smuggled through the environment. Configuration reaches a baked verb
only through the builder form (`symbols: (activation) => ({…})`) precisely because inside a baked impl
`this` is the per-call invocation context, not the activation — so config cannot ride `this`, and
per-caller behavior cannot hide there either.

## Resources defer their reads

A `Resource<H>` is a factory of disposable handles (the Erlang-port model over TC39
`AsyncDisposable`): lazy spawn on first verb touch, single-flight parallel acquire, reconstruction on
wind-down with stable `Ref` identity. The absolute law over them: **anything that reads a resource must
defer the read to the moment it runs with a live activation.** Verb impls qualify — the first touch of
any of a capability's symbols pre-spawns *all* its resources before the body runs, so `.live` never
races. Describe-time surfaces qualify only if authored lazily: an `inputSchema` resolving against a
live handle must be a **getter**, a `dynamicDescription` a **thunk**. Reading `.live` at construction
time (module top-level, spec literal, constructor) is always a bug — no activation exists yet, and
eager reads at assembly are the connection storm the lazy model exists to prevent.

Corollary hazard: **an object spread fires getters.** `{ ...def }` performs `[[Get]]` on every own
enumerable property, firing a lazily-authored `inputSchema` getter with a receiver that has no
`resources`. Machinery that reshapes symbol defs moves **property descriptors**
(`Object.getOwnPropertyDescriptor` / `defineProperty`), never spreads; `McpEnvCapability`'s annotation
lift is the reference implementation.

## Scheme code declares its imports too

A `symbol.define` body is FV-checked at bake: every free variable must resolve to a sibling symbol, a
dep's export, or the keyword baseline, else the failure is a door naming the fix (declare the `deps`
edge, or bind it locally). This is the point — a capability's scheme code declares its imports the
same way its JS does, so the DAG stays honest and a capability never works only because something else
happened to be assembled first.

Assembly is **C3 linearization** (Python's MRO — cited, not invented) over the dep DAG:
identity-deduped, cycle-detected, each capability applied once, deps before dependents,
last-write-wins for a doubly-bound name (the nearer capability wins). The shared `config` bag is
reference-equal across a capability's root and dep appearances, so a diamond-shaped dep graph dedups
instead of conflicting. Disposal is LIFO.

## Doors, not walls

An omitted verb is a declaration, not an absence: `symbol.notImplemented` binds a **door** that throws
a teaching error carrying the reason and the alternative bound in *this* environment. The same posture
runs through the machinery — the sink shape gate, the view serialization gate, the free-variable law,
the alias-target check all refuse at bake with the fix in the message. Never withhold a symbol by
silently omitting it from the record; if a verb is absent because an optional config key wasn't
supplied, lower with `degradation: "doors"` so the absence carries its cause and the assembly's
`degraded` list enumerates it.

## Exposing a capability to agents (MCP)

`@inhuman.tools/arrival-mcp` turns a capability DAG into one MCP tool whose argument is an arrival
program. MCP wraps **intent, not impact**: expose verbs an actor means (`create-widget`, `anchor-to`),
never materialization knobs — danger, cacheability, and lineage are facts the verb declares about
itself, not levers a caller holds. The catalog aggregates across the whole `deps` closure, deps-first
and self-last, matching assembly's own precedence; a plain `EnvCapability` dep still grants live verbs,
just undocumented to the catalog.

Two run-time consequences of the laws above:

- The risky axis pays off at run time: a burst of plain effects fires immediately, but **any risky row
  holds the whole burst** behind a signed manifest (fill-or-kill) — nothing fires, not even a harmless
  sibling — until the client confirms.
- Dynamic metadata obeys the resource-deferral law: getters and `dynamicDescription` thunks resolve
  against the live activation per read, never eagerly; a `dynamicDescription` resolving `undefined`
  falls back to the static `description` and is *not* flagged session-generated — a failed live fetch
  degrades to the static truth, it doesn't fabricate.

## Testing a capability

Build a **tiny capability** inline in the test — one or two verbs closing over a local log — and drive
it through the same public entry a consumer uses (`exec`, or `DiscoveryTool.call` for MCP behavior). No
mocks of the machinery; the machinery *is* the subject. Assert on the **observable effect ledger** (the
closed-over log, the returned values, the thrown door text), never on internals. Name behavioral
invariants as law-style rows — one `it` per clause, the clause in the test name — so a failing row names
the violated clause, not a line number. A door's *message* is public surface: pin the teaching text,
not just the throw.

## Naming

- **Verbs by role intent, not implementation** — `stock-level`, not `query-inventory-db`. The
  materialization can change; the intent is the durable name. Kebab-case, `?` suffix for predicates.
- Capability names are `domain/thing` — the door's cause owner and the assembly's audit key, so make it
  legible. Subject-scoped packs declare the namespace once via `symbolPrefix` and keep the record keys
  bare.
- The doc line after `name: ` is the agent-facing catalog entry — prompt text; budget it like prompt
  text, warnings inline (`(irreversible)`).
