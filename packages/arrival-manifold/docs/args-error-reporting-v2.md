# Arguments-Error Reporting v2 — path-targeted doors with repeat-failure escalation

Companion to the tool-signature nested-shape rework (a tool's nested object parameters
render recursively in its signature): this design covers what the arguments-error door
does beyond echoing that signature when a tool call's arguments are rejected.

## 1. Problem

An MCP tool's argument-rejection text usually names only a top-level mismatch — "expected
object, got string", or "unexpected key" — even when the failing parameter is itself a
multi-key nested object the model has never seen expanded. Repeating the whole signature
on every such rejection teaches nothing new: the model already has the signature; what it
needs is the ONE parameter that failed, its actual keys, and a shape it can retry with.

For example, a tool declares a `:query` parameter as a closed object with keys
`{cond, term, locn, titles, intr, outc, spons, id}`. A model that sends
`:query "some text"` (a bare string where an object is required), or
`:query {:terms "some text"}` (a plausible but wrong key), or `:query {:search "…"}`
(another wrong guess) gets no closer to the real shape from the raw upstream text alone —
each rejection restates the same top-level mismatch. The door below turns each rejection
into a lesson about that one parameter.

Three observations shape the design:

1. **The arguments the model actually sent are ground truth at the door.** Upstream error
   prose does not need full parsing — its clue tokens (a quoted value, a quoted unexpected
   key, a decode-path array) intersect against the sent-args tree the door already holds.
2. **"Unexpected key + here are the real keys" is a solved problem one level down.** The
   same tight-match machinery that resolves a misnamed tool name resolves a misnamed key.
3. **Many near-identical retries is a repetition problem**, not a one-shot teaching
   problem — repetition on the same (tool, parameter) earns MORE detail, not less.

## 2. Design

### 2.1 The door

One door, `envelope/args-misuse`, covers two rejection layers:

- **Upstream pass-through** — the called tool rejected its arguments (HTTP validation
  detail text, an RPC error code, an SDK validation message, JSON-Schema validator
  prose). The upstream text always reaches the model verbatim as the first line; the door
  only ever appends teaching below it.
- **The manifold's own keyword-argument decode rejection** — described in §2.5.

Where localization succeeds, the door replaces the bare signature echo with a localized
teach (below). Where localization fails — no clue matches, or the evidence matches more
than one candidate — the door falls back to a plain `Signature:` + `Example:` echo,
byte-identical to the unlocalized case: a guess is never rendered as fact.

### 2.2 Localization: error text → failing parameter

The door extracts a family-tagged clue from the rejection text, then resolves it against
the arguments the model actually sent (falling back to schema-only resolution when the
sent arguments are unavailable):

| clue family | pattern | resolves via |
|---|---|---|
| own-decode | our own humanized rejection's `:<path> — <issue>` line head (§2.5) | the path is the answer — no search needed |
| own-unknown-key | our own rejection naming one unrecognized top-level keyword | tight-matched by edit distance against the declared parameters |
| decode-path | an SDK/validator issues-path array | the path is the answer — no search needed |
| value-mismatch | `'<value>' is not of type '<type>'` | walk the sent-args tree for the one leaf equal to `<value>`; zero or several matches ⇒ no localization |
| unexpected-keys | `Additional properties are not allowed ('<k1>', '<k2>' were unexpected)` | walk the sent-args tree for the one object containing every quoted key as its own key |
| required-key | `'<key>' is a required property` | walk the schema for the node whose `required` list contains `<key>`, preferring one whose parent path exists in the sent arguments |

**Where the sent arguments come from**, in preference order:

1. **Membrane metadata (exact)** — the decoded arguments the manifold bound at the moment
   the call was rejected, carried on the rejection itself rather than in its message (the
   message stays untouched; only the error object carries the extra data).
2. **A literal-args form-walk (fallback)** — when metadata is unavailable, a keyword
   call's literal argument values are read directly off the call's own parsed form. A
   computed argument (the value of an expression, not a literal) resolves to an opaque
   marker, so a value-mismatch clue correctly cannot match it — the door does not claim to
   know what an unevaluated expression will produce.

### 2.3 Door message shapes

**Level 1 — first misuse failure for a (tool, parameter) pair.** Lean: localize, then
offer a retry shape. Three cases, depending on what the clue resolves to:

- **A value-mismatch** (the model sent a bare value where an object was required): the
  door names the failing parameter, previews the value that was sent, states the
  parameter's real top-level keys, and offers a retry expression — the model's own call
  with only that parameter rewritten, its value slot filled by a type placeholder
  (`{:cond #|string|#}`) plus a short menu of the real keys and their intents.
- **An unexpected key with a near match** (the model sent `:terms` where the schema
  declares `:term`): the door states the rename directly — "it has no key `:terms`; the
  key you want is `:term`" — and the retry expression is copy-paste-correct.
- **An unexpected key with no near match**: the door lists the parameter's real keys as a
  menu (key plus the first clause of its description) rather than guessing a rename.

**Level 2 — second consecutive misuse failure on the same (tool, parameter).** The L1
lines re-render (a later door may land in a context that no longer holds the first one),
followed by the full sub-schema: one line per key, each with its full description,
capped at 24 key lines with a `… +N more keys` tail on an oversized schema. The clause
"only these keys exist (any other key is rejected)" renders only when it is true for that
schema (the sub-schema declares no additional properties) or the current rejection is
itself an unexpected-keys rejection (the upstream has just demonstrated the closed-world
behavior) — never as an unearned claim.

**Level 3 — third and later consecutive misuse failure on the same (tool, parameter).**
L1 and L2 content, plus an explicit stop: "this is rejected shape #`<n>` for `:<param>` on
this tool. The key list above is complete — do not invent further key names or syntaxes.
If none of these keys expresses your intent, this tool cannot express it."

**Level ⊥ — a misuse rejection that does not localize.** Unchanged from the pre-existing
behavior: `Signature:` + `Example:`. Repeated unlocalizable rejections on the same tool
still escalate — at level 2 and above they add a dump of the tool's full input schema
(every parameter, every key, every description), a deliberately expensive, deliberately
late backstop for the case where nothing narrower can be said.

### 2.4 Escalation state

A per-(tool, parameter) counter tracks consecutive misuse failures and drives the level
above, capped at 3:

- **Consecutive, not lifetime** — any successful call of a tool clears all of that tool's
  parameter counters, so a long healthy session does not eventually greet a single hiccup
  with a full-schema dump; the next failure starts a fresh L1.
- **Identical retries count too** — repeating the exact same wrong shape several times in
  a row is exactly the case escalation exists to interrupt, so retries are not deduplicated
  before counting.
- **The counter survives a session round-trip** alongside the rest of session state.

### 2.5 The manifold's own kwargs-decode rejection

Separately from an upstream tool's own rejection, the manifold's own decode of a tool
call's keyword arguments can itself reject — a required key missing, a value of the wrong
type, or an unrecognized key. That rejection is humanized rather than surfaced as a raw
validation-library dump:

```
<name>: arguments rejected — <n> problem(s):
  :<param> — <issue>
```

One line per problem, in the schema's own declaration order; `<issue>` reads as
`missing (required)`, `expected <type>, got <type>: <value preview>`, or
`unknown key(s) :<k1>, :<k2>` as appropriate. This decode is **strict** — an unrecognized
keyword is rejected, never silently discarded (the rationale and the silent-strip hazards it
closes live in `kwargs-rejection.ts`). Because this message already names its own
parameter, it feeds the same localized door pipeline as an upstream rejection with no
clue-walking needed — it is itself an `own-decode` clue.

### 2.6 Retry-shape synthesis

An L1 retry expression is the model's own call with only the failing parameter's value
rewritten, in priority order:

1. a tight-matched key rename of the model's own sent object, when the unexpected-key case
   resolves one (a copy-paste-correct fix);
2. the model's own scalar relocated under the sub-schema's first declared key, with a
   pick-the-right-key menu, when the value-mismatch case applies;
3. a synthesized stub value when neither applies (a nested object, or a computed argument
   the door never saw evaluated).

Every synthesized value slot is a type-placeholder marker, never a concrete invented
value: a rendered example gets copied verbatim by models, so an invented value in a value
position would become the model's next literal call. The one exception is an enum
parameter, where a real member is shown — a schema fact, not an invention.

## 3. Frozen line-heads

The following line heads are pinned for every consumer of the door's output — the
interpolated content that follows each head is schema-derived and stays free to follow
whatever schema a given tool declares:

- `\n  Failing argument: :<param> — ` (L1 fact line)
- `\n  Retry shape: ` (L1 retry-expression line)
- `\n  Parameter :<param> in full — ` (L2 head; the closed-world clause is itself pinned
  when it renders)
- `\n  This is rejected shape #<n> for :<param> on this tool.` (L3 head)
- `the key you want is :<key>.` (the unexpected-key-with-near-match clause)
- `Error: <name>: arguments rejected — <n> problem(s):` followed by `\n  :<param> — <issue>`
  lines (§2.5's humanized rejection)

The unlocalized fallback (`Signature:` + `Example:`) stays byte-identical to the shape it
had before this door existed — the one guarantee that must survive every other change
here.

## Known limits

- A value-mismatch clue on an enum parameter does not render the legal enum values as a
  menu; only a retry-shape stub value shows a real member. Worth adding once a real
  trajectory shows a model failing to guess an enum value from the signature alone.
- The escalation counter deliberately stays a separate structure from the rest of a
  session's repeat-failure tracking rather than sharing one state machine with it —
  their reset conditions are opposites (one clears on success, the other on
  non-progress), and merging them would couple two different contracts for a small line
  saving. Revisit only if a third sibling tracker appears.
