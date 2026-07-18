/**
 * The named-opinions census — §2 of the dual-runtime design doc
 * (`docs/working-proposals/inhuman-mercury-ts-dual-runtime.md`). Strategy IS data:
 * every writing decision the compiler makes is enumerated here, tagged with its
 * frame-doc axis (`entropy` = statically resolves something the runtime would
 * otherwise carry; `spelling` = encoding among equals — spelling, layout, idiom),
 * and honestly marked with what's actually true of the code TODAY.
 *
 * `ts-base` (this file's `TS_BASE_OPINIONS`) is the shared opinion set both runtime
 * strategies extend — it is not itself a selectable `Strategy.id`. `RUNTIME_OPINIONS`
 * holds the two runtimes' `rt/*` fills: SAME opinion ids, DIFFERENT decisions per
 * runtime (§2.2 vs §2.3) — the runtime axis made real, not a forked vocabulary.
 *
 * `status` is the honest ledger, not aspiration: `"landed"` opinions describe
 * behavior that exists in this package's code right now; `"partial"` opinions are
 * partway there; `"new"` opinions are registry-only (the emission that would
 * realize them lands in a later wave — W3 for ts-base, W4/W5 for the two runtimes);
 * `"deferred"` opinions are explicitly scheduled behind a named gate. W1 (this
 * wave) changes none of that — it names what's true, it doesn't make anything
 * truer.
 */

export type OpinionAxis = "entropy" | "spelling";

/** Honest status, not aspiration — see the file doc comment. */
export type OpinionStatus = "landed" | "partial" | "new" | "deferred";

export type TsBaseOpinionId =
  | "naming/lexical-ladder"
  | "naming/element-singular"
  | "naming/reserved-double-underscore"
  | "types/explicit-signatures"
  | "types/domain-interfaces"
  | "types/schema-zod"
  | "types/tuple-destructure"
  | "invariants/preconditions"
  | "effects/async-plane"
  | "effects/parallel-map"
  | "control/cond-ternary"
  | "control/self-tail-loop"
  | "stdlib/arity-bridge"
  | "layout/module-map"
  | "layout/deps-pinned"
  | "format/eslint-prettier"
  | "comments/carry-and-two-synthetics"
  | "infer/cache-key-elide"
  | "infer/scalar-fold"
  | "shake/dead-defines";

/** The runtime axis (§2.2/§2.3) — one closed set of ids, filled twice (once per
 *  `Strategy.id`) in `RUNTIME_OPINIONS`. `rt/agentic-loop` is the doc's own
 *  headline example of why the ids stay shared: same source concept, structurally
 *  different shapes per runtime — the asymmetry IS the point of the axis. */
export type RuntimeOpinionId =
  | "rt/client-module"
  | "rt/plain-infer"
  | "rt/chat-messages"
  | "rt/structured-output"
  | "rt/agentic-loop"
  | "rt/mcp-tools";

export type OpinionId = TsBaseOpinionId | RuntimeOpinionId;

export interface Opinion {
  readonly id: OpinionId;
  /** Opinion-level version — bumped when THIS opinion's decision changes (finer
   *  grain than `Strategy.version`, which bumps on ANY opinion change in the
   *  record it belongs to). */
  readonly version: number;
  readonly axis: OpinionAxis;
  /** The decision, in prose — verbatim in spirit from the design doc's "Decision"
   *  column, so the registry and the doc never drift apart in meaning. */
  readonly description: string;
  /** A short, informal sketch of what this opinion RESOLVES TO when applied — not
   *  an enforced type, just enough for a reader (or a future emitter) to know the
   *  shape without opening the doc. */
  readonly valueShape: string;
  readonly status: OpinionStatus;
  /** Free-form seam/ruling callouts that don't fit `description` cleanly — e.g. the
   *  types-origin ruling on `types/domain-interfaces` / `types/schema-zod`. */
  readonly notes?: string;
}

// ── ts-base — shared opinions (both runtime strategies) ─────────────────────
// Order matches the design doc's §2.1 table — `Strategy.opinions` preserves this
// order (ts-base ids first, then the runtime's own `rt/*` ids), so `strategyHash`
// is stable across runs by construction, not by an extra sort step.

export const TS_BASE_OPINIONS: readonly Opinion[] = [
  {
    id: "naming/lexical-ladder",
    version: 1,
    axis: "spelling",
    description:
      "scheme name → TS name via cleanName + the nameCandidates ladder, resolved globally by " +
      "@here.build/lexical-namer over the scope tree; predicates yield contested bare names to " +
      "plain bindings (isPicked).",
    valueShape: "string (the emitted identifier)",
    status: "landed",
    notes: "names.ts, scheme-scope.ts",
  },
  {
    id: "naming/element-singular",
    version: 1,
    axis: "spelling",
    description:
      "a lambda param over a plural collection is named by pluralize.singular " +
      "(examples.map((example) => …)); `acc` reserved for reduce.",
    valueShape: "string (the emitted param name)",
    status: "landed",
    notes: "names.ts::elementName",
  },
  {
    id: "naming/reserved-double-underscore",
    version: 1,
    axis: "spelling",
    description:
      "`__` prefix reserved for emitted-runtime glue; source identifiers starting `__` are a " +
      "compile error; no `__x` fallback survives in the OCD register — every synthesized name " +
      "has a named source (element, ordinal, role).",
    valueShape: "string (a named-source identifier) | thrown door",
    status: "landed",
    notes:
      "W3: lower.ts::emitName doors `__`-prefixed source identifiers (run-view); the stdlib " +
      "fallbacks are named by role now (`item` for a map/max-by element, `value` for a reduce " +
      "operand) — no `__x`/`__b` survives in output",
  },
  {
    id: "types/explicit-signatures",
    version: 1,
    axis: "spelling",
    description:
      "every top-level function gets explicit parameter types and return type; `unknown` is " +
      "legal, `any` is not — ever.",
    valueShape: "TS parameter/return type annotations",
    status: "landed",
    notes:
      "W3 (R2): type-infer.ts (conservative direct-flow solver) + lower.ts::lowerDefine/" +
      "lowerLambda; fallback is honest `unknown`, never `any`; inner lambdas annotate only " +
      "what the solver knows (contextual typing covers the rest)",
  },
  {
    id: "types/domain-interfaces",
    version: 1,
    axis: "entropy",
    description:
      "a (dict …) shape that crosses ≥2 function boundaries materializes as a named `interface` " +
      "(name derived from the flow: candidate → Candidate); single-use shapes stay structural " +
      "inline.",
    valueShape: "named `interface` declaration | inline structural type",
    status: "landed",
    notes:
      "the types-origin seam: emitted TYPES derive from declared contracts (V's ruling, recorded " +
      "in the design doc's rulings section). W3: type-infer.ts's shape census — a shape in ≥2 " +
      "top-level signatures is named by its most frequent carrier param (candidate → Candidate)",
  },
  {
    id: "types/schema-zod",
    version: 1,
    axis: "entropy",
    description:
      "an s/* schema tag (s/object, s/enum, …) materializes as a named zod schema + z.infer type " +
      "alias, once per shape, shared by the infer call and the domain type.",
    valueShape: "`export const XSchema = z...; export type X = z.infer<typeof XSchema>;`",
    status: "landed",
    notes:
      "§5 — shares the types-origin seam with types/domain-interfaces. W3: type-infer.ts::" +
      "tagToZod (closed s/* vocabulary, doors on anything else); the schema constant feeds both " +
      "the infer call (lower.ts::lowerInferCall) and the function's return type; field keys keep " +
      "SOURCE spelling (the schema names the wire)",
  },
  {
    id: "types/tuple-destructure",
    version: 1,
    axis: "spelling",
    description: "a param consumed only as p[0]/p[1] destructures positionally " + "(([first, second]) => …).",
    valueShape: "array-destructuring parameter pattern",
    status: "landed",
    notes: "names.ts::destructureTuple",
  },
  {
    id: "invariants/preconditions",
    version: 1,
    axis: "entropy",
    description:
      "source semantics that imply a precondition (e.g. max-by on a possibly-empty list, apply " +
      'arity) emit invariant(cond, "message naming the source form") via runtime/invariant.ts.',
    valueShape: "`invariant(cond, msg)` statement",
    status: "landed",
    notes:
      "W3 (R3): type-infer.ts::entryPreconditions (max-by / seedless apply over a parameter, " +
      "direct flow only) + lower.ts::lowerDefine emission; the 5-line `invariant` declaration is " +
      "inlined per module (assemble.ts) until layout/module-map's runtime/ grouping lands",
  },
  {
    id: "effects/async-plane",
    version: 1,
    axis: "entropy",
    description:
      "JS async-ness is a target-materialization fact, not a source concept (frame doc seam 9): " +
      "the taint fixpoint over the define graph decides which functions are async; over-await on " +
      "fn-valued params is the accepted safe over-approximation.",
    valueShape: "`async` keyword placement + `await` call-site decisions",
    status: "landed",
    notes:
      "async-analysis.ts. W3 extended the async roots from `.prompt` requires to the infer-verb " +
      "table (INFER_VERB_ROOTS: infer, infer/chat, infer/agentic/end-to-end — the verbs " +
      "infer/scalar-fold awaits). mcp/call + mcp/list join in W4 with their awaited lowering — " +
      "a root without an awaited emission would leak a bare Promise.",
  },
  {
    id: "effects/parallel-map",
    version: 1,
    axis: "entropy",
    description:
      "(map async-f xs) → await Promise.all(xs.map(async-f)) — the source's implicit " +
      "parallelism made explicit; async filter/every/some remain a loud door.",
    valueShape: "`await Promise.all(...)` call expression",
    status: "landed",
    notes: "stdlib.ts::mapLike",
  },
  {
    id: "control/cond-ternary",
    version: 1,
    axis: "spelling",
    description: "cond/if chains stay expressions (chained ternary), never statement rewrites.",
    valueShape: "chained `? :` expression",
    status: "landed",
    notes: "desugar.ts, lower.ts",
  },
  {
    id: "control/self-tail-loop",
    version: 1,
    axis: "entropy",
    description:
      "a named let whose recursive calls are ALL tail calls lowers to a while loop (unbounded " +
      "iteration without stack growth); any non-tail recursive call falls back to the current " +
      "`const loop = (…) => …` arrow (stack-bound, declared).",
    valueShape: "`while (...) { ... }` | `const loop = (...) => ...;` (fallback)",
    status: "landed",
    notes:
      "resolves the seam-8 TCO obligation. W3: lower.ts::selfTailOnly (conservative — any value " +
      "use, capture, or rebinding falls back) + the while emission with a fold marker (R4); " +
      "loop state is `let`-declared with inferred annotations",
  },
  {
    id: "stdlib/arity-bridge",
    version: 1,
    axis: "entropy",
    description:
      "variadic/multi-list scheme builtins → index-driven traverse " +
      "(xs.map((x, i) => f(x, ys[i]))), apply + → reduce; accessor family (c[ad]+r) via the " +
      "shared decodeAccessor decomposition.",
    valueShape: "index-driven `.map`/`.reduce` call | member-access chain",
    status: "landed",
    notes: "stdlib.ts",
  },
  {
    id: "layout/module-map",
    version: 1,
    axis: "spelling",
    description:
      "deterministic emitted layout: main.ts (entry, never imported), one module per spilled " +
      ".scm (stem preserved), prompts/<stem>.ts, runtime/llm.ts + runtime/invariant.ts, types.ts " +
      "only for interfaces shared by ≥2 modules; imports ordered node-builtins → deps → " +
      "runtime/ → local; explicit export lists.",
    valueShape: "file path + import-order convention",
    status: "partial",
    notes:
      "compile-project.ts has a flat layout today (main.ts + <stem>.ts + prompt modules); the " +
      "prompts/ / runtime/ grouping and import ordering are new (W3+).",
  },
  {
    id: "layout/deps-pinned",
    version: 1,
    axis: "spelling",
    description:
      "emitted package.json pins registry-verified versions (the existing DEP_VERSIONS table " +
      "pattern; .claude/rules/npm-version-pinning.md applies — every version resolved via `npm " +
      "view` at implementation time, never typed from memory).",
    valueShape: "`package.json` dependency version strings",
    status: "landed",
    notes: "compile-project.ts::DEP_VERSIONS",
  },
  {
    id: "format/eslint-prettier",
    version: 1,
    axis: "spelling",
    description:
      "naive-correct emit, then in-process eslint --fix (object-shorthand, arrow-body-style, " +
      "prefer-const, no-useless-rename) + prettier; ruleset is part of the strategy version — a " +
      "rule change bumps version.",
    valueShape: "formatted TS source string",
    status: "landed",
    notes: "format.ts — parser already retargeted babel → typescript in W0",
  },
  {
    id: "comments/carry-and-two-synthetics",
    version: 1,
    axis: "spelling",
    description:
      "source ;; comments carried as //; exactly two synthetic forms allowed: the per-file " +
      "provenance header and the fold marker (R4); no other compiler chatter.",
    valueShape: "`// ...` line(s)",
    status: "partial",
    notes:
      "lower.ts::leadComments carries source comments; W3 added the fold marker (emitted on the " +
      "self-tail-loop rewrite); the per-file provenance header is still to land.",
  },
  {
    id: "infer/cache-key-elide",
    version: 1,
    axis: "entropy",
    description:
      "the source's content-derived cacheKey argument is the interpreter's provenance economy " +
      "(content-addressed replay); the compiled artifact elides it — caching in a standalone " +
      "artifact is deferred (artifact-only tier, seam 4). The elision is named, here.",
    valueShape: "(absence of a cacheKey argument in the emitted call)",
    status: "landed",
    notes: "de facto today (lower.ts run-view: the inputs object only) — now enumerated by name",
  },
  {
    id: "infer/scalar-fold",
    version: 1,
    axis: "entropy",
    description:
      "(car (infer …)) / (car (infer/chat …)) / (car (infer/agentic/end-to-end …)) folds to the " +
      "bare awaited value — the list wrapper is interpreter plumbing (the verb 'wraps it to a " +
      "list for scheme'), not a source concept. A non-car'd infer result materializes faithfully " +
      "as [value].",
    valueShape: "bare awaited expression | `[value]` array literal",
    status: "landed",
    notes:
      "W3: lower.ts::lowerInferCall — `(car (infer …))` → `await infer(…)`, non-car'd → " +
      "`[await infer(…)]`; cacheKey elided at the same slot (infer/cache-key-elide). The verbs " +
      "stay bare identifiers until W4's rt/* runtime modules bind them",
  },
  {
    id: "shake/dead-defines",
    version: 1,
    axis: "entropy",
    description:
      "top-level defines unreachable from the entry expression + export set are not emitted " +
      "(matching here.build's liveness-gating).",
    valueShape: "(absence of unreachable `const`/`function` declarations)",
    status: "deferred",
    notes: "scheduled after the W2 conformance/agreement gate lands — not before",
  },
];

// ── runtime-specific opinions — same ids, one fill per Strategy.id ──────────
// §2.2 (ts-vercel-ai) and §2.3 (ts-langchain). All `status: "new"` — the registry
// names the decision; the (infer …) verb-family lowering that would REALIZE it is
// W4 (ts-vercel-ai) / W5 (ts-langchain), never this wave.

export const RUNTIME_OPINIONS: Record<"ts-vercel-ai" | "ts-langchain", readonly Opinion[]> = {
  "ts-vercel-ai": [
    {
      id: "rt/client-module",
      version: 1,
      axis: "spelling",
      description:
        'runtime/llm.ts exports a `models` registry: source model alias ("fast", ' +
        "config/model values) → a provider model instance built from createOpenAICompatible / " +
        "@ai-sdk/* with OPENAI_BASE_URL/OPENAI_API_KEY env-driven config (successor of today's " +
        "_ai.ts/_llm.ts clients).",
      valueShape: "`runtime/llm.ts` module exporting a `models` object",
      status: "landed",
      notes:
        "W4: rt-vercel-ai.ts::vercelRuntimeLlmModule — ONE createOpenAICompatible passthrough " +
        "provider, aliases resolved lazily behind a Proxy so both models.fast (a literal alias) " +
        "and models[configModel] (a computed one) work against the same registry; compile-" +
        "project.ts's vercel-ai PromptBackend.client() emits it at runtime/llm.ts",
    },
    {
      id: "rt/plain-infer",
      version: 1,
      axis: "spelling",
      description: "(infer model prompt) → generateText({ model, prompt }), result .text.",
      valueShape: "`const { text } = await generateText({ model, prompt });`",
      status: "landed",
      notes: "W4: rt-vercel-ai.ts::lowerVercelInferCall, dispatched from lower.ts::lowerInferCall",
    },
    {
      id: "rt/chat-messages",
      version: 1,
      axis: "spelling",
      description:
        "(infer/chat model msgs) → generateText({ model, messages }); the " +
        "(infer/chat/system|user|assistant …) tuple constructors lower to typed message " +
        'literals `{ role: "system", content } satisfies ModelMessage` — the tuple encoding is ' +
        "interpreter wire format, the object encoding is the framework's.",
      valueShape: "`{ role, content } satisfies ModelMessage` object literal",
      status: "landed",
      notes:
        "W4: rt-vercel-ai.ts::lowerVercelInferCall (the messages key) + ::lowerVercelMessageTuple " +
        "(the tuple constructors), dispatched from lower.ts::lowerList",
    },
    {
      id: "rt/structured-output",
      version: 1,
      axis: "entropy",
      description:
        "schema-carrying infer → generateObject({ model, prompt, schema: <zod> }), result " +
        ".object, typed by the shared z.infer alias from types/schema-zod.",
      valueShape: "`const { object } = await generateObject({ model, prompt, schema });`",
      status: "landed",
      notes:
        "W4: rt-vercel-ai.ts::lowerVercelInferCall — the schema argument rides types/schema-zod's " +
        "named const as-is",
    },
    {
      id: "rt/agentic-loop",
      version: 1,
      axis: "spelling",
      description:
        "(infer/agentic/end-to-end model msgs servers) → ONE generateText call with tools + " +
        "stopWhen: stepCountIs(N) — vercel/ai's loop is declarative, a single call.",
      valueShape: "single `generateText({ ..., tools, stopWhen })` call",
      status: "new",
      notes:
        "W4 lands the emitter ARM (rt-vercel-ai.ts::lowerVercelInferCall's infer/agentic/end-to-end " +
        'branch exists) but it\'s a thrown, documented door, not a lowering — `(mcp "name")` server ' +
        "entities have no first-class source-vocabulary lowering anywhere in this package yet (no " +
        "STDLIB entry, no dedicated async-analysis handling), so this stays `new` honestly; no " +
        "corpus row exercises it (design doc's own instruction: don't fabricate one)",
    },
    {
      id: "rt/mcp-tools",
      version: 1,
      axis: "spelling",
      description:
        '(mcp "name") server entities → a per-server MCP client in runtime/mcp.ts; tools = merged ' +
        "await client.tools() maps, first-server-wins on name collision (matching resolveTools " +
        "semantics in llm-plane-arrival-env/src/mcp.ts).",
      valueShape: "`runtime/mcp.ts` module + merged tools map",
      status: "new",
      notes:
        "W4 registry correction (npm-version-pinning's API-surface clause): the design doc's draft " +
        "`experimental_createMCPClient` no longer exists in ai@6 — MCP client support moved to the " +
        "separate @ai-sdk/mcp package as `createMCPClient` (verified against @ai-sdk/mcp@2.0.10's " +
        'own docs). Not landed this wave — see rt/agentic-loop\'s note; (mcp "name") has no source-' +
        "vocabulary lowering to hang a transport off of yet.",
    },
  ],
  "ts-langchain": [
    {
      id: "rt/client-module",
      version: 1,
      axis: "spelling",
      description:
        "runtime/llm.ts exports models: alias → ChatOpenAI (or initChatModel) instances, same " +
        "env-var convention (successor of today's langchain-js _llm.ts).",
      valueShape: "`runtime/llm.ts` module exporting a `models` object",
      status: "landed",
      notes:
        "today's langchainJsClient() (prompt.ts, `.prompt`-plane only) is the pre-registry ancestor of " +
        "this opinion, still separate. W5: rt-langchain.ts::langchainRuntimeLlmModule() emits " +
        'runtime/llm.ts — a lazily-memoized Proxy registry (models.fast, models["echo-model"], ' +
        "models[expr] all resolve identically); wired at lower.ts::lowerInferCall's ts-langchain " +
        "branch, imported by assemble.ts exactly when referenced (usedLangchainRuntime().models).",
    },
    {
      id: "rt/plain-infer",
      version: 1,
      axis: "spelling",
      description: "(infer model prompt) → models.<m>.invoke(prompt), result text coerced via .text.",
      valueShape: "`const response = await models.m.invoke(prompt); response.text`",
      status: "landed",
      notes:
        "W5: rt-langchain.ts::plainInfer emits the single-EXPRESSION form " +
        "`(await models.m.invoke(prompt)).text` — a BARE string, not `[new HumanMessage(prompt)]` " +
        "(a verified correction against the design doc's illustrative §5 Shape A prose: " +
        "ChatOpenAI#invoke's real input type accepts a bare string per @langchain/core's own " +
        "BaseLanguageModelInput, and keeps the wire-level infer-vs-infer/chat distinction the " +
        "interpreter's oracle carries — see rt-langchain.ts::plainInfer's doc for the full reasoning) " +
        "— embeddable anywhere a scheme expression can appear, per infer/scalar-fold's existing " +
        "contract, dispatched from lower.ts::lowerInferCall's ts-langchain branch (symmetric to " +
        "ts-vercel-ai's own W4 branch).",
    },
    {
      id: "rt/chat-messages",
      version: 1,
      axis: "spelling",
      description:
        "tuple constructors → new SystemMessage(…) / new HumanMessage(…) / new AIMessage(…); " +
        ".prompt templates keep the ChatPromptTemplate.fromMessages + pre-rendered " +
        "{{#each}}/{{#if}} pipeline (today's compileLangchainJs, carried).",
      valueShape: "`new SystemMessage(...)` / `new HumanMessage(...)` / `new AIMessage(...)`",
      status: "landed",
      notes:
        "the .prompt template pipeline (compileLangchainJs, prompt.ts) is landed; the tuple-constructor " +
        "lowering for in-.scm chat messages is W5: rt-langchain.ts::chatMessageCtor / chatMessages " +
        "implement both halves (message-constructor verbs → class instantiation; the invoke(messages)." +
        "text call), dispatched from lower.ts::lowerList's message-tuple slot AND lowerInferCall.",
    },
    {
      id: "rt/structured-output",
      version: 1,
      axis: "entropy",
      description:
        "schema-carrying infer → models.<m>.withStructuredOutput(<zod>), invoked; same shared " + "zod schema.",
      valueShape: "`models.m.withStructuredOutput(Schema).invoke(prompt)`",
      status: "landed",
      notes:
        "W5: rt-langchain.ts::structuredOutput implements this exactly, generalized over both infer " +
        "and infer/chat's input shape (prompt string vs messages array); the response IS the parsed " +
        "value directly (no `.object` unwrap, unlike vercel-ai's generateObject — verified against " +
        "@langchain/core@^1.1.48's public surface, not assumed).",
    },
    {
      id: "rt/agentic-loop",
      version: 1,
      axis: "spelling",
      description:
        "(infer/agentic/end-to-end …) → createReactAgent({ llm, tools }) (LangGraph prebuilt) + " +
        "agent.invoke({ messages }) — langchain's loop is a graph object, structurally unlike " +
        "vercel/ai's single call. This asymmetry is the point of the axis: same concept, two " +
        "shapes, both named.",
      valueShape: "`createReactAgent({ llm, tools })` + `agent.invoke({ messages })`",
      status: "new",
      notes:
        'a documented door (R6), matching ts-vercel-ai\'s own W4 ruling: `(mcp "name")` server ' +
        "entities have no first-class source-vocabulary lowering ANYWHERE in this package today — no " +
        "STDLIB entry, no async-analysis handling beyond the bare verb name. rt-langchain.ts::" +
        "agenticLoop + messageTextHelper implement the SHAPE this opinion would emit as a single " +
        "expression (`messageText((await createReactAgent(...).invoke(...)).messages.at(-1))`, an " +
        "Array.prototype.at() undefined-guard via a NAMED invariant, not `!`/`any`) and are standalone-" +
        "verified (__tests__/conformance/strict-emit-langchain.test.ts), but lowerLangchainInferCall " +
        "throws for infer/agentic/end-to-end rather than calling them — unreachable from stage 1's " +
        "source vocabulary, so no shape is fabricated against a call site that can't reach it.",
    },
    {
      id: "rt/mcp-tools",
      version: 1,
      axis: "spelling",
      description:
        '(mcp "name") entities → MultiServerMCPClient (@langchain/mcp-adapters) configured per ' +
        "server; tools = await client.getTools().",
      valueShape: "`MultiServerMCPClient` instance + `await client.getTools()`",
      status: "new",
      notes:
        "same door as rt/agentic-loop, same ruling as ts-vercel-ai's own rt/mcp-tools. rt-langchain.ts::" +
        'mcpClientModule emits the runtime/mcp.ts shape given a program-wide census of (mcp "name") ' +
        "server names — that census (which module walks the whole program to collect them) is an " +
        "assembly-level concern this file doesn't perform, and is moot until (mcp …) has real source-" +
        "vocabulary lowering; transport config per server is not yet modeled either (mercury's (mcp " +
        '"name") entity carries none today) — declared honestly, matching §2.4\'s unsupported-tiers ' +
        "posture, not silently guessed.",
    },
  ],
};
