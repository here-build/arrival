# Grounded intent-chain evals — landscape, taxonomy, gaps, and a design for ours

**Status**: research synthesis · 2026-06-19
**Goal (V)**: map the landscape of grounded multi-step intent-chain benchmarks — device-leaning — with the
lens on **methodology** (how grounding, chain structure, and *verification* are done), so we can **design
our own** eval for the constrained-decoding-of-Scheme-tool-calls sampler.

**Provenance + confidence**: a deep-research fan-out (11 primary/secondary sources, 53 claims extracted).
The harness's adversarial-verification phase hit an Anthropic-side rate limit and abstained on every vote,
so its "25 killed" is an **infrastructure artifact, not refutation**. Two load-bearing claims were then
**directly re-fetched and confirmed** (ToolSandbox `arxiv:2408.04682`, FuncBenchGen `arxiv:2509.26553`).
The well-established benchmarks (ToolSandbox, BFCL, SGD, NESTFUL, ComplexFuncBench, AppWorld, τ-bench) are
high-confidence; the June-2026 device papers (HomeFlow `2606.01230`, DevCmd `2606.01099`) are recent and
medium-confidence (extracted, not re-fetched).

## (a) Comparison table

| Benchmark | Grounding | Chain structure | Verification (★ axis) | Turn | Ours-relevance |
|---|---|---|---|---|---|
| **ToolSandbox** (Apple, 2408.04682) | stateful exec + **implicit inter-tool state deps**; built-in **LLM user simulator** | multi-turn; state-dependency, canonicalization, insufficient-info | **milestone** (intermediate+final over an *arbitrary* trajectory) — path-agnostic | multi-turn conv. | ★★★★★ our closest analog (device, stateful, user-sim) |
| **τ-bench / τ²-bench** | stateful DB + API sim (retail/airline); LLM user sim | multi-turn, policy-constrained | **final DB-state match** + reward; **pass^k** reliability | multi-turn + user sim | ★★★★★ state-verify + we already use pass^k |
| **AppWorld** | executable sandbox (~9 apps, ~457 APIs), DB-backed world | multi-step, cross-app, data deps | **unit-test-style state assertions** (programmatic checks on final DB) | multi-turn | ★★★★ sandbox + state-assert gold standard |
| **FuncBenchGen** (2509.26553) | **synthetic** type-compatible variable deps; hidden **dependency DAG** | DAG traversal; controllable depth/size/distractors | **final computed value** | single-turn multi-step | ★★★★★ the *syntax-valid-but-stale-value* insight = our exact rationale |
| **NESTFUL** (IBM, 2409.03797) | executable nested API sequences | **nested: output-feeds-input** data deps | execution / value | single-turn nested | ★★★★ purest "data-dependency chain" |
| **HomeFlow** (2606.01230) | stateful sandbox **HomeEnv**, partial observability, device states | multi-step smart-home | **state-based assertion** (boolean predicates over env state); terminal reward = cumulative conditions | — | ★★★★ device state-assert + authoring pipeline |
| **ComplexFuncBench** (zai-org) | **REAL** Booking.com API (RapidAPI) | multi-step dep chains, implicit param reasoning, 128k ctx | **ComplexEval**: call-accuracy + completeness + correctness | single-turn multi-step | ★★★ real-API grounding (flaky) |
| **BFCL v3** | multi-turn state backend | multi-turn/parallel/multiple | **AST structural isomorphism** + executable | multi-turn | ★★★ we already use BFCL-AST; AST is *vacuous* under our constraint |
| **ToolHop** (2501.02506) | locally executable (code-gen-backed); 995 q / 3912 tools | query-driven **multi-hop** | verifiable final answer | multi-hop | ★★★ construction-from-queries method |
| **Auto-SLURP** (2504.18373) | **hybrid** sim servers + real APIs (search/weather/news) | device-intent multi-step | **end-to-end execution success** (weak) | — | ★★★ device, hybrid grounding |
| **SGD** (Google, 1909.05855) | schema-guided; **no execution** | multi-turn slot/intent carryover | slot/intent accuracy (state-tracking) | multi-turn | ★★★ **schema-at-inference ≈ our palette grant env** |
| **DevCmd** (2606.01099) | state-based slot match, no sandbox | **single-turn** cmd→action | device-action-value triplet match | single-turn | ★★ names the multi-step gap as its own limitation |
| **MultiWOZ** | DB-backed, multi-domain | multi-turn slot carryover | joint goal accuracy (JGA) | multi-turn | ★★ classic TOD baseline |

## (b) Two taxonomies

**Grounding (how "real" is the state):**
1. **Real API** — ComplexFuncBench. Maximally real, least reproducible/controllable (flaky, rate-limited).
2. **Executable sandbox / DB-backed world-state** — AppWorld, τ-bench, HomeFlow, ToolHop, NESTFUL. The
   mainstream: reproducible *and* stateful. **The right tier for us.**
3. **Hybrid sim + real** — Auto-SLURP (sim device, real info-APIs).
4. **Synthetic dependency graph** — FuncBenchGen. Fully controllable, contamination-free, but abstract
   (not "real" intents).
5. **Schema/slot ground-truth, no execution** — SGD, MultiWOZ, DevCmd, BFCL-AST. Cheapest; blind to
   execution/semantic effects.

**Verification (how a chain is judged) — the most important axis:**
- **A. Final world-state assertion** (boolean predicates over end state) — AppWorld, τ-bench, HomeFlow.
  Robust to alternate valid paths; the gold standard for "did the intent actually happen."
- **B. Final computed-value match** — NESTFUL, ToolHop, FuncBenchGen. For data-dependency chains whose
  answer is a value.
- **C. Action-trace / API-call match** — partial in BFCL/ComplexFuncBench. Brittle to valid reorderings.
- **D. AST structural isomorphism** — BFCL. Syntax+structure only, **not semantics**.
- **E. Milestone / path-agnostic trajectory** (intermediate+final) — ToolSandbox. Handles multiple valid
  orderings — the most forgiving correctness model.
- **F. Execution-success** (did it run) — Auto-SLURP. Weak: success ≠ correct.
- **G. LLM-as-judge** — noisy; used as a component, not a sole gate.
- **H. Slot/intent accuracy (JGA)** — SGD/MultiWOZ. State-tracking, not action-effect.

## (c) Gaps — where our eval can contribute something genuinely new

1. **The constrained-decoding regime is unrepresented.** Every benchmark scores raw output where *syntax
   errors and unbound-tool hallucinations are part of the score*. None evaluate a model whose output is
   **syntax + bound-symbol guaranteed by construction**. Our sampler removes exactly those failure modes,
   so our eval can **isolate pure semantic/intent error** ("given the model *cannot* emit a malformed or
   unbound call, how often does it pick the *right* bound call + the *right* args?"). FuncBenchGen's
   confirmed finding — *syntactically valid calls with stale/wrong argument values, invisible to
   syntax-only checks* — is the field's closest acknowledgment that semantics is the real axis, but it
   doesn't constrain generation. We do. **This is the white space.**
2. **AST verification is vacuous for us.** BFCL-style structural/AST checks (which we currently lean on
   per `[[reference]]` BFCL-AST) measure something the oracle already guarantees. Under constrained
   decoding, AST match ≈ always-pass — so it must be **replaced** by state/value verification.
3. **Naming-surface sensitivity over a fixed action set is unmeasured anywhere.** No benchmark varies the
   tool *naming* (our palettes: dei/die/bdei…) over the *same* actions to measure naming's effect on
   correctness. We already have this axis and the D1 numbers (bdei 0.843 vs die 0.571).
4. **Sub-1B / on-device intent chains** are under-served (most target frontier models). Our quant-floor
   work (360M@q4) lives here.
5. **Dual trace+state verification** is rare (benchmarks pick one). A constrained decoder records the
   action-trace *for free* (ExplainProcessor / the sim's recording rosettas), so we can cheaply assert
   **both** the trace *and* the final sim-state.

## (d) Recommendations — designing our grounded device-intent-chain eval

1. **Grounding = executable sim with MUTABLE DB-backed world-state.** Not real APIs (flaky), not pure
   synthetic DAG (not real intents). We already have `makeDeviceSim` — but it's a *recording* rosetta
   (records calls, returns canned values). **The single biggest build: make it stateful** — timers set,
   messages sent, calendar entries, brightness — so a later step can read back an earlier step's effect.
   This converts the device sim from trace-only to AppWorld/τ-bench/HomeFlow-class world-state.
2. **Chain structure = data-dependency + state-carryover.** Author chains where step N consumes step
   N−1's output or the sim state: "what's my next meeting? → text Alice it's at that time" (query→act),
   "find a free 30-min slot → book it" (search→mutate). Borrow FuncBenchGen's **controllable difficulty
   knobs** (dependency depth, distractor-tool count) but over *real device intents*.
3. **Verification = STATE-primary + TRACE-secondary, NOT AST.**
   - **Primary: final sim world-state assertion** (τ-bench/HomeFlow model) — assert the *effects*
     (timer == 600s, a message to "Alice" exists, the event is on the calendar). Path-agnostic.
   - **Secondary: action-trace check** (which tools, which args, order where ordered) — free, since the
     sim already records it; use **milestone/path-agnostic** matching (ToolSandbox) so valid reorderings
     pass.
   - **Explicitly target the semantic axis** with FuncBenchGen's stale-value probe: chains where a naive
     model would reuse a wrong/old value — the constraint can't catch it; only state/value assertion can.
     This is where the eval earns its keep over the always-valid syntax.
4. **Authoring = blueprints** (HomeFlow's pattern): compile open device intents → executable state
   success-conditions, then triple-filter (sim-executable, schema-valid, logically-consistent). We get
   the **schema-validity filter for free from the oracle**.
5. **Keep naming-scheme (palettes) as a first-class dimension.** Measure correctness × naming-scheme ×
   chain-depth. Reuse the `measurement-trust` Gage-R&R harness + `palettes` we already built.
6. **Reliability via pass^k** (τ-bench, and already ours) under τ>0 sampling over the feasible set.

### The 3–5 most adoptable, and what to steal

1. **ToolSandbox (Apple)** — closest analog. Steal: **milestone (path-agnostic) verification**, the
   **state-dependency / canonicalization / insufficient-info** task taxonomy, and the **LLM user
   simulator** for multi-turn.
2. **τ-bench / τ²-bench** — cleanest **state-assertion + user-sim + pass^k**. Steal the DB-state-diff
   verification and the policy-constrained user simulation.
3. **FuncBenchGen** — the **rationale + the stale-value semantic probe** and controllable-DAG difficulty.
   It is the academic statement of *why* our eval (semantics over guaranteed syntax) is the right one.
4. **AppWorld** — executable-sandbox + **unit-test-style state assertions**. The model for our stateful
   `makeDeviceSim` upgrade.
5. **HomeFlow** — device-domain **blueprint→state-condition authoring** + triple-filter. The closest
   methodology for compiling open device intents into checkable success conditions.

**One-line thesis**: every existing eval scores syntax *and* semantics tangled together; our sampler
guarantees the syntax, so we should build the **first eval that scores grounded device-intent semantics in
isolation** — stateful sim + state/trace assertion (not AST) + the naming-scheme axis we already own.

## Caveat / follow-up

Re-run the verification pass when the API isn't rate-limited to confirm the medium-confidence June-2026
device papers (HomeFlow, DevCmd) and the BFCL-v3 "static/offline" claim (BFCL v3 multi-turn does carry a
state backend — the secondary source may be imprecise). The high-confidence cluster + the two re-fetched
anchors are enough to act on the design above.
