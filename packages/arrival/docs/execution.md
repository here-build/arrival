# The Run Model

> The mental model, stated once, ahead of the code. One `exec()` is a **run**: a hermetic
> unit of interpretation whose per-run state is minted once and carried on the values it
> builds, never reached for ambiently. This document says what that state IS, where it
> lives (data-local, not global), and how the five optional per-run seams — cache, effects,
> reads, notes, display — arm the interception facilities that turn a bare interpreter into
> a cacheable, burstable, read-guarded one. §12 SESSIONS is the CONSUMER view (sessions,
> scopes, budgets as a host wires them); the sections before it are the ontology under it —
> what the machine IS, so the wiring is the only shape it could take.

Section anchors are CAPS so code comments can cite `docs/execution.md §<ANCHOR>`. Each
section closes with its enforcement sites (files, no line numbers — those rot). Every claim
here is grounded in those files; when code and this document disagree, one is a bug — decide
which before writing a line.

Constitutional ground: PRINCIPLES.md (P0 two-layer coherence, P11 mint-at-the-edge),
environments.md (§HERMETIC the runtime/storage split, §MEMBRANE-SEAM the bake-side crossing this
model's chokepoint spins, §AXES provenance-role ⊥ cache-class), membrane.md (§REGION the
reverse-crossing discipline that closes the burst-bypass hole), PROVENANCE.md (§4, which owns
the SECOND meaning of "replay" — γ over frozen ingress).

---

## 1. HERMETIC — run-state is data-local

**One isolate runs concurrent runs; run-state that bled through a module-level holder would
cross between them.** A Cloudflare Durable Object shares one JS isolate across every request
it serves. Two `exec()` calls interleaved on that isolate must not see each other's strict
mode, allocation meter, cache, or effect log. The charter: **run-state is DATA-LOCAL** —
minted once per `exec()` by `new RunContext(...)`, carried on `AValue.ctx` (every value built
during the run holds the SAME `RunContext` reference), read off the threaded context at the
one hermetic point, never off an ambient singleton.

Three homes, by lifetime:

- **RunContext** — state CONSTANT for one run yet DIFFERING between concurrent runs: strict
  mode, the heap meter, the abort signal, the five channels. This is the run's identity.
- **Global singletons** — state constant across ALL runs: `nil`/`#t`/`#f`/`eof`. These bear
  no run-state, so they can be shared by reference. `car`-of-nil reads its strict projection
  from the THREADED context, not from the constant `nil`, so a constant carries nothing
  run-specific.
- **Dynamic-extent holders** — state varying by CALL DEPTH within one run: the
  exception-handler stack, the current call-site, the current region scope (membrane.md
  §REGION). These cannot ride a constant-per-run handle and stay the holder family (the
  `dynamic-call-site.ts` module-holder idiom, save/restore around the owning call, safe under
  single-threaded JS).

The test for where a fact belongs: does it vary between concurrent runs (→ RunContext), never
(→ global singleton), or within one run by depth (→ holder)?

*Enforcement sites: `run/RunContext.ts`, `heap-budget.ts`, `eval/generator-exec.ts`.*

## 2. CTX-SPECIES — live, constant

Two `RunContext` species exist; only the first bears run-state, and the charter (§1) rests
on the other being run-NEUTRAL.

- **Live-run** — minted by `new RunContext(...)` per `exec()`. Carries strict/meter/signal and any
  armed subset of the five channels. This is the only species a run mutates through (the meter's
  `used`) and the only one whose channels are non-`undefined`.
- **`CONSTANT_CTX`** — the frozen, run-neutral context carried by values that OUTLIVE any run:
  the singletons, quoted-literal AST nodes (`evalQuote` returns them by reference across runs),
  everything constructed at bootstrap before a run exists. `strict=false`, no meter, **all five
  channels `undefined`** — and that is correct, not a gap: a note or effect is addressed to ONE
  run, so a context outliving every run has nowhere to put one. **Nobody is listening.**

Because the constant species is run-neutral by charter, a value minted before or outside a run
drops the channels — never a leak.

**Parse-time source identity is not a ctx species.** It used to be (a retired `ParseContext`
subclass / `PARSE_CTX` / `makeParseCtx`): a one-hop envelope the Parser minted per datum purely
to hand a `SourceLocation` to the leaf minter one call later, which unwrapped `.location` and
stamped it on the value — the ctx itself was discarded immediately after and nothing else ever
read `origin` or a ctx's `.location`. It is now a plain `loc?: SourceLocation` argument threaded
directly from the Parser through `parse_argument`/`ADict.fromLiteralForms` to the leaf mints,
landing on the VALUE's own `.location` field (AValue) — no ctx involved, and no third species.

*Enforcement sites: `run/RunContext.ts`.*

## 3. CHANNELS — five independent seams, armed subset-wise

**`X | undefined ⇒ facility off.`** Each of the five channels on `RunContext` is an independent
per-run seam a host arms; each `undefined` means that facility is off (the default). A run may
carry any subset — they are siblings, none a field of another.

| Channel | Facility when armed | Off (`undefined`) |
|---|---|---|
| `cache` | membrane record/replay interception, per the mode law (§6) | no interception |
| `effects` | effect-burst gather arm — a `sink` enqueues instead of firing (§7) | a sink fires immediately |
| `reads` | read-tracking + the read∩write deferral guard (§8) | no tracking, no guard |
| `notes` | model-facing bookkeeping sink (§9) | notes dropped |
| `display` | host `(display …)` affordance sink (§9) | no display verb bound |

**One reader.** All five are read off `this.runCtx.<channel>` at the baked rosetta `run`
wrapper — the single hermetic point (§10). No other site consults them; a facility's whole
armed/off behavior is decided by whether the host passed a non-`undefined` value into
`new RunContext(...)`.

**One arming surface, stated once.** `ExecOptions` (`cache`/`effects`/`reads`/`notes`/`display`)
is the public door: a field set rides `new RunContext(...)` onto the matching `RunContext` channel;
a field omitted leaves it `undefined`. The per-channel `ExecOptions` field docs and the
`run/*` file headers describe the SAME wiring from two ends — the option is the entry, the
channel is the landing. There is no third landing and no transformation between them.

**`execExpr` deliberately drops the model-facing channels.** The single-form entry
(`require`, prelude eval) mints its `RunContext` with `{ signal, heapBudget, cache, effects,
reads }` — **`notes` and `display` are absent by construction.** Those two are the
model-facing channels (§9); `execExpr`'s callers are sub-program plumbing (a required module,
a bootstrap prelude), not a top-level model turn, so there is no renderer to drain a note into
and no `(display …)` a model authored. The drop is correct, but it is currently SILENT — the
`execExpr` doc names `cache`/`effects`/`reads` riding the handle and does not state that
`notes`/`display` are omitted. Stated here explicitly: **a note or display pushed from inside a
`require`d module is dropped, because `execExpr` binds no such sink.**

*Enforcement sites: `run/RunContext.ts`, `eval/generator-exec.ts` (`ExecOptions`, `execState`,
`execExpr`), `eval/exec-phases.ts` (`instantiate`).*

## 4. CALLCTX — the fused dispatch `this`

**`CallCtx` is the ONE `this` every callable body sees**, fusing the dispatch-level receiver
(`runCtx`) with the per-call-site provenance carrier (`invocation`) and the opt-in per-arg deep
provenance vector (`argProvenance`). Flat, not nested — every field is a cheap carrier, nothing
to defer.

**`runCtx` is NEVER optional.** `makeCallCtx` takes it as a required argument with no default.
A `= CONSTANT_CTX` default would be a LATENT HAZARD — the easiest landing spot for the next
errant fallback — not a convenience: every real dispatch site passes an explicit live `runCtx`,
so a default would only ever mask a wiring bug. The null-`this` case is uninhabited too: the
`this: CallCtx` annotation on the wrapper signatures makes an unbound call a COMPILE error, so
no runtime door guards a statically-excluded state (that would be dishonest-types theater).

**`testCallCtx()` is the sole sanctioned door to `CONSTANT_CTX`.** Tests and host code invoking
a verb impl outside a real dispatch build a REAL `CallCtx` over `CONSTANT_CTX` through this thin
wrapper. `CONSTANT_CTX` survives ONLY inside this explicit constructor — never as an implicit
`this?.` fallback threaded through a verb body. The consequence, load-bearing: a value minted
by a verb called through `testCallCtx()` carries no run-state, exactly as intended for a test
harness, and the moment production code reaches for `CONSTANT_CTX` at a dispatch site, that is
the bug this door's existence localizes.

*Enforcement sites: `run/CallCtx.ts`.*

## 5. BUDGETS — three bounds, first to fire wins

Three independent bounds cap a run; all three compose, and whichever fires first ends the
**call** (never the session — the scope and its definitions survive, so a REPL loop catches and
continues). The CONSUMER view — how a host arms them per call — is §12 SESSIONS; this section
states the mechanism they share.

- **`heapBudget` → `HeapMeter`** (allocation). The meter lives on `RunContext.heapMeter` ONLY,
  minted once per run. It **mints, it does not borrow**: it charges cells a capability
  MATERIALIZES (`filter`/`map`/`reduce`/`append`/`join`, at the `to_array` and sequence-op
  choke points, counted by input element BEFORE the op runs), never cells it BORROWS (a
  zero-copy read of a host container is not materialization). The rationale is the **TICK blind
  spot**: the wall-clock budget is checked at trampoline TICKs (loop-step / tail-call
  boundaries), but a native collection op runs its whole reduction in ONE synchronous JS loop
  that emits no TICK — so an O(K²)-churn loop (`(append acc x)` re-copying a growing list) runs
  uninterruptibly until it stack-overflows. Counting reductions can't see inside that loop;
  counting allocations can. String building and bigint growth allocate no list cells and pass
  under any cap by construction — bound what your capabilities mint, and reach for `signal` when
  a bound must also cover a slow native call.
- **`budgetMs`** (wall-clock). An INTERNAL bound — the trampoline itself throws once the deadline
  elapses, no external controller needed. Checked at the same TICK boundary, so it bounds
  interpretation time and cannot interrupt a run parked inside one native call (a 50ms budget
  over a native 200ms sleep returns at 200ms).
- **`signal`** (`AbortSignal`). The one bound that reaches into native calls, and the SAME
  reference the trampoline reads — so every consumer observes abort state off one handle that
  cannot drift.

**Meter span differs by entry, deliberately.** In `execState`/`exec` the meter spans the WHOLE
call — all top-level forms share one deadline and one allocation budget, so a sandbox program
that splits a hang across several forms is still bounded. In `execExpr` the meter is PER-FORM
(one expression, one meter) — a cumulative multi-form bound there would need a shared
`RunContext` no `execExpr` caller can inject yet.

*Enforcement sites: `heap-budget.ts`, `run/RunContext.ts` (`HeapMeter`), `eval/generator-exec.ts`
(the per-form loop, `execExpr`). Consumer view: §12 SESSIONS.*

## 6. MODE-LAW — record × replay × class

**THE single home for the record/replay table.** The mode law governs the membrane, not
storage: `mode: "record"` is a live run (the impl fires, its result is written);
`mode: "replay"` is a fold (a hit answers WITHOUT firing). The behavior per stamped cache class:

| class | record mode | replay mode |
|---|---|---|
| `view` | fire, write/OVERWRITE `{value}` (a settled entry never suppresses a live fire — fresh truth) | hit → serve, never re-fire; miss → fire + write (a NEW program's novel call is fresh) |
| `sink` | fire, write `{effect}` tombstone (two identical live sinks = TWO effects, always) | tombstone hit → skip (void); miss → fire (new intent, not a repeat) |
| `pure` | fire | fire — determinism from args is the CONTRACT; recovery = re-call, never stored |
| undeclared | fire | fire — regenerateable, the SAFE default |

The cache class is an EXPLICIT declaration on the contract, never derived from the lineage role
(environments.md §AXES: the two axes are orthogonal — `infer` is a provenance SOURCE declaring
`cacheClass "pure"`, the standing proof). An undeclared, non-`sink` def never touches the
serialized cache.

**SINGLE-FLIGHT — `view`/`pure` only, rejection evicts.** Concurrent identical penetrations
WITHIN one run share ONE rosetta call (each invocation lives in an immutable world, so the
second gains nothing by re-firing). The in-flight promise registers at call start, scoped to
`view`/`pure` and NEVER `sink` (two live effects are two effects). A REJECTED promise is never
cached — rejection evicts the pending entry, so retries are allowed and a transient failure
never pins as a stored error. Only SETTLED entries serialize.

**The cache is RUN-level.** `RunCache` deliberately carries NO session plumbing — no epoch,
roster, or configDigest identity, no TTL. The SESSION layer checks cache validity BEFORE handing
a cache to a run: on mismatch it drops the cache and keeps the log. A rehydration builds a NEW
`replay` cache OVER a recorded one's entries; mode is fixed at construction and a live cache is
never flipped.

*Enforcement sites: `run/run-cache.ts` (`penetrateThroughCache`, the table), `common/symbols/_bake.ts`
(`assertCacheClassShape` — the class gate), `common/symbols/rosetta.ts` (the chokepoint that
applies it).*

## 7. BURST — the ordered, non-deduplicating effect arm

**`EffectLog` is the ORDERED sibling of `RunCache`.** Where the cache is a content-keyed,
deduplicating `Map`, the effect log is a plain append-only sequence: two identical sink calls
are two entries, ALWAYS — the mode law's "two effects, always" (§6) holds for the burst arm
exactly as for the tombstone arm. The log remembers WHAT was gathered, in WHAT order, and at
what read-clock; it does not judge whether replaying against a moved world is safe (that is the
read guard, §8).

**The gather condition, named ONCE here** (three files repeat the predicate): a `sink`
penetration gathers instead of firing when it is a PRIME run —

```
sink && effects !== undefined && cache?.mode !== "replay"
```

The `cache?.mode !== "replay"` clause excludes a fold: a fold re-executes settled history
through the tombstone-skip path (§6) and must never gather twice. When the condition holds, the
penetration enqueues `{verbName, decodedArgs}` (plus the read-clock, §8, and the raw pre-decode
args for a confirmation manifest) and **returns `undefined`** — a third interception mode
alongside plain-fire and record/replay-tombstone.

**Sound because the program structurally cannot observe the deferral.** The sink's return is
`undefined`; the void-family bake gate guarantees a `sink` verb's contract yields nothing a
program can read, so deferring the fire past the statement changes no observable value. That is
the bake-time proof the runtime law stands on (§10).

**POISON RULE.** A failed burst leaves the log AS-IS — the log never drops an entry and never
self-polices. The CALLER decides whether a poisoned log is drained again; the entity carries no
retry policy.

**Drain: strict order, no retry.** `burst` fires each entry through a caller-supplied executor
in strict index order, one pass, no reordering. A mid-entry throw stops the drain IMMEDIATELY
and rethrows `BurstDrainError` carrying the failing entry's position and the entries that never
ran. **The caller owns rollback** — `burst` has no side effects beyond the executor; the real
burst (plexus region, atomicity, conflict handling) is HOST territory, and arrival only wires
the gather.

**The burst-bypass hole, and its closure.** A reverse lambda (a Scheme callable handed to host
JS) that calls a sink verb must hit the burst arm, not fire inline — otherwise a deferred effect
escapes gathering. This is closed by REGION SCOPE: the callable's arguments box under
`scope.runCtx` (the invocation's LIVE context carrying `effects`), so a lambda calling a sink
re-enters through `this.runCtx.effects` and gathers. The hazard shape and the bake-side gate
that steers `z.value` slots to `z.procedure` (so no callable marshals under a stale scope after
an `await`) live in membrane.md §REGION — cross-linked, not duplicated.

*Enforcement sites: `run/effect-log.ts` (the log, `burst`, `BurstDrainError`), `run/run-cache.ts`
(`penetrateThroughCache` — the gather condition), `common/symbols/rosetta.ts` (the chokepoint +
the region-scope re-entry). Cross-link: `docs/membrane.md §REGION`.*

## 8. READ-GUARD — a burst must not read its own deferred write

**The one rule that makes gather-then-burst sound:** a program that enqueues a sink and THEN
reads something that sink will write cannot run as a deferred burst — the read would observe
PRE-write state where sequential execution observes POST-write state. That shape is detected and
doored; everything else (query-then-mutate, mutate-disjoint-then-read) runs untouched.

**The fencepost — 1-based read clock vs 0-based enqueue clock — is load-bearing.**
`ReadEvent.clock` is 1-BASED (the Nth read has `clock === N`, the read counts itself).
`EffectEntry.enqueuedAtReadClock` is 0-BASED ("how many reads completed before this enqueue" =
`reads.log.length` at enqueue time). Pairing them makes `read.clock > enqueuedAtReadClock` a
TIE-FREE test: if zero reads preceded an enqueue (`enqueuedAtReadClock === 0`) and the very next
read is the first observed (`clock === 1`), then `1 > 0` correctly flags it as after. A
same-basis comparison would tie exactly this case — the canonical enqueue-then-read violation,
the one case the guard exists to catch.

**SEAM, not a mobx integration.** Arrival core has ZERO runtime dependency on mobx or plexus.
`ReadTracker` is an INJECTABLE interface arrival only calls through; the real mechanism (a mobx
tracking context over plexus-observable reads) lives with the plexus-facing HOST and is armed
onto `RunContext.reads` the same way `cache`/`effects` are. A run with no tracker pays nothing.

**`writeSetOf` abstains honestly.** The write-set is PREDICTED at enqueue (there is no live burst
region to observe), via a host-supplied resolver answering "which read-keys will this effect's
write touch." A resolver that cannot derive a footprint for an entry returns `undefined` — the
entry is SKIPPED, not treated as "no writes." A host that cannot predict footprints at all does
not arm `writeSetOf`, and the guard degrades to a no-op — never a false negative dressed as fact,
never a crash on incomplete information.

**Guard region = EXECUTION only; one top-level form = the region unit.** The eval loop wraps each
top-level form in `reads.tracker.region(...)` (async-shaped, because form evaluation awaits at
budget boundaries — a mobx `Reaction` does not survive an `await`, so the host owns a scope that
does). After each form, for a PRIME run gathering effects (mirroring the burst arm's own
`cache?.mode !== "replay"` gate — a fold never gathers, so it never needs a guard),
`checkReadWriteGuard` runs over the log so far. The guard is NEVER re-checked at a post-burst
serializer walk — the eval loop performs no such walk. First violation throws
`ReadYourDeferredWriteError`, the teaching door naming both halves (which effect, which later
read) and routing the caller: put the read in a follow-up call (the effect will be committed by
then), or drop it.

*Enforcement sites: `run/read-guard.ts` (`ReadEvent`, `checkReadWriteGuard`, the error door),
`eval/generator-exec.ts` (the per-form region wrap + the post-form check).*

## 9. SINKS — the return channel must never lie

Both model-facing channels are leaf sinks (zero imports) riding `RunContext`, scoped to ONE run
so nothing leaks across concurrent sessions, and both drain once at end of call.

**LAW — the return channel must never lie.** When the kwargs tolerance drops a far-unknown
argument key and lets the call proceed (dropping `:limit 10` against a tool with no `:limit`
beats crashing over an argument that changes nothing), a SILENT drop would be a lie of omission
— the model still believes `:limit` was honored. So the dropped key is surfaced as a **note**.
Every "nothing happened" must name WHICH nothing it is.

- **`NoteSink`** carries SESSION BOOKKEEPING — facts ABOUT the call, not results OF it —
  rendered into a `#| ── environment notes ── |#` reader-comment footer that parses to zero
  forms, so the model tells bookkeeping from answer at a glance. It dedups (one tolerance can
  fire on several calls to the same tool; the model needs the fact once). NOT for per-statement
  teaching (a door explaining a mistake belongs on that statement's own error) and NOT part of
  the answer. The note belongs to the RUN, not to any value inside it — a WeakMap keyed on the
  decoded argument object would be undrainable, because the renderer never sees that object.
- **`DisplaySink`** backs `(display …)`, which arrival itself does NOT and will not provide:
  ports and IO are omitted by design (a pure inference plane has no value-construction site to
  give an ambient write provenance). A model reaches for `(display x)` as the natural "show me
  this" idiom, so the MCP runner binds it as a HOST AFFORDANCE — identity plus a side effect into
  this sink, the value flowing on untouched so composition is unaffected. Intent honored without
  the language acquiring an IO surface.

*Enforcement sites: `run/note-sink.ts`, `common/symbols/rosetta.ts` (the tolerance-note drain),
`eval/generator-exec.ts` / `eval/exec-phases.ts` (channel arming — and the §3 `execExpr` drop).*

## 10. CHOKEPOINT — where the run model attaches

**One site carries the whole run model at runtime: the baked rosetta `run` wrapper.** It is the
single point where args are decoded and the impl has NOT yet fired — so the mode law (§6), the
burst arm (§7), and the read-clock stamp (§8) all attach there, reading `cache`/`effects`/`reads`
off `this.runCtx`. The interception is `penetrateThroughCache`; provenance mint, encode, and
attestation then run over the result exactly as over a fresh impl return (values are never
restored AROUND the membrane, only THROUGH it).

**Fast-path bypass.** A run with neither a cache nor an effect log skips
`penetrateThroughCache` entirely (`runCache === undefined && runEffects === undefined` → bare
`fire()`) — byte-identical to a pre-cache interpreter. A run with an effect log but no cache
must still reach the chokepoint (the burst arm lives inside it), which is why the bypass gates
on BOTH being absent, not just the cache.

**The bake-time gates the runtime law stands on.** Two properties the wrapper's runtime behavior
assumes are PROVEN at bake, once, off the same normalized schemas:

- **Sink-void** — a `sink` verb's contract yields nothing a program can read, so deferring its
  fire (§7) is unobservable. The void-family bake gate makes the unreadable-return shape a
  declaration fact, not a runtime hope.
- **View serializability** — a `view` cache entry MUST serialize, so `assertCacheClassShape`
  rejects at bake any `view` contract carrying a `z.lambda` arm (a callable is not a boundary
  snapshot) or a `z.value` slot (the raw escape hatch, by definition not serializable) — on
  BOTH vectors, because an input escape hatch breaks the cache KEY (`canonicalJson` over decoded
  args) and an output one breaks the ENTRY. The author's way out is declaring `pure` (recovery =
  re-call, nothing persists) or nothing.

*Enforcement sites: `common/symbols/rosetta.ts` (the `run` wrapper), `common/symbols/_bake.ts`
(`assertCacheClassShape`, the void-family / callable gates), `run/run-cache.ts`
(`penetrateThroughCache`).*

## 11. TWO-REPLAYS — one word, two mechanisms

The word "replay" names two different things in this package; conflating them is a category
error.

- **Run-model replay** (this document, §6) — re-execution of the statement log with a
  `RunCache` in `mode: "replay"` ANSWERING THE MEMBRANE. A `view` hit serves a stored decoded
  value; a `sink` tombstone skips; `pure`/undeclared re-fire. The durable twin of a run is
  `(program, cache)`, and a cache can outlive its program to answer a full re-run of a NEW
  program over the SAME cache (content-keyed, so only `(node, args)` survives a program edit).
- **Provenance γ-replay** (PROVENANCE.md §4, which OWNS it) — `apply` of a wire lambda to
  RECORDED INGRESS in a hermetic env under region discipline. γ **never re-invokes a source**;
  the frozen retrospective mint records are authoritative. It runs in a SILENT region (doors
  active, stream emission off) and is a pure query over a `(template-hash, ingress)` pair.

**The shared seam, stated once:** for a `pure` symbol both mechanisms recover the same way — by
RE-CALL, because determinism-from-args is the contract. Run-model replay stores nothing for
`pure` (recovery = re-call); γ re-derives a pure-selector mux's decision rather than recording
it (purity re-derives). One principle, two layers: what is deterministic from its inputs is
never stored, only recomputed.

*Enforcement sites: `run/run-cache.ts` (run-model replay). γ-replay: `provenance/replay.ts`,
specified in `docs/PROVENANCE.md §4` — cited, not absorbed.*

---

## 12. SESSIONS — the consumer surface: sessions, scopes, budgets, the CLI

*(The consumer view of §1–§11: how a host wires sessions, scopes, and budgets over the run
model. The ontology is above; this is the surface a host holds.)*

**`exec` is one-shot; `execState` is session-shaped.** `exec` runs a program and returns plain
JS values. Everything session-shaped — a REPL, a long agent conversation, a multi-step pipeline
— is `execState`, which returns `{ values, scope, runCtx }`: the run's `scope` (where `define`s
landed) and its `runCtx` (the per-run hermetic knobs, §1).

**Definitions accumulate through the scope; the returned `scope` IS the object you passed in.**
Thread `s1.scope` into the next call and the session continues — nothing is resent, and identity
holds (`s1.scope === s2.scope`). To name a session up front, mint one with `LexicalScope.fresh(name)`
and pass it to every call.

```typescript
const session = LexicalScope.fresh("agent-session");
await execState(`(define greeting "hello")`, { scope: session });
await execState(`(string-append greeting " world")`, { scope: session }); // "hello world"
```

`LexicalScope.fresh()` is an isolated lexical root — a second `fresh()` scope does not see the
first's names. Isolation is exactly *lexical*, never a crippled stdlib: builtins are not part of the
scope, they resolve through the run's capability base.

**Vocabulary and memory are orthogonal: `capabilities` are per call, `scope` carries.** A session
can gain or lose tools mid-way without losing its state — `capabilities` decide what verbs *this
call* may use, `scope` decides what definitions persist.

**Budgets are per call and compose, first to fire wins.** A budget error ends the *call*, not the
session — the scope and its definitions survive, so a REPL loop catches, reports, and continues. The
three bounds (`heapBudget`, `budgetMs`, `signal`) and their edges are §5 BUDGETS.

**The CLI over this surface.** `@inhuman.tools/arrival-cli` is a REPL over exactly this
scope/capability surface — one `LexicalScope` per session, budgets per form, capabilities armed per
call. It is this library API's first consumer, not a different model.

*Enforcement sites: `eval/generator-exec.ts` (`exec`, `execState`), `eval/LexicalScope.ts`
(`LexicalScope`).*
