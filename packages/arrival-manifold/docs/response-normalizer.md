# Response Normalizer — container-only, observation-trusted, monotonic shape contract

This is the cross-module design of the response normalizer. Each recognizer's *earned
guards* live in the module that owns it — `normalizer/csv.ts` (§4.1), `normalizer/toon.ts`,
`normalizer/python-literal.ts`, `normalizer/json.ts`, `normalizer/detect.ts` (§4.2),
`normalizer/ladder.ts` (§6) — and are not restated here. This doc holds only what spans
those modules: the staged pipeline, the trust cuts, the zone split, the validation
methodology, and the design stances (floor, non-conformance, cross-session persistence).

Companion to [`tool-signature.ts`](../src/tool-signature.ts)'s `-> shape` catalog surface and
[`args-error-reporting-v2.md`](./args-error-reporting-v2.md), which fix the *input* boundary;
this one fixes the *output* boundary — the shape a tool's response presents to the model.

## 1. Problem evidence

MCP tool responses reach the scheme arm as raw `jsToScheme` values. Two failure classes recur:

1. **Per-turn shape entropy (drift origin).** A tool returns a bare object one call, a
   many-element result the next. Code written `(:field resp)` breaks the turn an array
   arrives — or vice versa. The scheme arm wants to write code *once* against a stable type;
   a shape that shifts under it breaks the program mid-trajectory. This is the arbitrary-
   entropy failure the manifold exists to remove.

2. **Inert non-values.** `{error: …}` arrives as a value the model must notice-and-branch on
   (and often doesn't). `{status:'success'}` with no payload reads as a result. A serialized
   structure (`"[{…}]"`, CSV text) arrives as an opaque string the model must hand-parse.

The normalizer is a membrane layer that (a) de-serializes recognized serializations, (b)
applies universal container-hygiene rules, (c) stabilizes each tool's response shape into a
monotonically-widening declared contract, (d) optionally persists that contract across
sessions under a skeptical, self-healing invalidation rule.

## 2. Scope boundary — generalized rule vs task-tuned hack

The claim is narrow and positive: **the medium is the bottleneck** — same model, a better
capability surface (one REPL tool + the MCP tools as prelude symbols), measure the delta.
That isolates a middleware-only boost, so every transform must be totalic and
environment-general, not fitted to a task's answer. The operational test every rule passes:

> **Would this rule ship, unchanged, to an unseen MCP server we have never run?**

- **Pass ⇒ in scope.** Structural, programmatic, environment-general — *even if it helps.*
  "Unwrap a single-key `{result|data|…}` wrapper" ships to any server.
- **Fail ⇒ out.** Anything shaped to a specific task's answer, or hand-fitted to one server's
  quirk in a way we'd tweak per-server. That is fine-tuning wearing a rule's clothes.

Two corollaries make the test operational:

- **Task-independent (structural, never answer-keyed).** Every rule keys on response
  *structure*, never on task text, claims, or any answer. The optional persistent store (§8)
  is *structurally incapable* of holding a task or payload — its value type is a shape-
  signature only.
- **Reliability, not principle, gates parsing.** We *may* parse anything with a canonical,
  round-tripping parse (`serialize(parse(s)) ≈ s`). Ad-hoc prose (git logs, weather, fetch)
  stays untouched **because it has no reliable parse**, not because parsing it would cheat.
  The absence-string case (`"No book found…"`) is handled *structurally* (a scalar arriving
  for a ladder-asserted collection is a kind-mismatch, §6.2) — English is never regexed.

**Two levers, isolated.** In-session shape stabilization is symmetric-in-principle (either
arm's medium could do it) and is part of the medium claim — it stays on. Cross-session memory
(§8) is a *second* lever (accumulated state across tasks) that would conflate a medium-only
measurement, so the persistent store is **off for any comparison run** and reported as a
separate delta if measured at all. Not a fairness confession — variable isolation.

**Disclosed exhaustively, as spec.** The scheme arm carries a normalizer; native gets raw
strings. Every transform is named plainly: deserialize, unwrap-container (C1), error-throw
(C3), structural non-conformance door (§6.2), shape-stabilization (§6), and the optional
cross-session prior (§8). This is the adaptation surface stated as spec, not a list of
concessions.

### 2.1 Two trust cuts

The normalizer's guarantees rest on *observed runtime structure*, not declared schema, and
reach only the *container*, not inner fields:

1. **Declared vs observed.** A declared `outputSchema` is at most a *provisional prior* (§8) —
   loaded as a hypothesis, confirmed or discarded by the first live response. Never a trusted
   contract on its own. Observation is the only ground truth.
2. **Container vs inner-field.** Container structure, once observed, is trusted and
   normalizable. Inner fields are reported *exactly as observed* — never optional-typed.
   Servers do not reliably honor their own schemas, so field presence is known only as
   seen / not-seen; the normalizer never asserts a field is optional or required. The
   descriptive `-> shape` catalog may still *mention* fields (explicitly descriptive, never
   typed); the normalizer's transforms never depend on any inner-field type claim.

## 3. The staged pipeline — recognizers, not universal rules

Not a universal rewriter: a bounded expert system with recognizers ("I know these shapes") and
an explicit default of hand-back-untouched ("and I know where I stop"). Precision over
coverage. The strictness guards in each recognizer module are *earned* — each is the exact
guard whose absence mangled a held-out server (§5).

**The ecosystem's real container is the MCP protocol envelope** (`content:[{type,text}]` ·
`isError` · `structuredContent`), NOT a payload wrapper key — across the survey an
author-chosen `{result|data|…}` box was essentially never the top-level container. So the
pipeline is staged on the *envelope* the manifold already sees in `unwrapToolResult`
(`server.ts`), not on payload-key sniffing.

**Seam.** The normalizer operates on **JS values, extending `unwrapToolResult`, and runs
BEFORE `jsToScheme`** (`bind.ts` lifts the final JS value into scheme). It is not a
post-`jsToScheme` pass.

```
CallToolResult
  Stage A — envelope (in unwrapToolResult):
    A0  JSON-RPC / transport error                → throw   [ALREADY HANDLED: callTool catch]
    A1  isError:true                              → throw(recoverable, texts joined)  [error door]
    A2  structuredContent present                 → it IS the value → Stage C         [PRIMARY path]
    A3  else                                      → content blocks → Stage B
  Stage A′ — binary pre-pass (ORTHOGONAL, before B dispatches; existing behavior):
       any binary block is replaced in-value by a `#<attachment N: mime, NNN bytes>` STUB and the
       original passed through the quota'd AttachmentCollector. A lone binary block collapses to
       that stub STRING. Binary is NEVER preserved in-value — "never drop the image" means the
       attachment channel, not in-value block preservation. B then sees a text-only block list.
  Stage B — content-block extraction / deserialize (first match; else LIMIT):
    B1  exactly 1 text block:  JSON | NDJSON | CSV/TSV | TOON | Python-literal | prose+embedded
                               structure  → parse → Stage C   (each recognizer strict-or-refuse;
                               guards live in its module) ; else raw string ⟂ LIMIT (opaque)
    B2  ≥2 text blocks:  ALL valid JSON → vector-of-parsed → Stage C ; else block array ⟂ LIMIT
    B3  0 / non-text blocks          → per Stage A′ (stub) or block array   ⟂ LIMIT
  Stage C — payload container (first match; else identity). ERROR BEFORE UNWRAP:
    C3  STRICT in-band error — checked FIRST:
          single-key {error} or {errors} — AT ANY VALUE KIND (object, array, string), OR
          {ok:false} / {success:false} whose value is literally `false`, as the whole payload
                                     → throw(recoverable; the error value rides intact)
    C1  STRICT single-key container — object has EXACTLY one key, value is the sole array/object,
          AND the key is STABLE for this tool across calls (dynamic-key guard, §4.1)
                                     → unwrap
    C4  else                         → identity (parsed value as-is)    ⟂ LIMIT
  Stage D — shape ladder (§6). Observes the POST-Stage-C value (for the prose-envelope case,
       `.value`, never the `{raw,value,prefix}` shell — the shell's keys must not pollute `T`).
```

`⟂ LIMIT` = hand back untouched, never mangle. B1-else, B2-else, B3, C4 are the honest
ignorance.

**Why C3 precedes C1.** C1's "exactly one key, value is the sole object" matches
`{"error":{"code":429,…}}` — a C1-first order unwraps it and hands the model an **error as a
success value**, then object-asserts the tool on error-shape keys. GraphQL `{"errors":[…]}` is
worse: C1 unwraps to a bare vector of error objects *presented as results*. Errors are checked
first, at any value kind.

**Trapped-serialization re-dispatch — narrow and non-recursive.** A serialized string arriving
*as the container payload* (A2's `structuredContent` is a string, or C1 unwrapped a single-key
container whose value is a string) is re-dispatched **once** through B's format detection.
Bounded: **never** re-dispatch a value that is itself the *output* of a B parse (`"123"`
parses to the string, an id — re-dispatching yields the number `123` while `"0123"` survives:
type corruption keyed on digit content); **depth 0** — no recursion into payload fields (a
recursive read would sniff every string field as CSV/JSON). This preserves the literal-string
opt-out (a server needing a literal JSON-valued string declares an outputSchema): re-dispatch
fires only on a round-trip-parse to a *structured* format; a scalar-yielding parse is refused.

**Downstream surface.** After normalization the model sees the value through response elision
(`manifold-tool.ts`, `DEFAULT_MANIFOLD_OBSERVATION_ELISION` — head/tail item limits). Vector-
always promotion (§6) feeds directly into that limit; any ladder change must be read against
elision.

**Constraint — C3 throws are not args failures.** A Stage-C throw propagates through
`bind.ts`, which annotates *any* `tool.invoke` rejection with `ARGS_REJECTION` metadata
(`sentArgs`) intended for **argument** failures. A C3 in-band-error throw must NOT acquire that
metadata — it would mis-route the args-error door. (Also: `tracker?.record` must be pinned to
hash the raw or the normalized result, not left ambiguous.)

## 3.5 The zone architecture — declared-auto, inferred-flagged

Supersedes always-on inference for everything below Stage A:

- **Declared zone — automatic, no flag.** The server's own typed channels: `isError` → door,
  `structuredContent` → value. Zero ambiguity. Plus the grandfathered single-text-block
  `JSON.parse` (`server.ts`) — shipped behavior, object/array-yield only (scalar strings stay
  strings).
- **Inferred zone — model-invoked, never automatic.** Every other recognizer (CSV/TSV, TOON,
  Python-literal, NDJSON, prose-envelope, C1 unwrap) is exposed two ways:
  1. **Parsers as first-class prelude functions** — `json`, `csv`, `toon`, `py-literal`,
     `detect-parse` — pure, inline-usable: `(csv (tool/read-file :path "x.csv"))`.
  2. **`auto-parse!` sugar** — rebinds a tool through `detect-parse` so subsequent calls
     return parsed values. A rebind the model performs on itself is not drift — drift is
     *unchosen* change.
- **The Montessori header teaches, never decides:** "tool `x` returns opaque text that
  round-trip-parses as CSV — `(auto-parse! x)` or `(csv …)` to use it structured."
- **Doors fire in the declared zone only.** A `structuredContent` kind-violation is a contract
  breach → door. A kind change in opportunistically-parsed text is information → announce,
  never door (the read_file trap is structurally unreachable).

Class-wise, this moves intent questions ("whole answer or a page of it?") to the model, which
knows its intent. C1's cold-session flip-flop vanishes because C1 requires per-tool
key-stability evidence (§4.1) — there is no cold-session auto-unwrap; the ladder's canonical
shape is always the pre-unwrap value.

## 4. Recognizer tiers — where the guards live

The per-recognizer guards are **owned by their modules**, each carrying the held-out failure
that earned it. This doc keeps only the cross-cutting stances and the rejected alternatives.

- **§4.1 Precision tier** (`json.ts`, `csv.ts`, plus C1/C3 in the Stage-C pipeline): every
  guard is strict *because* the loose version mangled a held-out server — they are the safety
  property, not preferences. Cross-cutting orderings that span modules: **A before B**
  (`structuredContent` is authoritative; a B-first read extracts garbage), **C3 before C1**
  (§3), **C1 stable-key gated** (a map keyed by id, `{"u1":{…}}`, is one key with an object
  value — unwrapping strips the id AND flips shape with request arity, the very entropy §1
  removes; so C1 fires only when the single key is STABLE for this tool across calls, evidence
  held in Stage D). The strict CSV/TSV guards live in `csv.ts`.

- **§4.2 Reach tier** (`python-literal.ts`, `toon.ts`, `json.ts` NDJSON, `detect.ts`
  envelope): added only because they recurred across held-out servers, each with a
  deterministic round-tripping parse (`serialize(parse(s)) ≈ s`, no key reorder, no number
  reformat). Their subset restrictions and refusal classes are in the module headers.

  **Considered and rejected:**
  - **C2 type-discriminated union — rejected.** `{type:"table"|"ok"|"error"}` is a hardcoded
    *value*-list — the fitted enumeration §4.1 avoids on the key side — sourced from one
    server, with no clean extraction spec. It fails §2's ship-to-unseen test (`type:"success"`
    misses; GeoJSON's `type:"Feature"` shows why loosening is worse). If it returns, it returns
    as a per-tool **capability** (§4.4), not a universal rule.
  - **Exec named-blocks `{stdout,stderr,exit_code}` — dropped.** MCP text blocks carry no
    `name` field; this was one server's out-of-spec extension with a single sighting. Most exec
    servers flatten to prose and correctly stay opaque.

### 4.3 Floor — deliberately at LIMIT (measured-capability boundary)

Left uncaught on purpose. A structural recognizer either can't detect these, or would be
fragile enough to mangle legitimate content — and **native is equally blind**, so leaving them
is not a scheme-arm disadvantage:

- **Prose error in a success envelope** — `"Error: …"` with no `isError`, no `{error}`.
  Structurally indistinguishable from a successful string; a leading-`Error:` sniff
  false-positives on legitimate content. The model reads it exactly as native does.
- **Markdown-labeled-field prose** — `**ID:** \`{id}\`` skeletons. A labeled-field extractor
  is low-precision.
- **Python-repr that fails a clean literal parse**, non-JSON `str()` blobs — opaque.

### 4.4 Tool-intent overrides — deferred to the capability layer

One residual overreach cannot be fixed structurally: a convert/transform tool (markdownify)
whose payload *is literally* `{"error":"…"}` — C3 throws content the user asked to convert.
Structural rules cannot know a tool's *intent*. This is **deferred to the capability layer**:
tool-intent handling ("this tool is a converter — do not touch its payload") is a per-tool
capability that arms the tool, not a hardcoded exemption in the universal normalizer. Keeping
it out preserves the ship-to-unseen-server generality.

## 5. Validation status — what was tested, and what was NOT

Survey: ~90 real MCP servers (ranks 1-100 of a 100-entry catalog; 6 were not MCP servers)
established the recognizer set. Validation: 69 held-out servers (ranks 101-169), classified
from real tool-handler source.

**Scope of the result.** The validation was a **static desk-check of Stages A-C against single
responses** — not a whole-system property:

- **Supported:** across 69 held-out servers, Stages A-C produced **no mis-extraction on a
  single response** — every unknown shape landed on a LIMIT (opaque/passthrough). The
  precision-over-coverage contract held on unseen per-response data.
- **NOT supported:** **Stage D (§6) is a cross-call dynamic and was never exercised.** A
  single-response classification cannot see rung assertion, kind-mismatch, or the interaction
  between a strict-guard miss and an asserted rung — exactly where the worst defects live
  (§6.2, and the prose-envelope assertion cascade).
- **Known overreach count is one, not zero:** the markdownify C3 case (§4.4), found on a real
  server, is deferred, not solved.

**Prerequisite before any ship claim — dynamic validation.** Stages A-D must be replayed over
**multi-call trajectories** (a tool asserted on call 1, then fed: a prose error with no
`isError`; a payload that fails a strict guard; a scalar; an arity change) and checked for
data loss, not just mis-extraction. Until that runs, the safety property is claimed for
**Stages A-C, single-response only**.

**Architectural read:** modern Python/FastMCP + SDK servers increasingly auto-set
`structuredContent`, making **A2 the primary path and Stage B dead code for them**. The one
systemic reach-gap is a *trapped serialized string inside* `structuredContent` (§3,
re-dispatch through B).

## 6. Shape ladder (monotonic, per-tool, announced)

Mechanism owned by `normalizer/ladder.ts`. The cross-module contract: per-tool state
accumulates across the session (and optionally across sessions, §8) and only moves forward —
`Unseen → Singleton(T) → Vector(T) → Nested(T)`, never demoting. `T` widens structurally too
(a newly-observed key unions in; a key is never dropped) and carries **no** optional/required
annotation (trust cut §2.1.2).

**Unidirectional is the whole point.** Opportunistic presentation (bare when 1, vector when
many) breaks model code the turn arity changes. Widen-only means code written against the wide
type keeps working — the shape is a declared fact, not a per-response surprise. Over-widening
is correct, not a bug: one fluke multi-response pins a tool to Vector forever, because the type
genuinely *is* "can return many," which strictly beats native's re-guess-every-turn. There is
deliberately no demote heuristic — demotion *is* the drift.

Monotonicity scope: **per (session × serverVersion)**. Cross-session invalidation (§8) is not
demotion of a live contract — it is discarding a stale prior before any contract exists this
session.

### 6.1 Announce contract

Promotions, first-detections, and invalidations emit into the **service header** (same surface
as the map/filter/reduce hints), as a distinct highlighted block so a promotion is re-read,
not buried (the retroactive-window repair, §7). The vocabulary: `promotion` (shape widened,
"from now every response is a vector — use map/filter/reduce"), `watching` (responses currently
opaque; membrane will announce when a format stabilizes), `provisional` (a §8 prior loaded,
verifying on first call), `invalidated` (prior shape didn't hold; relearning).

### 6.2 Non-conformance (kind-mismatch against the asserted rung)

Because the ladder holds each tool's *asserted* kind, a response that violates it is surfaced
**structurally** — never by reading prose. Once a tool is asserted (Singleton-object / Vector /
Nested), a later response whose top-level KIND differs is non-conforming:

```
tool asserted structure, response is a SCALAR
  → recoverable error, carrying the scalar VERBATIM as the condition's value/message.
    NEVER an empty collection. NEVER a silent substitution.
```

**One branch only. The empty-collection branch is rejected — it was a lie.** Mapping "asserted
collection + scalar response" to an *empty collection* (absence) composes catastrophically:

- **It contradicts the §4.3 floor.** The floor promises prose errors without `isError` are
  left uncaught and read exactly as native does. But a Vector-asserted tool returning
  `"Error: rate limit exceeded"` would become an **empty vector** — the model concludes *zero
  results* and answers wrong, where native sees the error and retries. **Strictly worse than
  native.** Both cannot hold; the empty branch loses.
- **It makes "a miss is free" false.** §4.1's strict-or-opaque bargain rests on a rejected
  parse costing nothing. But after assertion, rejected parse → raw string → *empty vector*: a
  CSV with one unescaped newline (correctly rejected) would have its **entire payload silently
  discarded.** Every strict-guard miss becomes data loss — inverting the guards from safety
  feature to primary corruption vector.

Routing non-conformance to a **recoverable error carrying the scalar** fixes both: the string
stays visible (floor intact), a guard-miss costs nothing but a door, and an absence that *is*
the answer still reads off the condition. This is why the system needs no English not-found
sniff: `"No book found for olid: …"` becomes a *door carrying that exact string* — the
kind-mismatch is the signal, the English is never parsed, nothing is invented. It cannot
misfire on a tool that legitimately returns strings (a string *is* its asserted shape). It
settles the mixed-tool question: **structure wins the assertion** — a tool seen returning
structure even once is structure-asserted; subsequent scalars are non-conformance signals.
Unseen / scalar-asserted tools have no assertion to violate, so bare `"success"`/`"ok"` stay
opaque.

**Absence has exactly ONE representation.** A no-payload / not-found result is a recoverable
door carrying the server's own words — never a fabricated empty collection, never a sentinel.

### 6.3 Ladder state lifetime

Per-tool ladder state is keyed by output-shape hash (a hash of the tool's declared
`outputSchema`, or a sentinel for schema-less tools). On `tools/listChanged`: a tool's state is
wiped only if its shape hash changed; an unchanged tool keeps its ladder. A removed tool's
state stays keyed by its shape hash — if re-introduced with the same hash, the state
re-attaches. "Session" for §8 means one manifold server process lifetime.

## 7. Retroactive window

A promotion can arrive after the model has already written Singleton-shaped code. The announce
block is the door that repairs it, so promotions must land *visibly* (top of header,
highlighted) for the model to re-read and adapt — the only point where the model must respond
to a shape change. **Rung** promotions are bounded (at most twice per tool:
Singleton→Vector→Nested), but `T` key-widening and first-format-detections also announce and
are **not** bounded — announce churn must be rate-managed against elision (§3), not assumed
rare.

## 8. Optional cross-session persistence (skeptical, self-healing)

A pluggable store lets the ladder survive across sessions. Off by default (null store = pure
in-session, zero new surface), and **mandatorily off for any comparison run** — cross-run
warm-start is an evaluation-advantage native cannot have (§2). This is a *product* feature,
benchmarked off. Two-tier confidence:

- **In-session observed** = authoritative (the monotonic contract of §6).
- **Cross-session persisted** = *provisional prior*. Loaded as a hypothesis, never a committed
  contract until one live response this session confirms it.

```
load prior for (server, version, tool) → mark PROVISIONAL, announce as provisional
first live response for tool X:
  unifies with prior (equal, or a monotonic widening)     → CONFIRM, keep + widen
  non-unifiable                                           → INVALIDATE, drop prior, relearn
    where non-unifiable :=
      top-level KIND differs (scalar | object | array | vector-of-vectors), OR
      observed key set is FULLY DISJOINT from the prior's key union, OR
      envelope-format flips (e.g. was csv, now json)
```

**Observation-only invalidation.** The criterion uses only observed structure — top-level
kind, the *observed* key union, detected format. It never invokes "required" or "optional"
keys (banned by trust cut §2.1.2, absent from `ShapeSignature`).

**Skeptical, not paranoid:** invalidate on *non-unifiable*, not merely-different. A
polymorphic tool returning a new member *widens* (keep); a structurally-changed server returns
something that *cannot unify* (drop). Partial-overlap key sets widen — full disjointness is the
bright line, so a tool that adds/omits *some* keys across sessions does not thrash.

**Version key.** `initialize` returns `serverInfo.version`; store key is `(serverName,
serverVersion, toolName)`. Version is *not* the safety mechanism — live-verify is (sloppy
servers change shape without bumping). Always verify on first touch regardless of version.
Backend: file-based for v0 (per-user); a shared kv store is a possible future extension.

**Store interface + integrity schema:**

```
interface ShapeStore {
  get(key: ShapeKey): ShapeSignature | null
  put(key: ShapeKey, sig: ShapeSignature): void
}
type ShapeKey       = { server: string, version: string, tool: string }   // no task field, by construction
type ShapeSignature = {
  rung:   'Singleton' | 'Vector' | 'Nested',
  kind:   'scalar' | 'object' | 'array',        // the KIND axis — §6.2 non-conformance needs it,
                                                 // and Singleton(scalar)→Singleton(object) is a
                                                 // kind change that is neither a rung promotion
                                                 // nor a key-union
  keys:   string[],                              // observed key union; no optional/required (§2.1.2)
  soleKey?: string,                              // C1 stable-key evidence; cleared once observed to vary
  format?: 'json' | 'jsonl' | 'csv' | 'tsv' | 'toon' | 'python-literal' | 'prose-anchored',
}                                                // format enum MUST cover every reach-tier recognizer —
                                                 // "envelope-format flips" is an invalidation trigger,
                                                 // so a format it cannot name is a flip it cannot detect
```

The value type holds a shape-signature and nothing else — no task id, no payload, no answer —
so it is structurally incapable of crossing the integrity line. Skeptical invalidation
*strengthens* the integrity story: learning self-heals against drift instead of ossifying a
stale assumption.

## 9. Non-goals / hands-off

- **Prose parsing.** git logs, weather, fetch, free text. No canonical parse ⇒ no round-trip ⇒
  untouched. That text is the measured capability; "cleaning" it is text-reformatting on the
  capability side of the line.
- **Reading English to decide absence.** Never regex `/no .* found/`. Absence is caught
  *structurally* (§6.2): a scalar arriving for a ladder-asserted structure is a kind-mismatch →
  a recoverable door carrying that scalar verbatim, and only when the tool already proved a
  structured shape. The same string from a never-structured tool stays opaque.
- **Fabricating empties.** Never substitute an empty collection for a response not understood.
  A rejected parse costs a door, never a payload (§6.2).
- **Inner-field typing.** No optional/required inference on payload fields (§2.1.2).
- **Trusting declared schema.** `outputSchema` informs only the descriptive catalog surface and
  a provisional prior; never a trusted transform input (§2.1.1).
