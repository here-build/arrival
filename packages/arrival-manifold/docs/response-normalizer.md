# Response Normalizer — container-only, observation-trusted, monotonic shape contract

Status: DESIGN (no code yet). Companion to the tool-signature.ts `-> shape` catalog surface
and the args-error-reporting-v2 door design. Where args-error fixes the *input* boundary,
this fixes the *output* boundary: the shape a tool's response presents to the model.

Owners: `second-foundation/arrival-manifold` (membrane normalizer, header contract,
optional persistent store) + `foundations/arrival/mcp-substrate` (seam after `jsToScheme`,
recoverable-throw plumbing).

---

## 1. Problem evidence

MCP tool responses reach the scheme arm as raw `jsToScheme` values. Two failure classes in
`results-2026-07-11`:

1. **Per-turn shape entropy (drift origin).** A tool returns a bare object one call, a
   many-element result the next. The model writes `(:field resp)`, then the next call is an
   array and the accessor throws — or vice versa. Native re-parses the shape from raw JSON
   every turn and eats the ambiguity each turn; the scheme arm wants to write code *once*
   against a stable type and have it keep working. When the shape shifts under it, the
   program breaks mid-trajectory. This is the arbitrary-entropy / drift-origin failure the
   manifold exists to remove.

2. **Inert non-values.** `{error: …}` arrives as a value the model must notice-and-branch
   on (and often doesn't — it `:field`s an error three steps later). `{status:'success'}`
   with no payload reads as a result. A serialized structure (`"[{…}]"`, CSV file text)
   arrives as an opaque string the model must hand-parse. Native's context makes these
   visible; the scheme program silently mis-handles them.

The normalizer is a membrane layer that (a) de-serializes recognized serializations, (b)
applies a small set of universal container-hygiene rules, (c) stabilizes each tool's
response shape into a monotonically-widening declared contract, (d) optionally persists that
contract across sessions under a skeptical, self-healing invalidation rule.

## 2. The claim, and what's in scope for it

**The claim is narrow and positive: the medium is the bottleneck.** Same model, a different
capability-surface (one REPL tool + the MCP tools as prelude symbols), measure the delta.
Product voice: *your model is smarter than the interface you built for it with your own
hands.* MCP-Atlas is the vehicle precisely because it isolates a **middleware-only** boost —
no fine-tune, no task-fitting, just a better environment. Parsing what is parseable,
stabilizing shape, routing errors through doors — that **is** the demonstration, not a
concession stolen from the model's "measured capability." (A "the model is a better tool-user"
reading would make these rewrites suspect; that is not the claim we make.)

So the boundary is one line — **generalized rule vs task-tuned hack** — with one operational
test every rule must pass:

> **Would this rule ship, unchanged, to an unseen MCP server we have never run?**

- **Pass ⇒ in scope.** Totalic, programmatic, environment-general — *even if it helps, even if
  we first noticed the need via one Atlas server.* "Unwrap a single-key `{result|data|…}`
  wrapper" ships to any server; noticing it on open-library doesn't make it fitted.
- **Fail ⇒ out.** Anything shaped to a specific task's answer, or hand-fitted to one Atlas
  server's quirk in a way we'd tweak per-server. That is fine-tuning wearing a rule's clothes.

Two corollaries make the test operational:

- **Task-independent (structural, never answer-keyed).** Every rule keys on response
  *structure*, never on task text, claims, or any answer. The optional persistent store (§8)
  is *structurally incapable* of holding a task or payload — its value type is a shape-
  signature only.
- **Reliability, not principle, gates prose.** We *may* parse anything with a canonical,
  round-tripping parse (`serialize(parse(s)) ≈ s`) — that is environmental adaptation, in
  scope. Ad-hoc prose (git's `Commit: '…'\nAuthor: <git.Actor…>`, weather, fetch) stays
  untouched **because it has no reliable parse**, not because parsing it would cheat. And the
  absence-string case (`"No book found…"`) is handled *structurally* — a scalar arriving for a
  ladder-asserted collection/object is a kind-mismatch (§6 non-conformance) — so we never regex
  English at all.

**Two levers, isolated.** In-session shape stabilization is symmetric-in-principle (either
arm's medium could do it) and is part of the medium claim — it stays. Cross-run memory (§8) is
a *second* lever (accumulated state across tasks), which conflates the attribution of a
medium-only headline. So the persistent store is **off for the headline run**; if we want the
memory result, it is reported as a **separate delta**, not folded into the medium number. Not
a fairness confession — variable isolation.

**Disclosed — exhaustively, as spec.** The scheme arm carries a normalizer; native gets raw
strings. Every transform is named in the arm-comparison writeup — deserialize (0),
unwrap-container (C1), error-throw (C3), structural non-conformance door (§6.2),
shape-stabilization (§6), and, when separately measured, the cross-session prior (§8). This is
the product's adaptation surface stated plainly, not a list of concessions. (Triad drift-audit
raised understated disclosure, composer B4; reframed here.)

### 2.1 Two trust cuts

The normalizer's guarantees rest on *observed runtime structure*, not on declared schema,
and reach only the *container*, not inner fields:

1. **Declared vs observed.** A declared `outputSchema` is at most a *provisional prior*
   (§8) — loaded as a hypothesis, confirmed or discarded by the first live response. It is
   never a trusted contract on its own. Observation is the only ground truth.
2. **Container vs inner-field.** Container structure, once observed, is trusted and
   normalizable. Inner fields are reported *exactly as observed* — never optional-typed. A
   schema-declared `optional` is not trusted (servers do not reliably honor their own
   schemas, and optional-in-schema ≠ present-in-practice). Field presence is known only as
   seen / not-seen; the normalizer never reaches into a payload to assert a field is optional
   or required. The descriptive catalog `-> shape` may still *mention* fields (it is
   explicitly descriptive, never typed); the normalizer's *transforms and contract* do not
   depend on any inner-field type claim.

## 3. The expert system — staged recognizers, not universal rules

This is not a universal rewriter; it is a **small expert system** with a bounded set of
recognizers ("I know these shapes") and an explicit default of hand-back-untouched ("and I
know where I stop"). Precision over coverage. It was **derived from a 100-server survey and
validated on 69 held-out servers (ranks 101-169) — zero active mangles** (§5). The strictness
constraints below are *earned*: each is the exact guard whose absence mangled a held-out
server.

**The ecosystem's real container is the MCP protocol envelope** (`content:[{type,text}]` ·
`isError` · `structuredContent`), NOT a payload wrapper key — across ~90 real servers, an
author-chosen `{result|data|…}` box was essentially never the top-level container
(framework/passthrough artifacts only). So the expert system is staged on the *envelope* the
manifold already sees in `unwrapToolResult` (`server.ts:118-149`), not on payload-key sniffing.

**Seam.** The normalizer operates on **JS values, extending `unwrapToolResult`, and runs
BEFORE `jsToScheme`** (`bind.ts:383` lifts the final JS value into scheme). It is not a
post-`jsToScheme` pass.

```
CallToolResult
  Stage A — envelope (already in unwrapToolResult):
    A0  JSON-RPC / transport error                → throw   [ALREADY HANDLED: server.ts:183-196,
                                                             callTool catch + stripJsonRpcFrame —
                                                             the Rust/Go SDK default error path]
    A1  isError:true                              → throw(recoverable, texts joined)  [error door]
    A2  structuredContent present                 → it IS the value → Stage C         [modern SDK default; PRIMARY path]
    A3  else                                      → content blocks → Stage B
  Stage A′ — binary pre-pass (ORTHOGONAL, before B dispatches; existing behavior):
       any binary block is replaced in-value by a `#<attachment N: mime, NNN bytes>` STUB and the
       original passed through the quota'd AttachmentCollector (server.ts:145-147, attachments.ts).
       A lone binary block collapses to that stub STRING. Binary is NEVER preserved in-value —
       "never drop the image" means the attachment channel, not in-value block preservation.
       (Quota exhausted ⇒ stub only, no pass-through.) B then sees a text-only block list.
  Stage B — content-block extraction / deserialize (first match; else LIMIT):
    B1  exactly 1 text block:
          valid JSON (object/array)  → parse → Stage C
          valid NDJSON/JSONL         → vector-of-parsed → Stage C   [objects only, ≥2 lines]
          valid CSV/TSV (strict, §4.1)→ records → Stage C
          valid TOON (row count matches its own [N]) → array-of-records → Stage C
          valid Python-literal (dict/list, string keys only, §4.2) → parse → Stage C
          prose + end-anchored embedded STRUCTURE (`{…}`/`[…]`, never a scalar, §4.2)
                                     → {raw,value,prefix|suffix}; Stage C + Stage D see `.value`
          else                       → raw string          ⟂ LIMIT (opaque)
    B2  ≥2 text blocks:
          ALL valid JSON             → vector-of-parsed → Stage C  [content[] IS a collection: googleapis]
          else                       → block array         ⟂ LIMIT
    B3  0 / non-text blocks          → per Stage A′ (stub) or block array   ⟂ LIMIT
  Stage C — payload container (first match; else identity). ERROR BEFORE UNWRAP:
    C3  STRICT in-band error — checked FIRST:
          single-key {error} or {errors} — AT ANY VALUE KIND (object, array, string), OR
          {ok:false} / {success:false} whose value is literally `false`, as the whole payload
                                     → throw(recoverable; the error value rides intact)
    C1  STRICT single-key container — object has EXACTLY one key, value is the sole array/object,
          AND the key is STABLE for this tool across calls (§4.1 dynamic-key guard)
                                     → unwrap
    C4  else                         → identity (parsed value as-is)    ⟂ LIMIT
  Stage D — shape ladder (§6). Observes the POST-Stage-C value (for the prose-envelope case,
       `.value`, never the `{raw,value,prefix}` shell — the shell's keys must not pollute `T`).
```

`⟂ LIMIT` = hand back untouched, never mangle. B1-else, B2-else, B3, C4 are the honest
ignorance.

**Why C3 precedes C1 (was a real defect).** C1's "exactly one key, value is the sole object"
matches `{"error": {"code":429,"message":"rate limited"}}` — a C1-first order unwraps it and
hands the model an **error as a success value**, then object-asserts the tool on error-shape
keys. The GraphQL convention `{"errors":[…]}` is worse: C1 unwraps to a bare vector of error
objects *presented as results*. Errors are checked first, at any value kind. (Fable audit F1.)

**Trapped-serialization re-dispatch — narrow and non-recursive.** A serialized string that
arrives *as the container payload* (A2's `structuredContent` **is** a string; or C1 unwrapped a
single-key container whose value is a string) is re-dispatched **once** through B's format
detection. Strictly bounded:
- **Never** re-dispatch a value that is itself the *output* of a B parse. (`"123"` in a text
  block parses to the string `"123"` — an id, a zip code. Re-dispatching it yields the number
  `123`, while `"0123"` survives: type corruption keyed on digit content.)
- **Depth 0** — no recursion into payload fields. (A recursive reading would sniff every string
  field of every object: `{description: "a, b\nc, d"}` → CSV records.)
- This preserves the existing literal-string opt-out documented at `server.ts:106-108` (a server
  needing a literal string that happens to be valid JSON declares an outputSchema): a
  structuredContent string is re-dispatched only when it round-trip-parses as a *structured*
  format, and a scalar-yielding parse is refused (§4.2). (Fable audit F3.)

**Downstream surface.** After normalization the model sees the value through response elision
(`manifold-tool.ts`, `DEFAULT_MANIFOLD_OBSERVATION_ELISION` — head/tail item limits). Vector-
always promotion (§6) feeds directly into that limit, and the announce contract's "every
response is a vector" is rendered through it. Any ladder change must be read against elision.

**Open interaction (must be resolved before build).** A Stage-C throw propagates through
`bind.ts:373-375`, which annotates *any* `tool.invoke` rejection with `ARGS_REJECTION`
metadata (`sentArgs`) intended for **argument** failures. A C3 in-band-error throw is not an
args failure and must not acquire that metadata (it would mis-route the args-error door). Also
unresolved: does `tracker?.record` (`bind.ts:377`) hash the raw or the normalized result?

## 3.5 The zone architecture (V rulings 2026-07-13) — declared-auto, inferred-flagged

The final cut, superseding always-on inference for everything below Stage A:

- **Declared zone — automatic, no flag.** The server's own typed channels: `isError` → door,
  `structuredContent` → value. Zero ambiguity, zero inference. Plus, **grandfathered
  default-ON (V1):** the existing single-text-block `JSON.parse` (`server.ts:138-143`) — shipped
  and benchmarked behavior, object/array-yield only (scalar strings stay strings, NEW-6/F3).
- **Inferred zone — model-invoked, never automatic.** Every other recognizer (CSV/TSV, TOON,
  Python-literal, NDJSON, prose-envelope, C1 unwrap) is exposed two ways:
  1. **Parsers as first-class prelude functions** — `json`, `csv`, `toon`, `py-literal`,
     `detect-parse` — pure, inline-usable on any value: `(csv (tool/read-file :path "x.csv"))`.
  2. **`auto-parse!` sugar** — rebinds a tool through `detect-parse` so every subsequent call
     returns parsed values: model-authored composition, announced in the header. A rebind the
     model performs on itself is not drift — drift is *unchosen* change.
- **The Montessori header teaches, never decides:** "tool `x` returns opaque text that
  round-trip-parses as CSV — `(auto-parse! x)` or `(csv …)` to use it structured."
- **Doors fire in the declared zone only.** A `structuredContent` kind-violation is a contract
  breach → door. A kind change in opportunistically-parsed text is information → announce,
  never door (the read_file trap is structurally unreachable).
- **Flag persistence (V2): store-backed, enabled via flag.** The auto-parse choice persists in
  the §8 store (keyed like ShapeSignature); headline/benchmark runs keep the store off ⇒
  per-session behavior there. Lens (arbitrary per-tool lambda) remains the capability-layer
  destination (§4.4); the flag is its degenerate case.

This collapses the Fable round-2 findings class-wise: NEW-1/2 (intent questions structure
cannot answer) move to the model, which knows its intent; NEW-3/4 (C1 flip / prior
self-invalidation) vanish because cold-session auto-unwrap no longer exists — the ladder's
canonical shape is the **pre-unwrap** value.

## 4. The three tiers (each recognizer's earned justification)

### 4.1 Precision tier — strict guards (their looseness is what mangles)

Every one of these is strict *because* the loose version mangled a held-out server. These are
not preferences; they are the safety property.

- **A before B.** `structuredContent` is authoritative; several servers (octocode) deliberately
  gut the text block to force it. A B-first read extracts garbage. The manifold already orders
  A2 before text parsing (`server.ts:135`).
- **C3 before C1 — error before unwrap.** See §3. Checking C1 first silently converts
  `{"error":{…}}` and GraphQL `{"errors":[…]}` into success values.
- **C3 is STRICT and literal, but kind-agnostic on the error VALUE.** Throw only when the whole
  payload *is* an error — single-key `{error}`/`{errors}` (value may be an object, array or
  string), or `{ok:false}`/`{success:false}` whose value is literally `false`. Never on key
  presence, never on validity synonyms. Loose C3 throws valid results: jvm `{success:true,
  error:null}` (presence ≠ error), jetbrains `{success:false, buildMessages, rawOutput}` (a
  status field with diagnostics — not the *whole* payload), vizro `{valid:false,
  message:"retry…"}` (one rename from a collision — do NOT generalize to validity synonyms).
  Recoverable + value-preserved (an error that *is* the answer still reads off the condition);
  one error ≠ degradation (never feeds retry-thrash).
- **C1 is STRICT single-key, structural (no key names), AND stable-key gated.** Unwrap only
  when the object has *exactly one* key whose value is the sole collection/object. **There is
  no key-list** — enumerating `{result|data|…}` is both fitted *and* unsafe: loose/named unwrap
  drops siblings (docker `{count,next,previous,results}`, JSON:API `{data,included,meta,links}`,
  octocode `{results,next,warnings}` all lose pagination/relationship metadata).
  **Dynamic-key guard (Fable audit F6):** strict-single-key alone still mangles a *map keyed by
  id* — `{"u1":{…}}` is one key with an object value, so unwrapping strips the id (data loss),
  and the same tool returning two ids doesn't unwrap at all — **the tool's shape would flip with
  request arity, which is precisely the per-turn entropy §1 exists to remove.** So C1 fires only
  when the single key is **STABLE for this tool across calls** (Stage D already holds per-tool
  memory). A key observed to vary is a dynamic-key map: never unwrap. First call on an unseen
  tool: do not unwrap (no stability evidence yet); the ladder announces if/when the key proves
  stable. Known limit: even for a stable key, the key *name* itself is dropped information.
- **CSV/TSV requires header-plausibility + ≥2 data rows + consistent column-count > 1.** A
  permissive "parser didn't throw" check mangles pipe-tables (zaturn), prose+TSV (jupyter),
  label+CSV (optuna). **And header+consistent-cols alone is still insufficient (Fable audit
  F5):** `"123 Main St, Springfield\n456 Oak Ave, Shelbyville"` is 2 consistent columns and
  would be parsed as records with an *address* as the header key. Any "name, place" list
  qualifies. Require, in addition: the header row's cells are **identifier-like** (no cell parses
  as a sentence / contains sentence punctuation), OR the text carries quoting/escaping evidence
  of real CSV. Strict-or-opaque.

### 4.2 Reach tier — earned by recurrence, round-trip-safe

Added only because they recurred across held-out servers, and each has a deterministic,
round-tripping parse (`serialize(parse(s)) ≈ s` up to insignificant whitespace only — no key
reorder, no number reformat).

- **Python-literal** (`str(dict)`: single quotes, `True/False/None`) — airflow (all modules),
  excel, ros2, tinybird. Systemic on Python/FastMCP. **Restricted (Fable audit F10): dict/list
  literals with STRING keys only.** Bare scalars stay opaque (`None` → the *word* None is a
  legitimate empty-cell readout in the very excel server cited — parsing it to null is a lie;
  same for `True`). Tuples/sets (`(1,2)`, `{1,2}`) and int-keyed dicts (`{1:2}`) are **refused**:
  they do not round-trip (a tuple would re-serialize as an array, an int key as a string),
  violating §4.2's own no-reformat law.
- **TOON** (`name[N]{col,col}:` + delimited rows) — keboola, codebase-memory (its two hottest
  tools' *default*), bitbucket. An emerging token-dense tabular format (≈ arrival-serializer
  efficiency); decode to array-of-records like CSV. **Gate: the declared `[N]` must match the
  actual row count** — a mismatch means it isn't TOON (or is truncated) ⇒ opaque.
- **NDJSON / JSONL** — **objects only, ≥2 lines**, every line parsing. (One line is just JSON;
  a non-object line means it isn't NDJSON.) dingo.
- **Prose + end-anchored embedded STRUCTURE** — opik `[label:…]\n{json}`, edgeone
  `logs\n\nresults:\n{…}`, optuna `"Trials:\n<csv>"`. Two hard constraints:
  - **Structure only, never a scalar (Fable audit F4).** A greedy suffix parse that accepts JSON
    scalars fires on any prose ending in a number: a weather tool's `"Current temperature: 23.5"`
    would yield `{raw, value:23.5, prefix:"Current temperature: "}`, **object-assert the tool on
    the envelope's own keys**, and then throw on its next (perfectly healthy) prose reply as a
    kind-mismatch. The anchored span must parse to `{…}` or `[…]`, else no envelope.
  - **End-anchored, prefix XOR suffix, never both** — a mid-string span needs two fuzzy
    boundaries and fires on payload internals (a JSON value holding `}\nfoo`, a `,`); anchoring
    fixes one boundary at the string edge and greedy-parses from it. Both ends parsing ⇒
    ambiguous ⇒ stay `raw`.
  The whole envelope `{raw, value, prefix|suffix}` is model-visible (faithfulness in an
  unreachable field would be asymmetric context-stripping), but **Stage C and Stage D see
  `.value`** — the shell's keys must never enter `T`.
- **content[] as a collection** — googleapis emits one JSON row per block; the block array
  *is* the vector (B2 ALL-JSON).

**Removed from this tier by the audit:**
- **C2 type-discriminated union — DELETED (Fable audit F7).** `{type:"table"|"ok"|"error"}` is a
  hardcoded *value*-list — exactly the fitted enumeration §4.1 congratulates itself for killing
  on the key side — sourced from **one** server (mindsdb), and it never had an extraction spec
  (what is extracted from `{type:"table", columns, rows}`?). It fails §2's ship-to-unseen test
  (`type:"success"` misses; GeoJSON's `type:"Feature"` shows why loosening is worse). Gone. If
  it returns, it returns as a per-tool **capability** (§4.4), not a universal rule.
- **Exec named-blocks `{stdout,stderr,exit_code}` — DROPPED.** MCP text blocks carry **no `name`
  field**; this was one server's out-of-spec extension, presented as "earned by recurrence" when
  it had a single sighting. Most exec servers flatten to prose and correctly stay opaque.

### 4.3 Floor — deliberately at LIMIT (measured-capability boundary)

Left uncaught on purpose. A structural recognizer either can't detect these, or would be
fragile enough to mangle legitimate content — and **native is equally blind**, so leaving them
is not a scheme-arm disadvantage.

- **Prose error in a success envelope** — `"Error: …"`, `❌ Error…` with no `isError`, no
  `{error}` (excel has 23 such sites; airflow, zaturn, mindpilot, figma-flutter). Structurally
  indistinguishable from a successful string; a leading-`Error:` sniff false-positives on
  legitimate content. The model reads it exactly as native does.
- **Markdown-labeled-field prose** — `**ID:** \`{id}\`` skeletons (shrimp-task-manager,
  jetbrains FileStructure). Prose the model reads; a labeled-field extractor is low-precision.
- **Python-repr that fails a clean literal parse**, non-JSON `str()` blobs — opaque.

### 4.4 Tool-intent overrides — deferred to the capability layer

One residual overreach cannot be fixed structurally: a convert/transform tool (markdownify)
whose payload *is literally* `{"error":"…"}` — C3 throws content the user asked to convert to
text. Structural rules cannot know a tool's *intent*. This is **deferred to the capability
layer**: tool-intent handling ("this tool is a converter — do not touch its payload") is a
per-tool capability that arms the tool, not a hardcoded exemption in the universal structural
normalizer. Keeping it out preserves the normalizer's ship-to-unseen-server generality;
intent-overrides compose in where they belong.

## 5. Validation status — what was tested, and what was NOT

Survey: ~90 real MCP servers (ranks 1-100, of 100 catalog entries; 6 were not MCP servers)
established the recognizer set. Validation: 69 held-out servers (ranks 101-169), 7 batches,
each classified from real tool-handler source.

**Scope of the result — stated honestly (Fable audit F9).** The validation was a **static desk-
check of Stages A-C against single responses**. It is *not* a whole-system property:

- **What IS supported:** across 69 held-out servers, Stages A-C produced **no mis-extraction on
  a single response** — every unknown shape landed on a LIMIT (opaque/passthrough). The
  precision-over-coverage contract held on unseen per-response data.
- **What is NOT supported:** **Stage D (§6) is a cross-call dynamic and was never exercised.**
  A single-response classification cannot see rung assertion, kind-mismatch, or the
  interaction between a strict-guard miss and an asserted rung — which is exactly where the
  audit found the worst defects (§6.2, and the prose-envelope assertion cascade, §4.2). An
  earlier draft of this doc claimed "0 active mangles across 69 held-out servers" as a property
  of the whole system. **That claim was overstated and is withdrawn.**
- **Known overreach count is one, not zero:** the markdownify C3 case (§4.4) was found on a real
  server and is deferred, not solved. "Zero" was never the honest number.

**Prerequisite before any ship claim — dynamic validation.** Stages A-D must be replayed over
**multi-call trajectories** (a tool asserted on call 1, then fed: a prose error with no
`isError`; a payload that fails a strict guard; a scalar; an arity change) and checked for
data loss, not just mis-extraction. Until that runs, the safety property is claimed for
**Stages A-C, single-response only**.

**What the survey does solidly establish:**
- **The precision guards were earned by their violations** — each strict constraint in §4.1 is
  the fix for a specific held-out mangle (C1: docker/app-store + the dynamic-key map; C3:
  jvm/jetbrains/vizro; CSV: zaturn/jupyter/optuna).
- **Coverage is a long tail of serialization formats**, not a structural failure. The spine
  (A2→C, B-deserialize→C) extracts or safely-passes the majority; the reach tier (§4.2) closes
  the recurring gaps (TOON, Python-repr, trapped-string re-dispatch the highest-value).
- **Architectural read:** modern Python/FastMCP + SDK servers increasingly auto-set
  `structuredContent`, making **A2 the primary path and Stage B dead code for them**. The
  manifold already prefers `structuredContent`; the one systemic reach-gap is a *trapped
  serialized string inside* it (§3, re-dispatch through B).

## 6. Shape ladder (monotonic, per-tool, announced)

Per-tool state accumulates across the session (and optionally across sessions, §8); it only
moves forward:

```
Unseen
  → Singleton(T)   first response is one object/scalar → presented bare; model does (:a resp)
  → Vector(T)      any response with >1 element (or an array) → presented as #(T) ALWAYS;
                   a later 1-element response = 1-element vector; never demotes
  → Nested(T)      a vector-of-vectors appears → #(#(T)); ceiling (deeper nesting stays here)
```

`T` widens structurally too: a newly-observed key unions into `T` (monotonic — a key is
never dropped). `T` records observed keys only; it carries **no** optional/required
annotation (trust cut §2.1.2).

**Unidirectional is the whole point.** Opportunistic presentation (bare when 1, vector when
many) breaks model code the turn arity changes. Widen-only means code written against the
wide type keeps working — the shape is a declared fact, not a per-response surprise. Over-
widening is correct, not a bug: one fluke multi-response pins a tool to Vector forever,
because the type genuinely *is* "can return many," and vector-always strictly beats native's
re-guess-every-turn. There is deliberately no demote heuristic — demotion *is* the drift.

Monotonicity scope: **per (session × serverVersion)**. Cross-session invalidation (§8) is not
demotion of a live contract — it is discarding a stale prior before any contract exists this
session.

### 6.1 Announce contract

Promotions, first-detections, and invalidations emit into the **service header** (same
surface as the map/filter/reduce hints), as a distinct highlighted block (so a promotion is
re-read, not buried — the retroactive-window repair, §7):

```
promotion:    tool `search_papers`: shape  {title,year,doi}  →  #({title,year,doi})
                server saw this tool return a series. From now every response is a vector
                (one result = 1-element vector). Use map/filter/reduce.
watching:     tool `read_file`: responses currently opaque text. Membrane progressively
                detects json/jsonl/csv/tsv and will announce here when the shape stabilizes.
provisional:  tool `search_papers`: prior sessions saw #({title,year,doi}); unconfirmed,
                verifying on first call.
invalidated:  prior shape for `search_papers` didn't hold (server likely updated) — relearning.
```

### 6.2 Non-conformance (kind-mismatch against the asserted rung)

Because the ladder holds each tool's *asserted* kind, a response that violates it can be
surfaced **structurally** — never by reading prose. Once a tool is asserted (Singleton-object /
Vector / Nested), a later response whose top-level KIND differs is non-conforming:

```
tool asserted structure (Singleton-object | Vector | Nested), response is a SCALAR
  → recoverable error, carrying the scalar VERBATIM as the condition's value/message.
    NEVER an empty collection. NEVER a silent substitution.
```

**One branch only. The empty-collection branch is DELETED (Fable audit F2) — it was a lie.**
An earlier draft mapped "asserted collection + scalar response" to an *empty collection*
(absence). That composes catastrophically with the rest of the system:

- **It contradicts the §4.3 floor.** The floor promises that prose errors without `isError`
  (excel's 23 sites) are left uncaught and "the model reads them exactly as native does." But a
  Vector-asserted tool returning `"Error: rate limit exceeded"` would become an **empty vector** —
  the model concludes *zero results* and answers wrong, where native sees the error and retries.
  **Strictly worse than native.** Both sections cannot hold; the empty branch loses.
- **It makes "a miss is free" false.** §4.1's whole strict-or-opaque bargain rests on a rejected
  parse costing nothing. But after assertion, a rejected parse → raw string → *empty vector*:
  a CSV with one unescaped newline (guard correctly rejects) would have its **entire successful
  payload silently discarded.** Every strict-guard miss would become data loss — inverting the
  guards from a safety feature into the primary corruption vector.

Routing non-conformance to a **recoverable error carrying the scalar** fixes both: the string
stays visible (the model reads it, exactly as native would — floor intact), a guard-miss costs
nothing but a door (no data vanishes), and an absence that *is* the answer still reads off the
condition. An empty scheme vector carries nothing; "kept as provenance" named no representation.
The condition value **is** the representation.

This is why the expert system still needs no English not-found sniff: `"No book found for
olid: …"` becomes a *door carrying that exact string* — the kind-mismatch is the signal, the
English is never parsed, and nothing is invented. It cannot misfire on a tool that legitimately
returns strings (a string *is* its asserted shape; no mismatch). It also settles the mixed-tool
question: *structure wins the assertion* — a tool seen returning structure even once is
structure-asserted, and subsequent scalars are non-conformance signals, not a competing shape.
Monotonic; structure-asserted never demotes. Unseen / scalar-asserted tools have no assertion to
violate, so bare `"success"`/`"ok"` stay opaque.

**Absence has exactly ONE representation.** A no-payload / not-found result is a recoverable
door carrying the server's own words — never a fabricated empty collection, never a separate
sentinel. (This closes the OQ2-vs-§6.2 split: there are not two absence representations.)

## 7. Retroactive window

A promotion can arrive after the model has already written Singleton-shaped code. The
announce block is the door that repairs it; therefore promotions must land *visibly* (top of
header, highlighted), so the model re-reads and adapts. This is the only point where the
model must respond to a shape change. **Rung** promotions are bounded (at most twice per tool:
Singleton→Vector→Nested), but `T` key-widening and first-format-detections also announce and are
**not** bounded by two — announce churn must be rate-managed against elision (§3), not assumed
rare. An earlier draft claimed "at most twice per tool" for all announces; that was wrong. It
holds for rungs only, and by construction it happens at most twice per tool
(Singleton→Vector→Nested).

## 8. Optional cross-session persistence (skeptical, self-healing)

A pluggable store lets the ladder survive across sessions. Off by default (null store = pure
in-session, today's behavior, zero new surface), and **mandatorily off for any leaderboard /
arm-comparison run** — cross-run warm-start is an evaluation-advantage native cannot have
(§2, "evaluation-independent"). This section describes a *product* feature; it is benchmarked
off. Two-tier confidence:

- **In-session observed** = authoritative (the monotonic contract of §6).
- **Cross-session persisted** = *provisional prior*. Loaded as a hypothesis, never a
  committed contract until one live response this session confirms it.

Per-tool mechanism:

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
keys; those annotations are banned by trust cut §2.1.2 and absent from `ShapeSignature`. An
earlier draft said "disjoint required keys" — corrected: a fully-disjoint *observed* key set,
or a kind change, is the signal. (Triad prover finding 3.)

**Skeptical, not paranoid:** invalidate on *non-unifiable*, not on merely-different. A
polymorphic tool returning a new member *widens* (keep — its keys overlap or its kind
matches); a structurally-changed server returns something that *cannot unify* (drop). Only the
latter wipes the prior. Partial-overlap key sets widen (keep), never invalidate — full
disjointness is the bright line, so a tool that adds/omits *some* keys across sessions does
not thrash.

**Version key.** `initialize` returns `serverInfo.version`. Store key is `(serverName,
serverVersion, toolName)`. Version match ⇒ high prior confidence; mismatch/absent ⇒ load but
announce low-confidence, or hard-expire on a major bump. Version is *not* the safety
mechanism — live-verify is (sloppy servers change shape without bumping). Always verify on
first touch regardless of version.

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
                                                 // nor a key-union (Fable audit: undefined before)
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
stale assumption — the anti-entropy thesis at cross-session scale.

## 9. Non-goals / hands-off

- **Prose parsing.** git (`Commit: …\nAuthor: <git.Actor…>`, plus its Python-repr leakage
  `datetime.datetime(2024, …, tzinfo=<… object at 0xffff…>)`), weather, fetch, desktop-
  commander free text. No canonical parse ⇒ no round-trip ⇒ untouched. That text is the
  measured capability; "cleaning" the repr leakage is text-reformatting on the capability
  side of the line — explicitly excluded.
- **Reading English to decide absence.** We never regex `/no .* found/`. Absence is caught
  *structurally* (§6.2): a scalar arriving for a ladder-asserted structure is a kind-mismatch →
  **a recoverable door carrying that scalar verbatim** (never a fabricated empty collection).
  So `"No book found for olid: …"` becomes a door holding that exact string, and only when the
  tool already proved a structured shape; the same string from a never-structured tool stays
  opaque. Bare `"ok"`/`"success"` from an unstructured tool stays a string. The English is never
  the trigger — the shape is — and the words are never replaced by an invented value.
- **Fabricating empties.** The normalizer never substitutes an empty collection for a response
  it did not understand. A rejected parse costs a door, never a payload (§6.2, Fable audit F2).
- **Cross-session memory during comparison runs.** The §8 store is mandatorily off for any
  leaderboard / arm-comparison run — warm-start priors are an evaluation-advantage native
  cannot have (§2). It is a product feature, benchmarked off.
- **Inner-field typing.** No optional/required inference on payload fields (§2.1.2).
- **Trusting declared schema.** `outputSchema` informs only the descriptive catalog surface
  and a provisional prior; it is never a trusted transform input (§2.1.1).

## 10. Open questions

1. **RESOLVED — structure wins the assertion.** A tool that *sometimes* string-wraps /
   returns a scalar and *sometimes* returns structure is **one ladder**: once structure is
   observed, the tool is structure-asserted, and later scalars are non-conformance signals
   (§6 non-conformance), not a competing shape. Monotonic — structure-asserted never demotes.
   This also keys the envelope `value` re-entry: the post-deserialize `value` is the identity;
   the string wrapper is presentation. (Resolved via the non-conformance reframe.)
2. **RESOLVED — absence has exactly one representation.** Not a sentinel, not a fabricated empty
   collection: a **recoverable door carrying the server's own words** (§6.2). The empty-collection
   branch was deleted as a data-loss vector; a sentinel would be a second absence representation
   with no advantage over the door. (Reconciles OQ2 with §6.2.)
3. **Store backend** — file (per-user, simplest) vs kv (shared). File for v0.
4. **RESOLVED — ladder state lifetime (V ruling 2026-07-13).** Per-tool ladder state is keyed by
   **output-shape hash** (hash of the tool's declared `outputSchema`, or a sentinel for
   schema-less tools). On `tools/listChanged`: wipe a tool's state **only if its shape hash
   changed**; an unchanged tool keeps its ladder through the rebuild. A **removed** tool's state
   is preserved in-memory keyed by its shape hash — if the tool is later re-introduced with the
   same hash, the state re-attaches (the hash is the cache key). "Session" for §8 purposes =
   one manifold server process lifetime.
5. **OPEN — Stage-C throw vs the args-error door.** A C3 / §6.2 throw propagates through
   `bind.ts:373-375` and would acquire `ARGS_REJECTION` metadata meant for argument failures
   (§3). Needs a distinct condition class so the args-door does not fire on a tool-side error.
6. **OPEN — futility hashing.** Does `tracker?.record` (`bind.ts:377`) hash the raw or the
   normalized result? Normalization changes the equality relation the futility tracker rides on.
```
