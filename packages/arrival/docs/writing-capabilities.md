# Writing capabilities

An `EnvCapability` is the one shape every arrival environment is built from: a named,
composable contribution of **symbols** (the verbs), **configuration** (per-env, validated),
**resources** (external ports), **prelude** (scheme bootstrap), and **deps** (grants). The
R7RS base, every SRFI, every dialect pack, and your domain tools are all this same shape —
`assembleEnv` C3-linearizes the dependency DAG and applies each capability once. There is no
second registration mechanism to learn: if the stdlib can be built from capabilities, your
tools can too.

Every code example on this page was executed against the built package before shipping;
outputs and error texts are real.

The one law that governs the whole file: **dependencies point down, only down.** Verbs depend
on the capability machinery, the capability machinery lowers to the kernel's `EnvPack`, and
the kernel interprets nothing above itself. A capability never reaches sideways into another
capability's internals — it declares a `deps` edge and uses the granted names. Everything
else in this guide is that law applied to one key of the spec at a time.

- [The smallest real capability](#the-smallest-real-capability)
- [Contracts are honest](#contracts-are-honest)
- [The escape hatch, and when it is right](#the-escape-hatch-and-when-it-is-right)
- [Two axes that never mix: lineage and cache](#two-axes-that-never-mix-lineage-and-cache)
- [Effects are sinks](#effects-are-sinks)
- [Configuration and the builder form](#configuration-and-the-builder-form)
- [Resources: ports that open on first touch](#resources-ports-that-open-on-first-touch)
- [Scheme-bodied verbs and composition](#scheme-bodied-verbs-and-composition)
- [Doors, not walls](#doors-not-walls)
- [Exposing a capability to agents (MCP)](#exposing-a-capability-to-agents-mcp)
- [Testing a capability](#testing-a-capability)
- [Naming](#naming)

## The smallest real capability

A capability is a **module singleton** — one `new EnvCapability(name, spec)` per module,
exported as a value. No factories, no subclassing for behavior: the spec's five keys are a
closed taxonomy, configured by composition.

```typescript
import { exec, EnvCapability, symbol, z } from "@here.build/arrival";

const inventory = new EnvCapability("demo/inventory", {
  symbols: {
    "stock-level": symbol.rosetta`stock-level: units on hand for a SKU`(
      { input: [z.string], output: [z.integer] },
      async (sku) => sku.endsWith("-9") ? 80 : 0,   // any real lookup goes here
    ),
  },
});

const [n] = await exec(`(stock-level "widget-9")`, { capabilities: [inventory] });
// 80
```

The tagged-template head is `name: doc` — the name before the first `": "`, the catalog line
after it. The contract's `input`/`output` are vectors of scheme-zod codecs; the impl is an
ordinary (optionally async) function over the **decoded** values. That decoding is the next
section, because it is the discipline the whole membrane stands on.

`symbol.rosetta` is the declaration kind you will write most. The others, for completeness:
`symbol.native` (impl over raw scheme values, no codec — contour primitives, stdlib
territory), `symbol.define` / `symbol.defineSyntax` (scheme-bodied verbs and macros — below),
`symbol.notImplemented` (a door — below), `symbol.alias` (a second name for a sibling —
below), and `symbol.tagless` / `symbol.sequence` / `symbol.keyword` / `symbol.macro`
(interpreter-kernel kinds; if you need one you are contributing to the language, not to a
domain pack).

## Contracts are honest

A rosetta contract's schemas are **codecs**, not annotations. `z.list(z.number)` does not
mean "please pass a list" — it *is* the crossing: the scheme proper-list decodes to a real
JS `number[]` before your impl runs, and your return encodes back through the output codec.
The impl reads and returns plain JS; nothing scheme-shaped leaks in:

```typescript
const stats = new EnvCapability("demo/stats", {
  symbols: {
    "mean": symbol.rosetta`mean: arithmetic mean of a numeric list`(
      { input: [z.list(z.number)], output: [z.number] },
      (xs) => xs.reduce((a, b) => a + b, 0) / xs.length,  // xs IS number[]
    ),
  },
});
await exec(`(mean (list 1 2 3 4))`, { capabilities: [stats] });  // [2.5]
```

One contract, four readers: runtime validation, the impl's static types (inferred — no
annotations on `xs`), the harvested `.d.ts` the type lens checks, and the membrane crossing
itself. Declaring the honest codec is what keeps all four in agreement; that is why "just
take the raw value and sort it out inside" is a debt, not a shortcut.

Kwargs verbs use `input: [], inputRest: { key: schema, … }` — the call `(verb :key value …)`
folds into one decoded object argument. This is the shape the MCP `tool` family
(below) pre-applies.

## The escape hatch, and when it is right

`z.value` is the declared no-transform slot: the impl receives (or returns) the raw scheme
value and does its own conversion. It exists for slots that are **genuinely untypeable at the
boundary** — a value that must keep its scheme identity (an already-provenance-stamped
fixture crossing untouched), an opaque handle threaded through, arbitrary-shaped data no
codec names:

```typescript
import { jsToScheme, schemeToJsUntyped, CONSTANT_CTX } from "@here.build/arrival";

const shapes = new EnvCapability("demo/shapes", {
  symbols: {
    "high-priority": symbol.rosetta`high-priority: filters records by priority`(
      { input: [z.value], output: [z.value] },
      (raw) => {
        const users = schemeToJsUntyped(raw);
        return jsToScheme(CONSTANT_CTX, users.filter((u) => u.priority > 10));
      },
    ),
  },
});
await exec(
  `(high-priority (list {:id "alice" :priority 15} {:id "bob" :priority 5}))`,
  { capabilities: [shapes] },
);  // [[{ id: "alice", priority: 15 }]]
```

It is an escape hatch, not a default. `schemeToJsUntyped`'s own contract says it plainly:
reaching for the untyped crossing to silence a type error on a value you *can* honestly type
is the smell the export exists to make visible — `grep schemeToJsUntyped` is the audit list.
The same goes for `z.value`: every such slot is invisible to the type lens, unvalidated at
the boundary, and barred from `cacheClass: "view"` (a raw crossing doesn't serialize — the
bake gate below enforces it). Declare the codec whenever one exists.

## Two axes that never mix: lineage and cache

Every declared symbol carries a **provenance role** — the lineage axis: where do this verb's
results come from?

- `"source"` (rosetta's default) — the verb introduces external data; its results **mint** a
  fresh origin.
- `"pipe"` — a pure transform; results **forward** the inputs' lineage, minting nothing.
- `"sink"` — an outbound effect; no egress at all (next section).
- (`"fan"`, `"transparent"`, `"loop"`, `"opaque"` name the rest of the vocabulary — stdlib
  and classifier territory.)

The declaration is load-bearing, not documentation — a `"pipe"` that minted would fabricate
origins (the seal-laundering class of bug), and the lineage reading is what the provenance
seal and the reverse slicer stand on:

```typescript
import { execState, schemeToJs, deepProvenance } from "@here.build/arrival";
import { EvalTrace } from "@here.build/arrival/provenance";

const feed = new EnvCapability("demo/feed", {
  symbols: {
    "fetch-name": symbol.rosetta`fetch-name: reads a name from the outside world`(
      { input: [], output: [z.string], provenance: "source" },
      async () => "carol",
    ),
    "shout": symbol.rosetta`shout: uppercases — a pure transform`(
      { input: [z.string], output: [z.string], provenance: "pipe" },
      (s) => s.toUpperCase(),
    ),
  },
});

const trace = new EvalTrace();
const { values: [v] } = await execState(`(shout (fetch-name))`, { capabilities: [feed], tap: trace });
schemeToJs(v, {});           // "CAROL"
[...deepProvenance(v)];      // [1] — shout forwarded; it minted nothing
trace.toolNameFor(1);        // "fetch-name"
```

Orthogonal to it — same word `pure` in the wild, **different axis** — is the cache class:

- `cacheClass: "view"` — a boundary snapshot worth persisting across runs. Demands a
  serializable contract; the bake gate refuses otherwise (executed):

  > CacheClassShapeError: snapshot: declared cache class "view" contradicts its own
  > contract — a view's cache entry must serialize, but this contract's output vector
  > carries a z.value slot (the declared raw escape hatch — raw crossings don't
  > serialize); declare "pure" (recovery = re-call) or narrow the slot to a data codec

- `cacheClass: "pure"` — deterministic from its decoded args; recovery is re-call, nothing
  is persisted.
- absent — regenerateable, the safe default: an undeclared verb re-runs on replay.

Both `view` and `pure` stay provenance `source` on the lineage axis — a cacheable read still
introduces external data. `infer` is the standing proof: a provenance source declaring
`cacheClass: "pure"`.

**Naming hazard** (verbatim from the machinery, because it will bite a migrator): legacy
`defineRosetta`'s `pure: true` meant provenance **pipe** — mints nothing. Today's
`cacheClass: "pure"` is a cache class **on a source**. Different axes, same word. A legacy
`pure: true` ports to `provenance: "pipe"`, never to `cacheClass: "pure"`.

## Effects are sinks

An effect verb declares `provenance: "sink"` and returns **void** — by law, not convention.
The bake-time shape gate rejects a sink whose contract carries a real return (executed):

```typescript
symbol.rosetta`save-note: persists a note`(
  { input: [z.string], output: [z.string], provenance: "sink" },  // real egress — contradiction
  (text) => text,
);
// ProvenanceRoleShapeError: save-note: declared provenance role "sink" contradicts its own
// contract — a sink is a port with no egress wire, but this contract's output vector
// carries a real return value
```

The correct shape is `output: [z.undefinedResult]`:

```typescript
const log: string[] = [];
const notes = new EnvCapability("demo/notes", {
  symbols: {
    "save-note": symbol.rosetta`save-note: persists a note`(
      { input: [z.string], output: [z.undefinedResult], provenance: "sink" },
      (text) => { log.push(text); },
    ),
  },
});
```

Void-by-law is what makes **gather-then-burst** sound: a host that runs programs in deferred
mode gathers sink penetrations instead of firing them, and because a sink's contract *proves*
it returns nothing, deferring it cannot change any value the program computes — the rest of
the run proceeds identically, and the collected effects fire (or don't) as one reviewed
burst. If your "effect" needs to hand a result back into the program, it is not a sink — it
is a source with consequences, and it should say so.

Whether an effect is *dangerous* is a separate, static fact — **danger is an attribute of the
action, not the argument set**. In the MCP layer this is a factory choice: `tool.effect` for a
plain mutation, `tool.risky` for an irreversible one. Riskiness is declared once, at the
verb, on every call it will ever receive — never flipped by a caller argument or a runtime
condition. The MCP section below shows what a risky verb does to a run.

## Configuration and the builder form

`configuration` is a record of **plain zod** schemas (not scheme-zod — config values are
host-side JS, nothing crosses the membrane), validated when the capability lowers. Note the
two imports; they are different vocabularies for different boundaries:

```typescript
import { exec, EnvCapability, symbol, z as sz } from "@here.build/arrival";  // contracts
import { z } from "zod";                                                     // configuration

const greeter = new EnvCapability("demo/greeter", {
  configuration: { prefix: z.string().default("hello") },
  symbols: ({ configuration }) => ({
    "greet": symbol.rosetta`greet: prefixes a name with the configured greeting`(
      { input: [sz.string], output: [sz.string] },
      (name) => `${configuration.prefix}, ${name}`,
    ),
  }),
});

await exec(`(greet "ada")`, { capabilities: [greeter] });                          // ["hello, ada"]
await exec(`(greet "ada")`, { capabilities: [greeter], config: { prefix: "yo" } }); // ["yo, ada"]
greeter.lower({ config: { prefix: 42 } });                                          // throws ZodError
```

The builder form — `symbols: (activation) => ({ … })` — is **how config reaches a baked
verb**: the builder closes `activation.configuration` (and `activation.resources`, next
section) into each impl. It is the only way, deliberately: inside a baked rosetta impl,
`this` is the per-call invocation context (`this.runCtx.signal`, `this.invocation`), *not*
the activation, so config cannot ride `this`. Static `symbols` record for config-free
capabilities, builder form the moment configuration or resources appear.

The `config` bag `exec` takes is shared across the whole capability set; each capability
validates only its own declared slice. Deps see the same raw bag — reference-equal by
design, so a diamond-shaped dep graph dedups instead of conflicting.

One boundary rule worth stating before you thread a per-caller value through config:
**dynamics belong to the rig, not to behavior.** Describe-time personalization — a
per-session catalog line, a live welcome screen — is sanctioned and has a declared channel
(`dynamicDescription`, in the MCP section). A verb whose *runtime behavior* silently depends
on who is calling is not: an actor-dependent input is a declared argument the actor passes,
visible in the program text, never ambient state smuggled through the environment.

## Resources: ports that open on first touch

A `Resource<H>` is a factory of disposable handles — the Erlang-port model over TC39
`AsyncDisposable`. The capability declares the ports it owns; the machinery wraps each in a
ref-counted cell with one operation (`get()` — acquire-if-needed, single-flight) and three
behaviors: **lazy spawn** (opens on first verb touch, not at assembly), **parallel acquire**
(concurrent callers share one in-flight open), **reconstruction** (wind-down disposes; the
next touch opens fresh; the `Ref` identity never changes).

```typescript
import { assembleEnv, execState, EnvCapability, LexicalScope, symbol, z } from "@here.build/arrival";
import { port } from "@here.build/arrival/resources";

let opens = 0;
const db = new EnvCapability("demo/db", {
  resources: {
    conn: {
      kind: "demo-db",
      async acquire() {
        opens++;
        return port({ rows: ["a", "b", "c"] }, () => { /* real close() here */ });
      },
    },
  },
  symbols: ({ resources }) => ({
    "row-count": symbol.rosetta`row-count: rows in the demo table`(
      { input: [], output: [z.integer] },
      () => resources.conn.live.rows.length,
    ),
  }),
});

const scope = LexicalScope.fresh("demo-session");
await assembleEnv(scope.env, [db.lower()]);
opens;                                       // 0 — assembly wired the verb, opened nothing
await execState(`(row-count)`, { scope });   // 3
opens;                                       // 1 — first touch spawned the port
await execState(`(row-count)`, { scope });
opens;                                       // still 1 — the handle is reused
```

`resources.conn.live` is synchronous and it is *correct* inside a verb impl: the first touch
of any of the capability's symbols pre-spawns **all** its resources before the impl body
runs, so `.live` never races. A `resources` entry may also be a provider
`(cfg) => Resource<H>` when the port needs parsed configuration (a connection string, a
project id).

The corollary is the deferral rule, and it is absolute: **anything that reads a resource must
defer the read to the moment it runs with a live activation.** Verb impls qualify (the
pre-spawn guarantees them). Describe-time surfaces qualify only if authored lazily — an MCP
`inputSchema` that resolves references against a live handle must be a **getter** (evaluated
per call with `this` = the activation), and a `dynamicDescription` must be a thunk. Reading
`.live` at construction time — module top-level, spec literal, capability constructor — is
always a bug: no activation exists yet, and eager reads at assembly are exactly the
connection storm the lazy model exists to prevent.

A hazard from production, so you don't rediscover it: **an object spread fires getters.**
`{ ...def }` performs `[[Get]]` on every own enumerable property — a lazily-authored
`inputSchema` getter fires at spread time with a receiver that has no `resources`, and either
crashes or (worse) captures garbage silently. Machinery that must move such fields moves
**property descriptors** (`Object.getOwnPropertyDescriptor` / `defineProperty`), never
spreads; `McpEnvCapability`'s annotation lift is the reference implementation. If you write
helper code that reshapes symbol defs, inherit that discipline.

Lifecycle: the lowered pack exposes `windDown()` (dispose every handle, keep wiring — next
touch respawns) and `resume()` (eager re-acquire) for hosts that pause idle environments.

## Scheme-bodied verbs and composition

`symbol.define` declares a verb whose body is scheme, with the same contract discipline as a
rosetta — the replacement for growing an opaque `prelude` text blob. `deps` edges are the
grants that make names visible:

```typescript
const strings = new EnvCapability("demo/strings", {
  symbols: {
    "shout": symbol.rosetta`shout: uppercases`(
      { input: [z.string], output: [z.string], provenance: "pipe" },
      (s) => s.toUpperCase(),
    ),
  },
});

const speak = new EnvCapability("demo/speak", {
  deps: [strings],  // the dep edge IS the capability grant
  symbols: {
    "exclaim": symbol.rosetta`exclaim: appends emphasis`(
      { input: [z.string], output: [z.string], provenance: "pipe" },
      (s) => `${s}!`,
    ),
    "speak": symbol.define`speak: shout with emphasis`(
      { input: [z.string], output: [z.string] },
      `(lambda (s) (exclaim (shout s)))`,   // own sibling + dep verb, both in scope
    ),
  },
});

await exec(`(speak "arrival")`, { capabilities: [speak] });  // ["ARRIVAL!"]
```

A define body is statically checked at bake: every free variable must resolve to a sibling
symbol, a dep's export, or the keyword baseline. The failure is a door naming the fix
(executed):

> symbol.define "speak2" @ demo/broken: free variable "string-append" is not in scope —
> declare a `deps` edge on the capability exporting "string-append", or bind it in
> "demo/broken" itself

That strictness is the point: a capability's scheme code declares its imports the same way
its JS does, so the DAG stays honest and a capability never works only because something
else happened to be assembled first.

Assembly is C3 linearization (Python's MRO — cited, not invented) over the dep DAG:
identity-deduped, cycle-detected, each capability applied once, deps before dependents,
last-write-wins for a name bound twice (the nearer capability wins). Disposal is LIFO.

Three smaller composition tools:

- **`prelude`** — a scheme bootstrap string evaluated at apply, after the capability's other
  symbols bind. Legacy-legible but analysis-opaque; prefer `symbol.define` for anything with
  a contract. A dep's prelude always precedes a dependent's.
- **`symbolPrefix`** — a namespace prepended to every symbols key at apply, so a
  subject-scoped pack registers bare names (`pslist`, `netscan`) and declares its namespace
  once (`"process/"`).
- **`symbol.alias`** — a sibling entry that dissolves to another entry's already-baked def:

  ```typescript
  symbols: {
    "sequence-length": symbol.rosetta`sequence-length: element count`(
      { input: [z.list(z.number)], output: [z.integer] },
      (xs) => xs.length,
    ),
    "len": symbol.alias`sequence-length`,   // binds the SAME def under "len"
  }
  ```

  The alias binds byte-identically to its target — no wrapper. Target must be a sibling in
  the same capability's own record; a missing target or an alias-to-alias refuses loudly at
  assembly. Aliases are deliberately invisible to the MCP catalog: an undocumented shorthand
  an actor can call, not a second catalog entry.

## Doors, not walls

An omitted verb is a declaration, not an absence. `symbol.notImplemented` binds a **door**:
calling it throws a teaching error carrying the reason and the alternative bound in *this*
environment (executed):

```typescript
const mail = new EnvCapability("demo/mail", {
  symbols: {
    "queue-message": /* … a real sink … */,
    "send-email": symbol.notImplemented`send-email: outbound mail is not wired in this environment — use (queue-message text) to leave a message for the operator instead`,
  },
});
// (send-email "hi") ⇒
//   send-email @ demo/mail is not available.
//     Why: outbound mail is not wired in this environment — use (queue-message text) to
//     leave a message for the operator instead
```

Doors beat silence everywhere in a capability: an agent that hits a named door self-corrects
in one turn; an agent that hits an unbound symbol guesses. The same posture runs through the
machinery you have already seen — the sink shape gate, the view serialization gate, the
free-variable law, the alias-target check all refuse at bake with the fix in the message.
Never withhold a symbol by conditionally omitting it from the record with no trace; if a verb
is absent because an optional config key wasn't supplied, lower with
`degradation: "doors"` and mint the door through `activation.degradation.door(...)` so the
absence carries its cause and the assembly's `degraded` list enumerates it.

## Exposing a capability to agents (MCP)

`@here.build/arrival-mcp` turns a capability DAG into one MCP tool whose argument is an
arrival program. `McpEnvCapability` is the thin subclass that carries the catalog layer:
per-verb `description`, `inputSchema`, `aliases`, `isTool`, `risky` — written inline on the
symbol defs (or riding a baked def's `metadata` bag), lifted off at construction into an
`annotations` record the runtime wiring never reads. The capability's own `description` is
the tool's top-level description — a self-contained declaration, no runner-side side bag.

The `tool` factory family is sugar over `symbol.rosetta` that pre-applies the axes from this
guide: bare `` tool`…` `` (unclassified — re-runs on replay), `tool.view` (cacheClass view —
demands a serializable output), `tool.pure` (cacheClass pure), `tool.effect` (provenance
sink, void by law), `tool.risky` (`tool.effect` + the static `risky: true` mark). All five
take kwargs shapes (`{ shape: { name: z.string } }`) and produce ordinary baked rosettas —
nothing here is a new symbol kind.

```typescript
import { DiscoveryTool, McpEnvCapability, tool } from "@here.build/arrival-mcp";
import * as z from "@here.build/arrival/scheme-zod";

const created: string[] = [];
const notes: string[] = [];

const widgets = new McpEnvCapability("demo/widgets", {
  description: "Widget shop — read freely; creation is held for confirmation.",
  symbols: {
    "create-widget": tool.risky`create-widget: creates a widget (irreversible)`(
      { shape: { name: z.string } },
      (args) => { created.push(args.name); },
    ),
    "log-note": tool.effect`log-note: appends a note (harmless)`(
      { shape: { text: z.string } },
      (args) => { notes.push(args.text); },
    ),
    "list-widgets": tool.pure`list-widgets: names of created widgets`(
      { shape: {} },
      () => created.join(","),
    ),
  },
});

const t = new DiscoveryTool("widgets", widgets, {});
```

`t.describe()` renders the MCP tool schema. The capability's `description` becomes
`Tool.description`; the verb catalog renders into the `expr` argument's documentation
(executed):

```
Domain-specific functions available in sandbox:
(create-widget) - creates a widget (irreversible)
(log-note) - appends a note (harmless)
(list-widgets) - names of created widgets
```

The catalog aggregates across the whole `deps` closure (`allAnnotations()`), deps-first,
self-last — a nearer capability's entry wins a name clash, matching assembly's own
precedence. A plain `EnvCapability` dep still grants live verbs; they are just undocumented
to the catalog, by design.

The risky axis pays off at run time (executed): a program whose burst contains only plain
effects fires immediately; **any risky row holds the whole burst** behind a signed manifest —
nothing fires, not even the harmless sibling — until the client confirms it (fill-or-kill):

```typescript
const session = { id: "s1", state: {} };
await t.call({ expr: `(log-note :text "hello")` }, { session });
// notes === ["hello"] — plain effects burst immediately, zero tax

await t.call({ expr: `(log-note :text "later") (create-widget :name "bomb")` }, { session });
// created === [], notes still ["hello"] — the WHOLE burst held; a manifest came back instead
```

Two dynamic-metadata rules, both consequences of the resource-deferral law:

- **Getters resolve against the activation, never eagerly.** An `inputSchema` getter or a
  `dynamicDescription` thunk runs per read, with `this` = the owning capability's live
  activation — so it may reach `this.resources.x.live`. The lift machinery moves these as
  property descriptors precisely so they survive un-invoked; a static catalog read that has
  no live activation renders the static floor instead of firing them.
- **Honest fallback.** A `dynamicDescription` resolving `undefined` falls back to the static
  `description` and is *not* flagged session-generated — a failed live fetch degrades to the
  static truth, it doesn't fabricate.

And the exposure boundary itself, stated once: MCP wraps **intent, not impact**. Expose
verbs an actor means (`create-widget`, `anchor-to`), never materialization knobs; danger,
cacheability, and lineage are facts the verb declares about itself, not levers a caller
holds.

## Testing a capability

The idiom that scales is the **tiny capability**: build a minimal capability inline in the
test — one or two verbs closing over a local log — and drive it through the same public
entry a consumer uses (`exec`, or `DiscoveryTool.call` for MCP behavior). No mocks of the
machinery; the machinery *is* the subject:

```typescript
function confirmCapability(log: { created: string[] }): McpEnvCapability {
  return new McpEnvCapability("confirm-caps", {
    symbols: {
      "create-widget": tool.risky`create-widget: creates a widget (irreversible)`(
        { shape: { name: z.string } },
        (args: { name: string }) => { log.created.push(args.name); },
      ),
    },
  });
}

it("a risky effect holds the WHOLE burst", async () => {
  const log = { created: [] };
  const t = new DiscoveryTool("t", confirmCapability(log), {});
  await t.call({ expr: `(create-widget :name "bomb")` }, { session });
  expect(log.created).toEqual([]);   // NOTHING committed — fill-or-kill
});
```

Assert on the **observable effect ledger** (the closed-over log, the returned values, the
thrown door text), never on internals. Name behavioral invariants as law-style rows — one
`it` per clause of the law, the clause in the test name ("a risky effect holds the WHOLE
burst", "the declined effect leaves no trace and is re-offered on re-run") — so a failing
row names the violated clause, not a line number. Error-path rows matter as much as happy
paths: a door's *message* is public surface; pin the teaching text, not just the throw.

## Naming

- **Verbs are named by role intent, not by implementation** — `stock-level`, not
  `query-inventory-db`; `create-widget`, not `post-widget-v2`. The materialization can
  change; the intent is the durable name.
- Kebab-case verbs, `?` suffix for predicates, scheme conventions throughout — the actor
  writes scheme.
- Capability names are `domain/thing` (`arrival/overridable`, `demo/inventory`); the name is
  the door's cause owner and the assembly's audit key, so make it legible.
- Subject-scoped packs declare the namespace once via `symbolPrefix` (`"process/"`) and keep
  the record keys bare.
- The doc line after `name: ` is the agent-facing catalog entry. One sentence, what the verb
  *does*, warnings inline (`(irreversible)`) — it is prompt text, budget it like prompt
  text.
