# 2026-04 API redesign — what the ideation cycle decided

**Outcome: the current package IS the landed design.** Tools are plain values (`DiscoveryTool` / `ActionTool` — H1), with an explicit `prepare()` phase returning `{prep, cleanup}` (H2), data-shaped polymorphic `Ref`s (H3), required `intent` on every action call (H5), and per-phase timeouts plus a typed `MCPErrorKind` kernel (H7). The prior `ToolInteraction` base-class architecture — ~2800-LoC constructors of `registerAction` calls, Zod transforms doing environment setup via side effects, four parallel registration mechanisms — is gone. The living design is the package README; this file records only how the cycle got there and what it decided against.

## The cycle

Seven hypotheses (H1 tools-as-values · H2 prepare lifecycle · H3 totalic refs · H4 declarative fn layer · H5 intent-as-structural · H6 named sanitizers · H7 safety fabric), reviewed twice by six max-distance lenses (type-purist, scheme-native, go-minimalist, principal-API, LLM-practitioner, adversarial). v2 verdict: 5 of 6 "ship with conditions"; the reviewer-consensus minimum subset was H6 + H7 (timeouts, size limits, typed errors) + H5 `intentRequired`.

## What each hypothesis became

- **H1** → shipped as-is; the package's headline.
- **H2** → shipped; the rollback fork (Path A real atomicity vs Path B honest best-effort) resolved as B-made-explicit: batches halt on first failure with a partial report, no rollback; callers wrap with `wrapBatch` when the burst must be atomic.
- **H3** → shipped, but as none of the five reviewer-proposed shapes: `Ref` is introspectable data (`shapes: RefShape[]`), `parse() → Result<T>`, never throws.
- **H4** → superseded. `FnDecl[]` / `fn()` / `prop()` / `methodsOf()` were never built; the four-registration-mechanism problem dissolved into `McpEnvCapability` — one capability owns symbols + configuration + resources, and `DiscoveryTool` derives its entire MCP surface from it.
- **H5** → shipped; `intent` is `required` in the action schema and echoed in every response envelope.
- **H6** → moot; the `executeTool` LLM-quirk coercions died with the old architecture instead of being extracted.
- **H7** → partially shipped: per-phase timeouts (prepare / handler / batch) and typed error kinds landed; idempotency keys did not (see below — deliberate).

## Decided-against alternatives (the durable value)

- **MRO / polymorphic dispatch for the fn layer** — killed in v2, unanimously. Exact-class match only; a subclass needs an explicit declaration.
- **LLM self-reported confusion field** (`confusionInPreviousQueriesEncountered`) — deleted. Custdev signal must be derived server-side (retry-chain telemetry, `retryOf: interactionId`), never from LLM self-report.
- **String-tag sanitizer routing** (`applies: "all"`) — deleted; a sanitizer must be an explicit, per-site, schema-gated call. Broadly-applied coercions (JSON-string→container, numeric-key-object→array) are exploitable via union-shape confusion.
- **Reserved-name registry** (H7 §4 Option A) — rejected by three lenses converging on namespace separation (Option B): a registry makes additive names a breaking change and fights the substrate.
- **Optional idempotency keys** — flagged as an anti-pattern (optional fields don't get populated): ship required or not at all. Not-at-all is what shipped.
- **`ErrorKind` with a `runtime` trash bucket** — rejected (defeats exhaustive handling; LLMs waste turns retrying permanent errors); the shipped kernel keeps kinds discrete and additive-safe.
- **Left open on purpose:** the scheme-substrate meta-question ("you have a homoiconic runtime — why is extension written in TypeScript?") was the one framing challenge no review resolved. It stayed the author's strategic call, and its shape survives in the shipped asymmetry: discovery is a Scheme REPL over a capability; actions are typed TS field specs.

---

Distilled 2026-08-02 from the 26-doc ideation cycle formerly at `docs/package-specific/arrival-mcp/` (framing + h1–h7 + six lens reviews × 2 rounds + syntheses); see git history for the full record.
