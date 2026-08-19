# Failure-Mode / Naming Analysis — grammar mode over honest random-180

> **CORRECTION BANNER (2026-06-21) — four stale claims; body analysis still valid:**
>
> **(a) Headline metric is superseded.** The "12.1pp format-cost gap" (python 88.1 − grammar 76.1) that
> this doc is built around is no longer the win-condition. Success is now **models crossing their own
> python baseline** — a COUNT (target: 30–50% of a 6-model pool), not a gap-to-python.
> *(Corrected 2026-07-01: "crossing python" is not the bar either — the python `default` is itself a **lying
> baseline** (a python text-prompt, not native function-calling). The honest reference is native-FC same-quant
> or the within-scheme `pure` (unconstrained-scheme) arm; success = biggest positive constraint-delta + best
> validity, not a score-crossing count. See `docs/working-proposals/arrival-sampler-eval-design.md` §2, §5.)*
>
> **(b) Roster was cut to 6 `ready:true` candidates.** The 6-model win-condition contest is:
> Qwen2.5-1.5B, Qwen2.5-3B, Qwen2.5-7B, Arch-Agent-1.5B, Arch-Agent-3B, Rnj-1.
> Six of the 10 models in the tables below (Qwen-0.5B, Qwen3-0.6B, xLAM-2-1B, xLAM-2-3B, SmolLM2,
> plus the renderer-stubbed Falcon/Cohere) are now `ready:false` non-targets and excluded from the
> contest. Their rows still appear in the tables for historical reference.
>
> **(c) Order-leniency confound is refuted.** The ~10-record credit this doc gives to reorder-tolerance
> (class (a)) was tested this session: Δrelax = 0 — the constrained models do NOT permute args, so
> the class-(a) records are not actually recoverable by reorder. Class (a) remains a real failure
> category but the fix (positional-keyed) recovers zero records in practice.
>
> **(d) Primary win-lever is absent from this doc.** The type-derived list-structure gate (forcing
> `(list…)`/`'(…)` at ARRAY slots) is the new primary mechanism — not present in any table below.
>
> The body's value/format/boolean residual analysis (§1–§5) still holds as characterization of the
> failure taxonomy. Only the headline metric, roster, and the order-leniency credit are stale.

**Status:** COMPLETE (body analysis preserved; see correction banner above for reframes).
**Scope:** ANALYSIS ONLY. No renames are applied (overfitting guard). This bounds what a
presentation-layer schema⇄BFCL-name map *could* buy, and whether positional-keyed is worth
shipping — it does not change the benchmark or the emitted grammar.
**Model-free.** Reads the committed gen-log + schemas only.

## Inputs

- Gen-log: `inhuman/examples/intent-eval/__eval-output__/sweep-1781989582088-generations.jsonl`
  (random-180; **5 modes** × 10 models × 180 entries = 9000 records).
- Schemas + GT: `inhuman/examples/intent-eval/src/bfcl/data/bfcl_simple_random180.json` (180 entries).
- Classifier: `inhuman/examples/intent-eval/src/bfcl/__research__/failure-mode-classify.ts`
  (re-scores the gen-log with the real scorer; **rescore-mismatch = 0**, so the verdicts are faithful).
  Two over-count bugs in the prior pass were found and fixed here (see *Methodology note* below);
  the corrected class (a) was independently cross-validated against a from-scratch reimplementation
  (both land on **exactly 10 records**).

## Mode baselines (whole 1800-record arms)

| mode | surface | acc |
|---|---|---|
| **default** | python `fn(a=…, b=…)` | **88.1%** |
| **grammar** | scheme `(fn v1 v2)` positional | **76.1%** |
| grammar-kwargs | scheme `(fn v1 … :opt v)` (optionals keyed) | 74.2% |
| typed | scheme + typed-union prelude | 76.0% |
| unconstrained-scheme | free scheme (no grammar) | 68.4% |

`grammar` is the best *scheme* mode. **The headline is the format-cost gap: python 88.1% − grammar
76.1% = 12.1 points.** That 12.1-pt cliff is the thing this analysis is trying to attribute — is it
naming/ordering (fixable at the presentation layer) or model capability under the scheme surface
(not fixable by a name map)?

`grammar` fails **431 of 1800** records (76.1% pass). All percentages below are over those 431 failures.

---

## 1. The (a)/(b)/(c)/(d) histogram of grammar failures

| class | meaning | records | % of fails | distinct entries |
|---|---|---:|---:|---:|
| **(a)** | positional misplacement (right values, wrong slot — keying/reorder catches it) | **10** | **2.3%** | 7 |
| **(b)** | schema ambiguity (a clearer NAME / value-normalize disambiguates) | **13 – 35** | **3.0 – 8.1%** | 4 – 15 |
| **(c)** | capability (wrong value/intent; no name or order fix helps) | **~296** | **~69%** | ~103 |
| **(d)** | benchmark-wrong (GT demands a format the prompt never specified) | **~52** | **~12%** | 6 |
| — | unparsed / degenerate (no call, runaway brackets) — folded into (c) as capability | 19 | 4.4% | 17 |

(b) is a **range**, not a point, on purpose — see §2 for why. The honest reading is that **(c)
capability dominates at ~69%**, (d) benchmark-strictness is a real ~12% tax, and the genuinely
*nameable*/orderable surface — (a)+(b) — is **5–10% of failures at most**.

### Class (a) — all 10, verified by hand

Class (a) is *strictly* "right NAME, right VALUES, wrong ORDER": there exists an injective placement
of every emitted value into a named slot (required **or** optional) such that the whole call passes,
yet the strict-position bind fails. The defect is almost always an **optional param sitting between
two required ones** that the model either skipped or filled out of order.

| entry | fn | emitted (representative) | why it's reorderable |
|---|---|---|---|
| simple_python_311 ×3 | sports_db.find_athlete | `("Lebron James" "Basketball")` | schema is `name, team(opt), sport`; "Basketball" lands in the `team` slot. Reorder → name, sport, team-omitted. |
| simple_python_368 ×2 | calculate_cooking_time | `(1.5 180)` | `weight_kg, cooking_method(opt), temp_celsius(opt)`; 180 → cooking_method slot. Reorder → weight, temp, method-omitted. |
| simple_python_343 ×1 | game_stats.fetch_player_statistics | `("Zelda" "Switch" "Sam")` | username slot gets "Switch". Reorder → game, username=Sam, platform=Switch. |
| simple_python_372 ×1 | whole_foods.find_top_brands | `("bananas" #t)` | `product, number(opt int), organic(opt bool)`; #t → number slot. Reorder → product, organic, number-omitted. |
| simple_python_262 ×1 | modify_painting | `("oil" "12x18" "red")` | size/medium swapped (`size, medium, …`). |
| simple_python_28 ×1 | calculate_displacement | `(10 9.8 5)` | `initial_velocity, time, acceleration(opt)`; 9.8 → time slot. Reorder → vel, time=5, accel=9.8. |
| simple_python_218 ×1 | patient.get_mri_report | `(546382 concluded)` | `patient_id, mri_type(opt), status`; "concluded" → mri_type slot. Reorder → id, status, mri_type-omitted. |

Note `simple_python_311` is the single most destructive entry in the whole sweep — python 9/10,
**grammar 0/10**. Only 3 of its 10 failures are clean class (a); the other 7 fill the middle `team`
optional with garbage (`"all teams"`, `"Lakers"`, `#f`, `"None"`, `"no"`). Strict positional decode
*forces a decision about the middle optional* that python's keyword call sidesteps entirely — the
clearest single illustration of where keying could help (and where it mostly can't, because the
other 7 emit a wrong value, not a misordered one).

### Class (d) — benchmark-wrong (6 entries flagged; do NOT count as fixable)

These hard-fail the **python** arm too (≥70%), with no nested structure to blame — the ground truth
demands an encoding the prompt never stated:

| entry | fn | the dubious GT |
|---|---|---|
| simple_python_196 | air_quality | "2022/08/16" must be emitted as `08-16-2022` (US mm-dd-yyyy). python **0/10**, grammar 0/10. |
| simple_python_14 | calculate_derivative | "3x^2 + 2x - 1" must be exactly `3x**2 + 2x - 1` — rejects `3*x**2` (explicit multiply). python **1/10**. |
| simple_python_35 | vegan_restaurant.find_nearby | "opens until at least 11 PM" must be `23` (24h int). python fails too. |
| simple_python_279 | instrument_price.get | "Fender American Professional II Stratocaster" must include the full "…Stratocaster" model string. python **2/10**. |
| simple_python_323 | sports_ranking.get_top_player | "woman tennis" must split to sport=`tennis`, gender=`women` (rejects `woman`/`female`). |
| simple_python_61 | diabetes_prediction | "5ft 10in" must be `70` inches; model emits 510/68/65. (unit math — arguably (c), surfaced here as borderline.) |

`196` and `35` are the cases where a *name* like `date_mmddyyyy` / `operating_hours_24h` would be the
"right" fix — exactly the canonical `operating_hours → _24h` example — **but they fail python with
the schema name already present**, so a scheme-side name map cannot be credited with the lift. They
are benchmark arbitrariness, not a scheme deficiency.

---

## 2. Proposed naming / value-normalize RULES (presentation layer) + covered entries

Rules operate on the **schema⇄BFCL-name map used for scoring** (or a value-normalizer in that map) —
never on the benchmark. For each rule: how many grammar-fail records it would touch, and whether the
entry is **scheme-specific** (python passes it, so the lift is real) or **python-also-fails** (the GT
is the problem — the rule "works" but the entry is class (d), not a scheme win).

| rule | mechanism | records touched | scheme-specific? | verdict |
|---|---|---:|---|---|
| **R-order** (positional-keyed / reorder) | bind emitted values to slots by value-fit, not position | **10** (the class-(a) set) | yes (python passes all 7 entries) | **the only clean, defensible naming/order rule — targets class (a)** |
| **R-numfmt** percent↔fraction | `rate=3` ≡ `0.03` for a `*_rate` param | 5 (153, 129, 145) | yes | nameable in principle, but **python already gets these right with the same name** — the scheme misses are weak-model format-drops, so a name map adds nothing python doesn't already have |
| **R-caret** `^`↔`**` | normalize math-function strings | 10 (entry 13 only; entry 14 is class (d)) | yes (13: python 9/10) | real & scheme-specific: the **Lisp context induces `^`** where the same model writes `**` in python. A value-normalizer flips it. Borderline "naming" (it's value-format, not a param name). |
| **R-quote** strip leading `'` | `'hearts'` → `hearts` | ~3 (341, 366) | yes | a **parser** fix, not a name map — the reader kept a quote. Already addressable in the scorer. |
| **R-entity** trailing-qualifier / canonical | `banana`≡`bananas`, `Yellowstone`≡`Yellowstone National Park`, `Apple Inc`≡`Apple Inc.` | ~30 (372, 68, 212, 162, 242, 344, 318, 273, 77, 36, …) | **mixed** — 8 scheme-specific, the rest (279, 77) fail python too | risky: fuzzy/substring canonicalization over-matches and would mask real errors; several of these are class (d). **Not recommended as a hard rule.** |

**Covered-entry lists** (entry-level, the unit a presentation rule fixes for all models):

- **R-order:** `311, 368, 343, 372, 262, 28, 218` (7 entries / 10 records).
- **R-numfmt:** `153, 129, 145` (3 entries / 5 records).
- **R-caret:** `13` (1 entry / 10 records; `14` excluded → class (d)).
- **R-quote:** `341, 366` (2 entries / ~3 records).
- **R-entity (scheme-specific subset only):** `68, 212, 372, 162, 242, 344, 318` (the python-passing ones).

The **(b) range** in §1 comes from which of these you count as "naming":
- **Tight (b) ≈ 13 records / ~4 entries** = R-numfmt + R-caret(13) + R-quote. (Strict reading: only
  value-format normalization that's unambiguously scheme-specific.)
- **Liberal (b) ≈ 35 records / ~15 entries** = tight + R-entity scheme-specific subset. (Counts
  entity-canonicalization as a naming concern, accepting over-match risk.)

Everything the heuristic *also* flagged as a candidate but that is actually **capability** (excluded
from (b)): `45 phase_transition: boiling→vaporization` (wrong physics), `207 start_location:"New" /
end_location:"York"` (split "New York"), `175 name:"John" / law_type:"Doe"` (split "John Doe"), `283
location:"Excellent"` (slot-shift cascade), `200 fuel_type:25` (wrong slot), `217/246/276` (echoed
the param name / `"default"` placeholder), `352 platform:"GameSpot"` (confused store for platform),
and all the nested-list enum failures (`209, 71, 358, 193, 374, 190`).

---

## 3. Nameable-fixable ceiling

The ceiling = (a + b) as a fraction of the 431 failures, with (b) as a range:

| scenario | records | % of failures | max accuracy lift (over 1800) |
|---|---:|---:|---:|
| **(a) alone** (positional-keyed target) | 10 | **2.3%** | **+0.56 pts** |
| **(a) + tight (b)** | 23 | **5.3%** | **+1.28 pts** |
| **(a) + liberal (b)** | 45 | **10.4%** | **+2.50 pts** |

**So the nameable-fixable ceiling is ~5% of failures (defensible) to ~10% (generous).** Against the
12.1-pt format-cost gap, naming/ordering can close **at most ~1.3 pts (defensible) to ~2.5 pts
(generous)** — i.e. **roughly one tenth to one fifth of the gap, as an upper bound that assumes a
perfect, zero-regression name map.** The other ~80–90% of the 12.1-pt cliff is not addressable by
any presentation-layer name map.

---

## 4. Verdict on positional-keyed (targets class a)

**Positional-keyed should NOT be expected to help on net, and the existing data argues it hurts.**

Three grounds:

1. **The target is tiny.** Class (a) is 10/431 = 2.3% of failures = +0.56 pts *theoretical* ceiling
   if keying recovered every reorderable case with zero new failures.

2. **The closest empirical proxy already in the sweep went the wrong way.** `grammar-kwargs` (which
   keys the optionals — the same lever, partially applied) scores **74.2% vs grammar's 76.1%, a net
   −1.9 pts.** It helped only **3 of 10 models**, and SmolLM2-1.7B **collapsed −11.1 pts** under it.
   The variance is large and the central tendency is negative. (Full positional-keyed — keying
   *every* arg — is a defined mode (`bfcl-modes.ts` mode 6) but was **not run in this random-180
   sweep**; the 5 present modes are default/grammar/grammar-kwargs/typed/unconstrained-scheme.)

   | model | grammar | grammar-kwargs | Δ |
   |---|---:|---:|---:|
   | Arch-Agent-1.5B | 80.6% | 86.7% | **+6.1** |
   | Qwen2.5-7B | 88.9% | 93.9% | **+5.0** |
   | Qwen2.5-3B | 84.4% | 85.0% | +0.6 |
   | Arch-Agent-3B | 91.7% | 91.1% | −0.6 |
   | xLAM-2-1b | 77.8% | 76.7% | −1.1 |
   | Qwen2.5-0.5B | 58.3% | 55.0% | −3.3 |
   | Qwen2.5-1.5B | 79.4% | 76.1% | −3.3 |
   | xLAM-2-3b | 67.8% | 62.8% | −5.0 |
   | Qwen3-0.6B | 58.3% | 52.8% | −5.6 |
   | SmolLM2-1.7B | 73.3% | 62.2% | **−11.1** |

3. **The mechanism explains the sign.** Keying *adds tokens and a less-practiced surface*. The +0.56
   pts it could recover from reordering is dwarfed by the new failure modes keywords introduce
   (mis-spelled keyword, keyword/value desync, the runaway `<arg>` degenerations) — especially for
   the small/weak models that have the most class-(a) errors in the first place. The lift and the
   harm are *correlated on the same models*, so they cancel (or worse).

**Recommendation:** treat reorder-tolerance as a **scoring-layer leniency** (the `assignRequiredByValue`
order-relax that already exists, applied to positional grammar — recovers the 10 class-(a) records at
the scorer with *zero* change to what the model emits), **not** as an emission format the model must
produce. Do not ship positional-keyed as the default scheme surface on this evidence. If pursued,
gate it behind a per-model A/B (the roadmap's S0/S1) — it is plausibly net-positive for exactly two
models (Arch-Agent-1.5B, Qwen2.5-7B) and clearly negative for the small Qwen/SmolLM family.

---

## 5. Blunt note: the real gap is capability + format-cost, not naming

**~69% of grammar failures are class (c) capability and ~12% are class (d) benchmark-strictness.
Naming and keying cannot move the needle much — the nameable ceiling is ~5–10% of failures.** The
12.1-pt format-cost gap is overwhelmingly the model being *worse under the scheme surface*, not the
benchmark mis-reading scheme output.

Where the capability tax concentrates (the actionable signal, if anywhere):

- **Nested array/dict construction is the single biggest sink.** **33% of scheme-specific failures
  (86 records) are on entries with an `array`/`dict` param (38% — 163 records — of *all* grammar
  failures)** — and python sails through them
  (`compose_melody` python 10/10 → grammar 4/10; `mathematics.calculate_area_under_curve` 10/10 →
  4/10). The failures are `(list …)` malformation: `[array [array [list [list …` runaway, `[c "F"
  "G"]` brackets-instead-of-`(list`, `"C, F, G"` string-instead-of-list, a missing wrapper. **This
  is a grammar/decoding-surface problem for list literals, not naming.** If any single change could
  recover points, it is making list construction in the constrained grammar less error-prone (or
  scoring it more tolerantly), not renaming parameters.

- **Value-format drift induced by the Lisp context** (the `^`-vs-`**` story, entry 13: every model
  writes `x**2` in python and `x^2` in scheme) is real but rare (~1 entry of consequence).

- The `<think>…</think>` preamble and `(list …)` operator-wrapper failures (model drops the function
  name) are **emission-discipline** issues — prompt/grammar shaping, not naming.

**Bottom line:** a presentation-layer name/normalize map plus reorder-leniency at the scorer can
recover **at most ~1.3–2.5 pts** of the 12.1-pt gap, and most of *that* is the cheap, safe
reorder-leniency on 10 records. The remaining ~10 pts is model capability under the scheme surface —
dominated by **nested list construction** — which only a better emission grammar (or a bigger/
better-tuned model) moves. Positional-keyed specifically is a net-negative bet on this data.

---

## Methodology note — two bugs fixed in the classifier

The prior Phase-C pass reported class (a) = 51. That was inflated ~5× by two bugs in
`wouldPassUnderReorder` (now fixed; commit in this series):

1. **Optional-leak.** The counterfactual re-flagged the positional args as a kwargs call with
   `byName: {}` and let `assignRequiredByValue` run — but that only scores **required** params and
   *silently drops* any emitted value bound for an **optional** slot. So a call whose only defect was
   a wrong optional (e.g. `(concert.find_details "The Weeknd" "December" 2023)`, `year=2023 ∉
   ['',2022]`) reported as positional-misplacement: the `2023` just vanished and the two required
   matched. Replaced with a **full-call injective-placement search** that scores every emitted value
   into a named slot — a wrong optional can no longer hide. (51 → 11.)

2. **Missing name-match guard.** The placement search ignored the operator, so a bare `(list
   "rs6034464")` — the model dropping the function name and emitting just an arg-tuple as a `list` —
   counted as (a). Added a `call.name === fn.name` gate (class (a) is "right *name*, right values,
   wrong order"). (11 → 10.)

The corrected histogram reproduces the logged scores exactly (rescore-mismatch = 0) and the class-(a)
count was independently confirmed by a from-scratch reimplementation (both = 10). The decision tree
was also reworked so (d) fires on python-also-hardfails (≥70%) with no nested param (GT-strictness),
and (b) is gated to scheme-specific entries — the script's `b` output (≤54) is a **loose upper
bound**; §2 culls it to the 13–35 defensible records by hand, since most string-slot flags are
capability (split strings, wrong concepts, echoed param names), not naming.
