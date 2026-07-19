# Arguments-Error Reporting v2 — path-targeted doors with repeat-failure escalation

Status: DESIGN (no code yet). Companion to the parallel tool-signature.ts rework (nested
object shapes now render recursively in signatures — this design ASSUMES that and answers
what the arguments-error door does BEYOND echoing the richer signature).

Owners: `foundations/arrival/mcp-substrate` (doors, tracker, runner hook) +
`second-foundation/arrival-manifold` (membrane metadata, error-contract re-freeze) +
one small `foundations/arrival/arrival` change (the kwargs zod-decode humanizer).

---

## 1. Problem evidence (brief)

MCP-Atlas run `results-2026-07-11/full89_scheme_longcat.csv`, task `…45edee`
(clinicaltrials, "studies by King Saud University started 2024-01-24"): **17 argument
rejections in 80 messages; 34 total attempts**; the native arm (raw JSON schema in
context) succeeded first-try.

The failing loop, verbatim (msgs 8–46):

```
attempt 1:  :query "King Saud University"
  → Error: {"detail":"…Input validation error: 'King Saud University' is not of type 'object'"}
attempt 2:  :query {:terms "King Saud University"}
  → …Additional properties are not allowed ('terms' was unexpected)
attempt 3:  :query {:search …}      → 'search' was unexpected
attempt 4:  :query {:term …}        → SUCCESS on query — the real key was ONE EDIT away the whole time
attempts 5–17: :filter {:startDateRange …} / {:AREA[StartDate]… …} / {:area …} / {:expression …}
  / {:range …} / {:startDate …} … → 13 more unexpected-key rejections, never shown filter's real keys
```

The mechanism that fired (doors.ts `signatureEchoFor` → `DoorSession.echoSignature`)
appended a signature whose nested params rendered as opaque `value`:

```
Signature: (clinicaltrialsgov-mcp-server/clinicaltrials_list_studies :query value? (A set of
search terms that influence result ranking.) :filter value? (…) …)
Example: (clinicaltrialsgov-mcp-server/clinicaltrials_list_studies)
```

Correct mechanism, zero usable content: the model needed `query.properties =
{cond, term, locn, titles, intr, outc, spons, id}` (each described,
`additionalProperties: false`) and never saw one key. The signature rework fixes the
catalog surface; **this design fixes the error surface**: the door must (a) localize the
FAILING parameter, (b) teach that parameter's sub-schema — not the whole world, (c)
escalate when the same parameter keeps failing, because doors ride every failing turn and
the first one must stay lean.

Three structural observations that shape the design:

1. **The args the model SENT are ground truth at the boundary.** We never need to fully
   parse upstream error prose — we intersect its clue tokens (a quoted value, a quoted
   unexpected key, a zod path array) with the sent-args tree we already hold.
2. **`'terms' was unexpected` + sub-schema keys is a solved problem** — it is doors.ts's
   existing tier-1/tight-match machinery (`normalizeSymbolName`, `editDistance`,
   `isTightMatch`) applied one level down, to KEYS instead of tool names. Attempt 2 →
   "the key you want is `:term`" ends the trajectory at attempt 3.
3. **34 near-identical retries is a futility problem** — the escalation state is a
   sibling of `FutilityTracker`, not of `DoorSession`'s monotonic verbose-once gate
   (escalation is the gate's INVERSE: repetition earns MORE teaching, not less).

---

## 2. Design

### 2.1 The door: `envelope/args-misuse`

One new door code covering BOTH layers of argument rejection:

- **(a) upstream pass-through** — the upstream tool rejected the args (HTTP 500 detail
  text, `-32602`, TS-SDK `Input validation error`, python-jsonschema prose). The frozen
  H-4 rule holds: the upstream text reaches the model VERBATIM as the first line; the
  door only ever appends below it.
- **(b) our own kwargs zod-decode rejection** — the manifold's `z.object(shape)` decode
  (arrival rosetta.ts:114) threw. Today this surfaces a raw ZodError dump (known
  regression, humanizer missing). §2.5 gives the humanized frozen shape; the humanized
  message then feeds the SAME localized door pipeline (it names its param natively — no
  heuristics needed).

The door replaces the bare signature-echo for misuse errors where localization succeeds;
where localization fails (no clue matches, or matches ambiguously), today's
Signature+Example echo remains the fallback, byte-identical — never a guessed param name
(fact/why/script discipline: a guess is rendered as a menu or not at all).

### 2.2 Localization: upstream error text → failing parameter

New pure function in `mcp-substrate/src/doors.ts` (or a sibling `args-misuse.ts`):

```ts
interface ArgsClue {
  kind: "zod-path" | "value-mismatch" | "unexpected-keys" | "required-key";
  /** zod-path: the issues[].path array. Others: the quoted token(s) from the prose. */
  tokens: readonly string[];
  /** value-mismatch: the expected type named by the error ("object", "array", …). */
  expectedType?: string;
}

function extractClues(errorText: string): ArgsClue[];

interface Localized {
  /** Path from the call's top-level kwargs to the failing value, e.g. ["query"] or ["filter"]. */
  path: readonly string[];
  clue: ArgsClue;
  /** The sub-schema at `path`, resolved against the tool's inputSchema. */
  subSchema: JsonSchemaProperty;
  /** The value the model actually sent at `path` (when args are available). */
  sentValue?: unknown;
}

function localizeFailingParam(
  errorText: string,
  sentArgs: Record<string, unknown> | undefined,
  schema: ToolJsonSchema | undefined,
): Localized | undefined;
```

**Clue extraction** (two upstream families observed in the wild, both in the 45edee
trajectory and in `signature-echo.test.ts`'s pinned samples):

| family | pattern | clue |
|---|---|---|
| python-jsonschema | `'<v>' is not of type '<t>'` | value-mismatch, token=`v`, expectedType=`t` |
| python-jsonschema | `Additional properties are not allowed ('k1', 'k2' were unexpected)` | unexpected-keys, tokens=`[k1,k2]` |
| python-jsonschema | `'<k>' is a required property` | required-key, token=`k` |
| TS SDK / zod issues JSON | `"path": ["query", …]` (parse the `[{…}]` issues array when present) | zod-path — authoritative, no walk needed |

**Resolution walk** (the "args as ground truth" step) — against `sentArgs` first, falling
back to schema-only resolution when args are unavailable:

- *zod-path*: the path IS the answer; verify it resolves in the schema, else discard.
- *value-mismatch*: walk the sent-args tree; every leaf whose rendered value equals the
  quoted token is a candidate path. Exactly one candidate ⇒ localized (its parent param).
  Zero or several ⇒ `undefined` (fall back to signature echo — never guess).
- *unexpected-keys*: walk sent-args for the object(s) containing ALL quoted keys as own
  keys. Exactly one ⇒ localized. Cross-check: the schema node at that path must declare
  `properties` (so the "only these keys" teaching is truthful).
- *required-key*: walk the SCHEMA for nodes whose `required` includes the token; prefer
  the node whose parent path exists in sent-args. Exactly one ⇒ localized.

**Where sentArgs come from** — two sources, in preference order:

1. **Membrane metadata** (exact): bind.ts's `rosettaDef` impl holds the decoded JS `args`
   at the moment `tool.invoke` rejects. Wrap the rejection:
   `catch (e) { throw attachArgsRejection(e, { qualifiedName, sentArgs: args }); }` —
   a symbol-keyed property on the SAME error object; `error.message` stays byte-identical
   (H-4: verbatim pass-through is about the message, and the message is untouched).
2. **Form-walk fallback** (literal subset): the runner's catch already holds the parsed
   `forms[index]`; a `(tool :k literal …)` call's literal kwargs are readable off the
   pair structure (statement-facts style). Computed args (`:query (build-q)`) resolve to
   an opaque marker — value-mismatch clues then can't match them (correct: we don't know
   what they evaluated to), but zod-path and unexpected-keys… also can't. Fallback covers
   the dominant literal-args case; metadata covers everything.

### 2.3 Door shapes — EXACT rendered text, clinicaltrials case

All examples assume the reworked signature (nested shapes render). Schema-derived text
(key lists, descriptions) is interpolated from the live inputSchema at render time; what
this design freezes is the TEMPLATE (line heads + structure, §4).

**Level 1 — first misuse failure for (tool, param). Lean: localize + retry shape.**

Case A, value-mismatch (trajectory attempt 1, `:query "King Saud University"`):

```
Error: {"detail":"Failed to call tool 'clinicaltrialsgov-mcp-server_clinicaltrials_list_studies': Input validation error: 'King Saud University' is not of type 'object'"}
  Failing argument: :query — you sent the string "King Saud University"; :query takes an object with keys {cond, term, locn, titles, intr, outc, spons, id}.
  Retry shape: (clinicaltrialsgov-mcp-server/clinicaltrials_list_studies :query {:cond #|string|#} :pageSize 50 :countTotal true) — :cond is one example key; pick the key matching your intent: cond (conditions/disease), term (other terms), locn (location), titles (title/acronym), intr (intervention), outc (outcome), spons (sponsor/collaborator), id (NCT ids).
Signature: (clinicaltrialsgov-mcp-server/clinicaltrials_list_studies :query {cond:string?, term:string?, locn:string?, titles:string?, intr:string?, outc:string?, spons:string?, id:string?}? (A set of search terms that influence result ranking.) :filter {…}? … )
```

Construction rules (all deterministic, no LLM, no guessing-as-fact):
- `Failing argument:` line = fact (param name, sent value preview via the existing
  `previewOf` 60-char truncation, expected shape = the sub-schema's key list — keys only,
  no descriptions yet: L1 is the lean rung).
- `Retry shape:` = the model's OWN call (renderRetryExpr machinery) with ONLY the failing
  param rewritten — and every VALUE slot inside the rewritten param is a TYPE-PLACEHOLDER
  comment (`#|string|#`, `#|number|#`, matching the signature's own type vocabulary),
  never a concrete value (V, 2026-07-11: concrete examples drift — models copy rendered
  exprs verbatim, so an invented value or a relocated sent-value under our arbitrarily
  picked key becomes the model's next call). The key skeleton uses the first declared
  key as the example slot; the trailing menu (key + first-clause-of-description) makes
  the semantic pick explicit — suggest-menu tier, never a disguised certainty. A
  placeholder in value position is deliberately NOT evaluable (`{:cond #|string|#}` is a
  keyword with no value): our invention can never run as plausible data; the model must
  fill the hole. Where an UNFILLED hole fails depends on shape (verified against the real
  reader): a dict-literal hole fails at the reader (uneven dict), an odd count of kwarg
  holes fails at the kwargs decode (dangling keyword), and an even count of kwarg holes
  mis-pairs (`(t :a #|n|# :b #|n|#)` strips to `(t :a :b)` — `:b` becomes `:a`'s value,
  garbage the upstream's own validation rejects). The guarantee is "never our datum
  passing as real", not "always a reader-level failure". The same rule applies to
  `synthesizeExampleCall` (example-call.ts) wherever it currently invents stub values for
  non-enum slots: type comments, not fabricated data. (Enum slots may show a real member
  — an enum member is schema fact, not invention.)
- The existing `Example:` line is REPLACED by `Retry shape:` when localization succeeds
  (the model's own args beat a generic stub); unlocalized fallback keeps
  Signature+Example exactly as today.

Case B, unexpected-key with a tight match (trajectory attempt 2, `:query {:terms …}`) —
the explicit-fact tier, reusing `isTightMatch` at the key level:

```
Error: {"detail":"Failed to call tool 'clinicaltrialsgov-mcp-server_clinicaltrials_list_studies': Input validation error: Additional properties are not allowed ('terms' was unexpected)"}
  Failing argument: :query — it has no key :terms; the key you want is :term.
  Retry shape: (clinicaltrialsgov-mcp-server/clinicaltrials_list_studies :query {:term "King Saud University"} :pageSize 50 :countTotal true)
Signature: (clinicaltrialsgov-mcp-server/clinicaltrials_list_studies :query {cond:string?, term:string?, …}? … )
```

This retry shape is copy-paste-correct — the trajectory ends at attempt 3 instead of 34.

Case C, unexpected-key with NO tight match (trajectory attempt 5,
`:filter {:startDateRange …}`) — menu tier:

```
Error: {"detail":"Failed to call tool 'clinicaltrialsgov-mcp-server_clinicaltrials_list_studies': Input validation error: Additional properties are not allowed ('startDateRange' was unexpected)"}
  Failing argument: :filter — it has no key :startDateRange; its keys are {overallStatus, geo, ids, advanced, synonyms}.
  Retry shape: (clinicaltrialsgov-mcp-server/clinicaltrials_list_studies :query {:term "King Saud University"} :filter {:advanced "string value"} :pageSize 50) — :advanced is one example; pick the key matching your intent (see each key's description in the signature).
Signature: … :filter {overallStatus:[string]?, geo:string? #|A geo-function filter, e.g. distance(lat,lon,radius)|#, ids:[string]?, advanced:string? #|A filter in Essie expression syntax, e.g. AREA[StartDate]RANGE[2024-01-01,2024-12-31]|#, synonyms:boolean?}? …
```

(The 13 filter attempts guessed `AREA[StartDate]RANGE[…]` SYNTAX correctly from message 18
onward — only the key `advanced` was unknown. The key menu at attempt 5 + the schema's own
example in the signature closes it.)

**Level 2 — second consecutive misuse failure for the SAME (tool, param). Full sub-schema
dump + closed-world warning.** Appended AFTER the L1 lines (which re-render — the model
may not have the first door in a compacted context):

```
  Parameter :query in full — an object; only these keys exist (any other key is rejected):
    cond:string?    — 'Conditions or disease' query. Matches the ConditionSearch area.
    term:string?    — 'Other terms' query. Matches the BasicSearch area.
    locn:string?    — 'Location terms' query.
    titles:string?  — 'Title / acronym' query.
    intr:string?    — 'Intervention / treatment' query.
    outc:string?    — 'Outcome measure' query.
    spons:string?   — 'Sponsor / collaborator' query.
    id:string?      — 'Study IDs' query (NCT numbers).
```

- One line per key: `name:typeToken` + `?` for optional + the FULL schema description
  (this is the one place full descriptions ride an error — earned by a repeat failure).
- The `only these keys exist` clause renders ONLY when it is a fact: the sub-schema
  declares `additionalProperties: false`, OR the current error itself is an
  unexpected-keys rejection (the upstream just demonstrated closed-world behavior).
  Otherwise the head is `Parameter :query in full — an object with keys:`.
- Nested sub-objects inside the dump render their shape via the signature renderer's
  `objectToken` (shared, not duplicated), depth-capped as there.

**Level 3 — third-and-later consecutive misuse failure for the SAME (tool, param).
L1 + L2 content plus the anti-guess script (futility voice):**

```
  This is rejected shape #5 for :filter on this tool. The key list above is COMPLETE —
  do not invent further key names or syntaxes. If none of these keys expresses your
  intent, this tool cannot express it: pick a different tool, or work from the evidence
  you already have.
```

(`#5` = the tracker's consecutive-failure count for that (tool, param) — a fact we hold.)

**Level ⊥ — misuse error that did NOT localize.** Today's behavior, unchanged:
`Signature: …` + `Example: …`. The tracker still counts it (keyed to the ⊥ param), so a
repeatedly-unlocalizable misuse on one tool escalates at L2+ to dumping the FULL input
schema (all params, all keys, all descriptions) — the "when in doubt, eventually show
everything" backstop, deliberately expensive and deliberately late.

### 2.4 Escalation state machinery

New `mcp-substrate/src/args-failure-tracker.ts`, a deliberate sibling of
`FutilityTracker` (same injection pattern, same export/import discipline):

```ts
export class ArgsFailureTracker {
  /** key = `${qualifiedName}\0${paramPathJoined}` ("\0⊥" for unlocalized). */
  private readonly byToolParam = new Map<string, { count: number }>();

  /** Record one misuse failure; returns the level to render (1 | 2 | 3, capped). */
  recordFailure(qualifiedName: string, paramPath: readonly string[] | undefined): 1 | 2 | 3;

  /** A successful call of this tool clears ALL its param counters — the model has a
   *  working shape now; the next failure starts a fresh lesson at L1. */
  recordSuccess(qualifiedName: string): void;

  exportState(): ArgsFailureState;   // session-store round-trip, futility precedent
  importState(state: ArgsFailureState): void;
}
```

Decisions:

- **Consecutive, not lifetime**: reset-on-success keeps a long healthy session from
  eventually greeting every hiccup with a full schema dump.
- **Count identical retries too** (unlike futility's `firedFutileHash` re-fire gate): 34
  near-identical retries is exactly the case escalation exists for. No hash-dedup here.
- **NOT in DoorSession**: the `seen`-Set is a monotonic verbose-once-then-terse gradient;
  escalation is the opposite gradient and needs decrement/reset semantics. Mixing them
  would corrupt both contracts. The tracker is injected alongside `session`/`tracker`
  into `createDoorsRunner` (options field `argsTracker`), constructed per server process
  in `server.ts` next to the existing `FutilityTracker`, so it survives
  tools/listChanged rebuilds.
- **SessionBlob**: additive `argsFailures` key on the v1 blob (absent in old blobs ⇒
  empty tracker; no version bump needed — restore already tolerates unknown/missing keys
  per the `competence` precedent in runner.ts's SessionBlob doc).
- **Telemetry**: each render logs the usual door line plus the level:
  `{"door":"envelope/args-misuse","seq":n,"tool":qualifiedName,"param":"query","level":2}` —
  the benches can then measure retries-per-level directly (follow-rate discipline, Rule 5).

### 2.5 Layer (b): our own kwargs zod-decode rejection — the humanizer

Site: `foundations/arrival/arrival/src/common/symbols/rosetta.ts:114` —
`z.decode(kwargsSchema, collectKwargsObject(args))`. A ZodError from this decode
currently propagates as a raw issues dump (regression; the dangling-keyword door beside
it at `_bake.ts:670` shows the intended register).

Fix (arrival-owned, small): catch `ZodError` from the kwargs decode only, rethrow with a
humanized message; all other errors pass through untouched:

```
<name>: arguments rejected — 2 problem(s):
  :query — missing (required)
  :pageSize — expected number, got string: "50"
```

Per-issue line = `:<path joined with .> — <humanized issue>`:
- `invalid_type` + received `undefined` ⇒ `missing (required)`
- `invalid_type` otherwise ⇒ `expected <expected>, got <received>: <preview>` (preview =
  the 60-char truncation, same convention as bind.ts's `previewOf`)
- `unrecognized_keys` ⇒ `unknown key(s) :k1, :k2` (only reachable if strictness lands —
  see Open Question 1)
- anything else ⇒ zod's own `message` for that issue (never the whole dump).

Then:
1. Add `/: arguments rejected — /` to `TOOL_MISUSE_SHAPES` (doors.ts:839) so this shape
   gets the localized door + escalation like any upstream rejection.
2. This message NAMES its param natively ⇒ `extractClues` gets a fourth, first-priority
   family: `own-decode` (parse `:param —` line heads; no walk needed).

Note the manifold's tool contracts are `z.value`-per-param (bind.ts:277-278), so at OUR
layer only missing-required realistically fires today — but the humanizer is generic
arrival machinery and every kwargs rosetta (r7rs packs, arrival-mcp) inherits it.

### 2.6 Worked-example synthesis for the failing param

`example-call.ts` grows one export (no behavior change to `synthesizeExampleCall`):

```ts
/** A minimal schema-valid value for ONE property, rendered in reader grammar —
 *  `{:spons "string value"}` for the clinicaltrials query param. Depth budget starts
 *  AT this property (the caller is already focused one level down), so a nested object
 *  param shows its own required keys before collapsing. */
export function synthesizeParamValue(prop: JsonSchemaProperty): string; // stubValue + renderLiteral
```

The L1 `Retry shape:` composes: the model's own sent args (renderRetryExpr) with the
failing param's value replaced by (in priority order):
1. tight-match key rename of the model's own sent object (case B — exact fix);
2. the model's own scalar relocated under the sub-schema's first declared/required key,
   with the pick-a-key menu (case A);
3. `synthesizeParamValue(subSchema)` stub when the sent value is unusable (case C, or a
   computed arg under the form-walk fallback).

`renderRetryExpr` returning `undefined` (non-bare-keyword top-level key) degrades to the
existing teach-the-shape wording — precedent already in `bareToolCallDoor`.

---

## 3. Hook points (file:line, at today's HEAD)

| # | site | change |
|---|---|---|
| 1 | `second-foundation/arrival-manifold/src/bind.ts:298` (`await tool.invoke(args, …)`) | try/catch → `attachArgsRejection(e, {qualifiedName, sentArgs: args})` (symbol-keyed metadata, message untouched); also call `argsTracker.recordSuccess(qualifiedName)` beside the existing `tracker?.record(…)` on line 299 |
| 2 | `foundations/arrival/mcp-substrate/src/runner.ts:405-415` (the signature-echo `else` branch) | becomes the args-misuse pipeline: `strategies.isMisuseError(raw)` → `localizeFailingParam(raw, argsOf(error) ?? formWalk(forms[index]), tools.get(tool)?.schema)` → `argsTracker.recordFailure(…)` → render L1/L2/L3 (localized) or Signature+Example (⊥, today's path) |
| 3 | `foundations/arrival/mcp-substrate/src/doors.ts` | new: `extractClues`, `localizeFailingParam`, `argsMisuseDoor(level, localized, …)` generators; `TOOL_MISUSE_SHAPES` gains the own-decode regex (§2.5); key-level tight-match reuses `normalizeSymbolName`/`editDistance`/`isTightMatch` (doors.ts:166/126/439) |
| 4 | `foundations/arrival/mcp-substrate/src/doors.ts:1049` (`DoorSession.echoSignature`) | sibling `appendArgsTeaching(tool, param, level, body)` — same log-and-return-suffix shape, telemetry line carries `param` + `level`; NO verbose/terse gate (escalation replaces it, signature-echo precedent) |
| 5 | `foundations/arrival/mcp-substrate/src/args-failure-tracker.ts` (new) | `ArgsFailureTracker` (§2.4) |
| 6 | `foundations/arrival/mcp-substrate/src/runner.ts:209-217` (SessionBlob) + `:455-477` (export/restore) | additive `argsFailures` key |
| 7 | `foundations/arrival/mcp-substrate/src/example-call.ts:205` | new export `synthesizeParamValue` (§2.6) |
| 8 | `foundations/arrival/arrival/src/common/symbols/rosetta.ts:114` | kwargs-decode ZodError humanizer (§2.5) |
| 9 | `second-foundation/arrival-manifold/src/manifold-tool.ts:206` + `src/server.ts` (tracker construction site) | thread `argsTracker` per server process, next to `FutilityTracker` |
| 10 | `foundations/arrival/mcp-substrate/src/strategies.ts` | localization + clue extraction ride the strategy seam like `isMisuseError` does — the positional consumer (arrival-mcp) has different arg grammar, its `formWalk`/retry-shape renderer differs |

---

## 4. H-4 re-freeze list

The frozen contract (error-contract.test.ts + `second-foundation/arrival-bench/bridge/arrival_bridge_parity.py` + the four
bench ports) changes as follows. Rule of thumb preserved: consumers match the FIRST line;
teaching is always an appended tail.

**Unchanged (stay byte-identical, re-asserted):**
- Upstream tool error text reaches the model VERBATIM as the first line
  (`Error: <upstream message>`) — metadata rides the error OBJECT, never the message.
- All existing frozen strings: unbound-variable, dangling-keyword kwargs, `s/*`
  assertion, attestation wrap, empty-expr, invalid-args, timeout, disabled-verb,
  scheme `(error …)`, parse errors.
- Unlocalized misuse fallback: `\nSignature: <sig>` + `\nExample: <call>` (existing
  echoSignature shape).

**New frozen line-heads (tail grammar — freeze the heads, not full lines; P16: the
interpolated content is schema-derived and must stay free to follow the schema):**
- `\n  Failing argument: :<param> — ` (L1 fact line)
- `\n  Retry shape: ` (L1 script line; the expr after it is parseable by construction)
- `\n  Parameter :<param> in full — ` (L2 head; the closed-world clause
  `only these keys exist (any other key is rejected):` is itself frozen when present)
- `\n  This is rejected shape #<n> for :<param> on this tool.` (L3 head)
- `the key you want is :<key>.` (case-B explicit-fact clause — the one full-sentence
  freeze, because bridges may want to machine-read the rename)

**New frozen first line (replaces the raw ZodError dump — a regression, no consumer to
preserve):**
- `Error: <name>: arguments rejected — <n> problem(s):` followed by
  `\n  :<param> — <issue>` lines, issue grammar per §2.5.

**Consumer sequencing:** land the TS side + error-contract.test.ts + parity fixture
updates in ONE commit (the H-4 header's own rule: change pinned strings only together
with every consumer). The bench ports parse `^Error: ` off block 0 only — tail-grammar
additions are non-breaking for them; `arrival_bridge_parity.py` gets the new line-head
assertions.

---

## 5. Test plan (claim-ledger)

Per P15 (green = intended; prefer coherence laws over point assertions) and P16 (pin
behavior; impl-pinning only as drift alarms):

| # | claim | test | kind |
|---|---|---|---|
| T1 | Every rendered `Retry shape:` expr parses and its head is the implicated tool | property test: synthesize schemas × sent-args × clue families → tokenize/parse the rendered expr | coherence law (renderer vs reader) |
| T2 | `localizeFailingParam` never names a param absent from the tool's schema; ambiguous clue ⇒ `undefined` | fuzz: clue tokens matching 0/2+ paths; duplicate values across params | soundness law ("never guess as fact") |
| T3 | Key-level rename: unexpected-key at edit distance ≤1 from exactly one sub-schema key ⇒ case-B explicit fact; else menu (case C) | unit over `terms→term`, `startDateRange→⊥`; boundary at `isTightMatch`'s own gate | behavior + drift alarm on the shared gate |
| T4 | Escalation is monotone per (tool,param), capped at 3, and resets on that tool's success — including across a session export/import round-trip | ArgsFailureTracker unit + SessionBlob round-trip | behavior |
| T5 | The 45edee replay: attempts 1, 2 and 5's recorded error strings + recorded sent-args through the pipeline render the §2.3 goldens | golden fixtures (recorded strings checked in; no live upstream) in `__tests__/` — verdict-producing, not research | golden (drift alarm, deliberate) |
| T6 | H-4 re-freeze rows | error-contract.test.ts updated in the same commit; `second-foundation/arrival-bench/bridge/arrival_bridge_parity.py` parity | frozen contract |
| T7 | Our-decode humanizer: missing required kwarg through a REAL manifold tool renders the §2.5 frozen shape | until the rosetta.ts humanizer lands, this row is `it.fails` documenting the raw-dump regression (P15: never pin current-broken green); flips loudly with hook #8 | coherence (manifold vs arrival membrane) |
| T8 | Upstream message verbatim-ness survives metadata attachment (`error.message` byte-identical before/after `attachArgsRejection`) | unit at bind.ts | invariant |
| T9 | Unlocalized fallback byte-identical to today's Signature+Example echo | existing signature-echo tests stay green untouched | regression fence |
| T10 | L2's closed-world clause renders iff `additionalProperties:false` or an unexpected-keys clue — never on an open schema | unit | truthfulness law |
| T11 | Telemetry line shape `{door, seq, tool, param, level}` | unit on `appendArgsTeaching` | drift alarm |

Bench validation (opt-in, `__custdev__`/atlas rerun): retries-per-misuse-failure and
level distribution before/after — the 45edee-class tasks are the measured target
(signature rework alone bought 1.9pp; this door targets the residual retry tail).

---

## 6. Open questions

1. **Does our kwargs layer silently STRIP unknown keys?** zod's `z.object` default strips
   unrecognized keys; if `z.object(shape)` at rosetta.ts:114 strips, a misspelled kwarg
   (`:pagesize 50`) silently vanishes at OUR layer and the tool runs without it — a
   silent failure, worse than any error. Verify against the interpreter; if confirmed,
   the kwargs schema should be strict (`z.strictObject`) and the resulting
   `unrecognized_keys` issue feeds the §2.5 humanizer + key-level tight-match ("the key
   you want is `:pageSize`"). Separate commit — it changes accept/reject behavior, not
   just reporting.
2. **Tracker unification**: `ArgsFailureTracker` and `FutilityTracker` are structural
   siblings (per-tool state, drain/reset, export/import). v1 keeps them separate —
   futility watches SUCCESSFUL non-progress, this watches FAILURES; merging their state
   machines saves ~60 lines and couples two different reset semantics. Revisit only if a
   third tracker sibling appears.
3. **Enum-value menus**: a value-mismatch clue on an enum param could render the legal
   values as the menu (`:overallStatus takes one of "RECRUITING" | …`). The signature
   already shows enums; deferred until a trajectory shows models failing on it.
4. **L2 dump size cap**: a pathological sub-schema (50+ keys) makes the full dump itself
   a token hazard. Proposed cap: 24 key lines, then `… +N more keys — narrow with the
   signature above` (mirrors observation compaction's `+N more` convention). Needs a
   real offender to calibrate against.
5. **Localization across multiple statements**: a program with two calls to the SAME tool
   where only one failed — `implicatedTool` already resolves per-statement, and sent-args
   metadata is per-invoke, so this should compose; the property test (T1/T2) should
   include a two-call program to prove it.


---

## 7. RED SUITE + LANDING STRATEGY (2026-07-11, V: design red tests first; impl lands in arrival core)

### 7.1 The mechanics: `it.fails` + `it.todo`, never a red gate

P15 truth table discipline: rows exercisable through EXISTING surfaces land as `it.fails`
(they flip LOUDLY when the implementation arrives — an it.fails that passes is a failure);
rows contracting NEW exports (functions that don't exist yet — a red test importing them
wouldn't compile) land as `it.todo` carrying the full row spec in title + comment. No
red-by-design plain-`it` files (the replay-cache-restore pattern predates this; it.fails
is the stricter form). Every gate stays green throughout; every flip is mechanical.

### 7.2 Red rows by package

**foundations/arrival/arrival — new `src/__tests__/kwargs-decode-errors.test.ts`**
(header: "coordinates with arrival-manifold docs/args-error-reporting-v2.md — the frozen
strings below are H-4-adjacent; do not implement piecemeal"):
- R1 `it.fails` — kwargs decode rejection is humanized, frozen head:
  `<qualified>: arguments rejected — 1 problem(s):` then per-issue
  `  :query — expected object, got string: "King Saud University"`. (Today: raw ZodError
  issues dump — the known regression.)
- R2 `it.fails` — THE SILENT-STRIP PROBE: a misspelled kwarg key (`:qeury`) on a schema
  with known keys is REJECTED, never silently dropped. (Today: z.object default likely
  strips — if this row unexpectedly PASSES at authoring time, the hazard is disproven and
  the row becomes a plain pin; if it fails, it documents the strictObject fix contract.)
- R3 `it.fails` — multi-issue rejection counts and lists each issue on its own line,
  stable order (schema declaration order).

**foundations/arrival/mcp-substrate — new `src/__tests__/args-misuse.test.ts`:**
- S1 `it.todo` — extractClues: 4-family table (value-mismatch / unexpected-keys /
  required-key / zod-path) with the 45edee verbatim error strings as fixtures.
- S2 `it.todo` — localizeFailingParam soundness: exactly-one-candidate localizes; zero or
  several → undefined (fuzz row: random arg trees, planted collisions).
- S3 `it.todo` — ArgsFailureTracker: L1→L2→L3 monotone per (tool,param); success clears
  ALL params of that tool; ⊥ key escalates too.
- S4 `it.fails` — synthesizeExampleCall renders type-placeholder comments (`#|string|#`)
  for non-enum slots, real member for enum slots. (Exercisable: fn exists today, stubs
  concrete values.)
- S5 `it.todo` — retry-shape builder: holes only in the rewritten param; result parses
  as a reader form; NEVER contains the model's sent scalar nor invented data.

**second-foundation/arrival-manifold — new `src/__tests__/args-misuse-door.test.ts`
+ rows appended to error-contract.test.ts:**
- M1 `it.fails` — e2e L1: fake upstream rejects with the jsonschema value-mismatch text →
  observation = verbatim first line + `Failing argument:` + `Retry shape:` (with
  `#|string|#` holes) + `Signature:`.
- M2 `it.fails` — e2e L2 second consecutive failure: `Parameter :query in full — … only
  these keys exist` ONLY when additionalProperties:false or unexpected-keys evidence.
- M3 `it.fails` — e2e L3: `This is rejected shape #3 …` counter from tracker.
- M4 plain `it` (pin, passes TODAY) — unlocalizable misuse keeps byte-identical
  Signature+Example fallback: the do-no-harm guard that must never break during landing.
- M5 `it.fails` — membrane metadata: rejection error object carries
  {qualifiedName, sentArgs} under the symbol key; error.message byte-unchanged.
- H-4 rows: the new frozen line-heads appended to error-contract.test.ts as an `it.fails`
  block; second-foundation/arrival-bench/bridge/arrival_bridge_parity.py gets matching xfail rows. FLIP = ONE commit
  spanning both languages (the H-4 one-commit rule).

### 7.3 Landing strategy (arrival core is another agent's active turf)

- **Phase 0 — red suite, NOW.** All three packages + python xfail rows. Purely additive
  (new test files, it.fails/it.todo), zero collision surface, gates stay green. The core
  red file doubles as the in-tree COORDINATION SIGNAL to the internals agent: the
  contract is visible where they work, before any code moves.
- **Phase 1 — arrival core, smallest possible diff.** `formatKwargsRejection()` as a NEW
  file (common/kwargs-rejection.ts, pure function, owns the frozen strings) + a 2-line
  catch-site patch at rosetta.ts:112 + the strictObject change if R2 confirmed the strip.
  New-file-heavy shape = trivial rebase under churn; the rosetta.ts touch is the only
  contended line. Land in a settle window (gate: arrival suite green on the day).
- **Phase 2 — substrate.** Door + clues + tracker + example-call holes (S-rows flip).
- **Phase 3 — manifold.** bind.ts metadata attach, runner wiring, M-rows flip, H-4
  re-freeze + python parity in the single closing commit.
- Each phase flips its own rows; an unflipped it.fails that starts passing fails the
  gate — the ledger polices the sequencing mechanically.
