// args-misuse — RED suite for the localized args-misuse door (Phase 0 of
// docs/args-error-reporting-v2.md's landing strategy, second-foundation/arrival-manifold's
// design doc, §7.2). The door replaces the bare Signature + Example echo with a LOCALIZED
// teach — the failing parameter named, its sub-schema taught, a copy-paste-correct retry
// shape — escalating on repeated failure of the same (tool, param). See the design doc for
// the full mechanism (§2: `extractClues`/`localizeFailingParam`, `ArgsFailureTracker`,
// `synthesizeParamValue`) — none of it exists yet; this file is the in-tree coordination
// signal (§7.3 Phase 0), landing BEFORE the implementation (Phase 2).
//
// S1-S3 and S5 are `it.todo` (design doc §7.1: a row contracting a NEW export that doesn't
// exist yet would fail to COMPILE as `it.fails`, so it carries the full row spec in its
// title instead — the mechanical, no-red-gate discipline). S4 is `it.fails`: it exercises
// `synthesizeExampleCall`, which exists TODAY and stubs concrete values — a real regression
// this row documents until example-call.ts grows the type-placeholder-hole behavior.

import { describe, expect, it } from "vitest";

import { synthesizeExampleCall } from "../example-call.js";
import type { ToolJsonSchema } from "../tool-schema.js";

describe("args-misuse — localized door + escalation (docs/args-error-reporting-v2.md §7.2)", () => {
  // S1: extractClues — the 4-family clue-extraction table (§2.2), fixtured on the 45edee
  // trajectory's verbatim upstream error strings (design doc §1, §2.2's family table):
  //   - python-jsonschema value-mismatch: `'King Saud University' is not of type 'object'`
  //     → { kind: "value-mismatch", tokens: ["King Saud University"], expectedType: "object" }
  //   - python-jsonschema unexpected-keys: `Additional properties are not allowed ('terms' was
  //     unexpected)` → { kind: "unexpected-keys", tokens: ["terms"] }
  //   - python-jsonschema required-key: `'cond' is a required property` → { kind:
  //     "required-key", tokens: ["cond"] }
  //   - TS SDK / zod issues JSON: a `"path": ["query", …]` array inside the issues blob →
  //     { kind: "zod-path", tokens: ["query", …] } — authoritative, no walk needed.
  // `extractClues` doesn't exist yet (new export, doors.ts or a sibling args-misuse.ts, §3
  // hook #3) — a red test importing it wouldn't compile, hence `it.todo`.
  it.todo(
    "S1 — extractClues: the 4-family table (value-mismatch/unexpected-keys/required-key/zod-path) " +
      "over the 45edee verbatim fixtures — python-jsonschema \"'King Saud University' is not of type " +
      "'object'\", \"Additional properties are not allowed ('terms' was unexpected)\", \"'cond' is a " +
      'required property", and a TS-SDK zod issues[].path array',
  );

  // S2: localizeFailingParam soundness (T2 in the design doc's claim ledger) — NEVER names a
  // param absent from the tool's schema; an AMBIGUOUS clue (zero or several candidate paths
  // in the sent-args tree) resolves to `undefined`, falling back to today's Signature + Example
  // echo rather than guessing (the "never guess as fact" discipline, §2.2's resolution walk).
  // Fuzz row: random arg trees with a planted duplicate value across two sibling params must
  // resolve `undefined` for a value-mismatch clue (exactly-one-candidate is the only ⇒ case).
  it.todo(
    "S2 — localizeFailingParam: sound against the tool's schema (never names an absent param); a clue " +
      "with 0 or 2+ candidate paths in sent-args resolves undefined (falls back to Signature + Example, " +
      "never a guess) — fuzz over random arg trees with a planted cross-param value collision",
  );

  // S3: ArgsFailureTracker (§2.4) — L1→L2→L3 monotone escalation per (tool, param), capped at
  // 3; a SUCCESSFUL call of a tool clears ALL of that tool's param counters (the model has a
  // working shape now — the next failure starts a fresh L1 lesson); the unlocalized (⊥) key
  // escalates too (Level ⊥'s "eventually show everything" backstop). `ArgsFailureTracker`
  // doesn't exist yet (new file, args-failure-tracker.ts, §3 hook #5) — `it.todo`.
  it.todo(
    "S3 — ArgsFailureTracker: recordFailure is monotone 1→2→3 (capped) per (qualifiedName, paramPath); " +
      "recordSuccess(tool) clears every param counter for that tool, next failure restarts at L1; the " +
      "'⊥' (unlocalized) key escalates identically to a named param",
  );

  // S4: synthesizeExampleCall's stub synthesis (example-call.ts) currently invents a CONCRETE
  // value for every non-enum required slot ("string value", 0, false, …) — exercisable via the
  // REAL function today. The design doc (§2.3 construction rules, §2.6) requires a TYPE-
  // PLACEHOLDER comment (`#|string|#`, matching the signature's own type vocabulary) for every
  // non-enum slot instead: a concrete stub is copy-pasted verbatim by models (V, 2026-07-11 —
  // "concrete examples drift"), so it must read as an unfillable hole, not a fabricated datum.
  // An enum slot keeps showing a REAL member (schema fact, not invention) — unaffected.
  it.fails(
    "S4 — synthesizeExampleCall renders a TYPE-PLACEHOLDER comment (#|string|#) for a non-enum required " +
      "slot instead of a concrete invented stub, while an enum slot still shows a real member (design doc " +
      "§2.3, §2.6) — today: every non-enum slot gets a fabricated concrete value ('string value', 0, …)",
    () => {
      const schema: ToolJsonSchema = {
        type: "object",
        properties: {
          term: { type: "string" },
          status: { type: "string", enum: ["RECRUITING", "COMPLETED"] },
        },
        required: ["term", "status"],
      };
      const example = synthesizeExampleCall("clinicaltrials/list_studies", schema);
      // Non-enum slot: an unfillable type-placeholder hole, never a fabricated literal a model
      // could copy-paste verbatim as though it were real data.
      expect(example).toContain(":term #|string|#");
      expect(example).not.toContain("string value");
      // Enum slot: a REAL declared member — an enum member is schema fact, not invention.
      expect(example).toContain(':status "RECRUITING"');
    },
  );

  // S5: the retry-shape builder (§2.3's `Retry shape:` line, §2.6's composition priority order)
  // — holes appear ONLY inside the rewritten (failing) param, every other sent arg is echoed
  // verbatim; the whole result parses as a valid reader form (T1's coherence law: renderer vs
  // reader); it NEVER contains the model's own sent SCALAR relocated as though it were a real
  // fix (case A's "pick-a-key menu", never a silent relocation) nor any invented concrete data
  // outside a declared enum member. No such builder exists yet (new export composing
  // renderRetryExpr + synthesizeParamValue, §2.6/§3 hook #7) — `it.todo`.
  it.todo(
    "S5 — retry-shape builder: holes appear ONLY in the rewritten (failing) param, every other sent arg " +
      "is echoed verbatim; the whole result parses as a reader form (renderer/reader coherence law); it " +
      "NEVER contains the model's sent scalar relocated as a silent fix, nor invented concrete data outside " +
      "a declared enum member",
  );
});
