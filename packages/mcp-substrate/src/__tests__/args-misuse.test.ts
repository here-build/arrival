// args-misuse — the localization + escalation contract behind the localized args-misuse door
// (second-foundation/arrival-manifold/docs/args-error-reporting-v2.md §7.2). The door replaces
// the bare Signature + Example echo with a LOCALIZED teach — the failing parameter named, its
// sub-schema taught, a copy-paste-correct retry shape — escalating on repeated failure of the
// same (tool, param). S1 contracts `extractClues`, S2 `localizeFailingParam`, S3
// `ArgsFailureTracker`, S4 `synthesizeExampleCall`'s hole rendering; S5 remains an `it.todo`
// (it contracts the retry-shape builder, design doc §2.6, which has no export yet).

import { describe, expect, it } from "vitest";

import { ArgsFailureTracker } from "../args-failure-tracker.js";
import { extractClues, localizeFailingParam, type ArgsClue } from "../args-misuse.js";
import { synthesizeExampleCall } from "../example-call.js";
import type { JsonSchemaProperty, ToolJsonSchema } from "../tool-schema.js";

// ─── S1 — extractClues: the 4-family table, over the 45edee verbatim fixtures ───

describe("args-misuse — localized door + escalation (docs/args-error-reporting-v2.md §7.2)", () => {
  describe("S1 — extractClues: the 4-family table, over the 45edee verbatim fixtures (design doc §1, §2.2)", () => {
    it("python-jsonschema value-mismatch: \"'King Saud University' is not of type 'object'\"", () => {
      const text =
        '{"detail":"Failed to call tool \'clinicaltrialsgov-mcp-server_clinicaltrials_list_studies\': ' +
        "Input validation error: 'King Saud University' is not of type 'object'\"}";
      expect(extractClues(text)).toEqual([
        { kind: "value-mismatch", tokens: ["King Saud University"], expectedType: "object" },
      ] satisfies ArgsClue[]);
    });

    it("python-jsonschema unexpected-keys (single bad key): \"Additional properties are not allowed ('terms' was unexpected)\"", () => {
      const text =
        '{"detail":"Failed to call tool \'clinicaltrialsgov-mcp-server_clinicaltrials_list_studies\': ' +
        "Input validation error: Additional properties are not allowed ('terms' was unexpected)\"}";
      expect(extractClues(text)).toEqual([{ kind: "unexpected-keys", tokens: ["terms"] }] satisfies ArgsClue[]);
    });

    it("python-jsonschema unexpected-keys (multiple bad keys) pulls every quoted key out of the parenthesized clause", () => {
      const text = "Additional properties are not allowed ('k1', 'k2' were unexpected)";
      expect(extractClues(text)).toEqual([{ kind: "unexpected-keys", tokens: ["k1", "k2"] }] satisfies ArgsClue[]);
    });

    it("python-jsonschema required-key: \"'cond' is a required property\"", () => {
      expect(extractClues("'cond' is a required property")).toEqual([
        { kind: "required-key", tokens: ["cond"] },
      ] satisfies ArgsClue[]);
    });

    it('TS SDK / zod issues JSON: a "path": [...] array inside the issues blob is authoritative', () => {
      const text =
        "Input validation error: Invalid arguments for tool clinicaltrials/list_studies: " +
        '[{"code": "invalid_type", "expected": "object", "received": "string", "path": ["query"], ' +
        '"message": "Expected object, received string"}]';
      expect(extractClues(text)).toEqual([{ kind: "zod-path", tokens: ["query"] }] satisfies ArgsClue[]);
    });

    it("a zod-path clue carries the FULL nested path, not just its first segment", () => {
      const text = '[{"code": "invalid_type", "path": ["filter", "startDate"], "message": "…"}]';
      expect(extractClues(text)).toEqual([{ kind: "zod-path", tokens: ["filter", "startDate"] }] satisfies ArgsClue[]);
    });

    it("a multi-issue zod blob yields one zod-path clue PER issue, in appearance order", () => {
      const text = '[{"path": ["a"], "message": "one"}, {"path": ["b", "c"], "message": "two"}]';
      expect(extractClues(text)).toEqual([
        { kind: "zod-path", tokens: ["a"] },
        { kind: "zod-path", tokens: ["b", "c"] },
      ] satisfies ArgsClue[]);
    });

    it("no recognizable family shape → zero clues, never a guessed one", () => {
      expect(extractClues("ValueError: database connection refused")).toEqual([]);
    });

    it("family PRIORITY order: zod-path first, then value-mismatch, unexpected-keys, required-key", () => {
      // A contrived text carrying all four shapes at once — extraction order is the family
      // priority `localizeFailingParam` relies on (zod-path tried first, "authoritative").
      const text =
        '[{"path": ["query"], "message": "m"}] ' +
        "'King Saud University' is not of type 'object' " +
        "Additional properties are not allowed ('terms' was unexpected) " +
        "'cond' is a required property";
      expect(extractClues(text).map((c) => c.kind)).toEqual([
        "zod-path",
        "value-mismatch",
        "unexpected-keys",
        "required-key",
      ]);
    });
  });

  // ─── S2 — localizeFailingParam soundness (T2) ───

  describe("S2 — localizeFailingParam: sound against the tool's schema; ambiguous ⇒ undefined (design doc §2.2, T2)", () => {
    const QUERY_SCHEMA: ToolJsonSchema = {
      type: "object",
      properties: {
        query: {
          type: "object",
          properties: {
            cond: { type: "string", description: "Conditions or disease query." },
            term: { type: "string", description: "Other terms query." },
          },
        },
        filter: {
          type: "object",
          properties: { advanced: { type: "string" } },
          additionalProperties: false,
        } as JsonSchemaProperty,
      },
    };

    it("Case A (value-mismatch, exactly one candidate) localizes to the top-level kwarg the sent scalar lives under", () => {
      const errorText =
        "{\"detail\":\"Failed to call tool 'x': Input validation error: 'King Saud University' is not of type 'object'\"}";
      const localized = localizeFailingParam(errorText, { query: "King Saud University" }, QUERY_SCHEMA);
      expect(localized?.path).toEqual(["query"]);
      expect(localized?.clue.kind).toBe("value-mismatch");
      expect(localized?.sentValue).toBe("King Saud University");
      expect(localized?.subSchema).toEqual(QUERY_SCHEMA.properties!.query);
    });

    it("Case B (unexpected-keys, exactly one candidate) localizes to the containing object kwarg", () => {
      const errorText = "Additional properties are not allowed ('terms' was unexpected)";
      const localized = localizeFailingParam(errorText, { query: { terms: "King Saud University" } }, QUERY_SCHEMA);
      expect(localized?.path).toEqual(["query"]);
      expect(localized?.clue.kind).toBe("unexpected-keys");
    });

    it("zod-path is authoritative: a nested path resolves without any walk, verified sound against the schema", () => {
      const nested: ToolJsonSchema = {
        type: "object",
        properties: { filter: { type: "object", properties: { advanced: { type: "string" } } } },
      };
      const errorText = '[{"path": ["filter", "advanced"], "message": "Expected string, received number"}]';
      const localized = localizeFailingParam(errorText, { filter: { advanced: 5 } }, nested);
      expect(localized?.path).toEqual(["filter", "advanced"]);
      expect(localized?.subSchema).toEqual({ type: "string" });
      expect(localized?.sentValue).toBe(5);
    });

    it("a zod-path clue naming a param absent from the schema is DISCARDED, never named as fact", () => {
      const errorText = '[{"path": ["nonexistent"], "message": "…"}]';
      expect(localizeFailingParam(errorText, { nonexistent: "x" }, QUERY_SCHEMA)).toBeUndefined();
    });

    it(
      "ZERO candidates (the token appears nowhere in sent-args — e.g. a COMPUTED arg the caller could " +
        "only record as an opaque marker, design doc §2.2's form-walk fallback) ⇒ undefined, never a guess",
      () => {
        const errorText = "'King Saud University' is not of type 'object'";
        // sentArgs holds an OPAQUE marker (what a form-walk fallback records for a computed
        // expression like `(build-q)`) instead of the real evaluated string — correctly no match.
        const localized = localizeFailingParam(errorText, { query: "<computed>" }, QUERY_SCHEMA);
        expect(localized).toBeUndefined();
      },
    );

    it("MANY candidates (a planted duplicate value across two sibling params) ⇒ undefined, never a guess", () => {
      const twoStringParams: ToolJsonSchema = {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
      };
      const errorText = "'duplicate' is not of type 'number'";
      const localized = localizeFailingParam(errorText, { a: "duplicate", b: "duplicate" }, twoStringParams);
      expect(localized).toBeUndefined();
    });

    it("no sentArgs available at all ⇒ value-mismatch/unexpected-keys decline (nothing to walk)", () => {
      const errorText = "'King Saud University' is not of type 'object'";
      expect(localizeFailingParam(errorText, undefined, QUERY_SCHEMA)).toBeUndefined();
    });

    it("no schema available at all ⇒ every family declines (soundness has nothing to verify against)", () => {
      const errorText = "'King Saud University' is not of type 'object'";
      expect(localizeFailingParam(errorText, { query: "King Saud University" }, undefined)).toBeUndefined();
    });

    it("required-key at the TOP level (no containing node) localizes to the missing kwarg itself", () => {
      const schema: ToolJsonSchema = {
        type: "object",
        properties: { cond: { type: "string" } },
        required: ["cond"],
      } as ToolJsonSchema;
      const localized = localizeFailingParam("'cond' is a required property", {}, schema);
      expect(localized?.path).toEqual(["cond"]);
      expect(localized?.subSchema).toEqual({ type: "string" });
    });

    it("a MULTI-issue zod blob localizes to the FIRST schema-valid path — every zod path is an authoritative fact about a failing param, so first-sound-wins is a true lesson, and the next rejection carries the remaining issues", () => {
      const schema: ToolJsonSchema = {
        type: "object",
        properties: { query: { type: "object" }, filter: { type: "object" } },
      };
      const errorText = '[{"path": ["query"], "message": "one"}, {"path": ["filter"], "message": "two"}]';
      const localized = localizeFailingParam(errorText, { query: 1, filter: 2 }, schema);
      expect(localized?.path).toEqual(["query"]);
      // …and when the FIRST issue's path fails schema verification, the SECOND still localizes.
      const firstUnsound = '[{"path": ["ghost"], "message": "one"}, {"path": ["filter"], "message": "two"}]';
      expect(localizeFailingParam(firstUnsound, { filter: 2 }, schema)?.path).toEqual(["filter"]);
    });

    it("required-key with TWO sent-args-backed containers (both candidate objects were sent as partial shells) ⇒ undefined, never a guess", () => {
      const schema: ToolJsonSchema = {
        type: "object",
        properties: {
          query: { type: "object", properties: { cond: { type: "string" } }, required: ["cond"] },
          filter: { type: "object", properties: { cond: { type: "string" } }, required: ["cond"] },
        },
      };
      const localized = localizeFailingParam("'cond' is a required property", { query: {}, filter: {} }, schema);
      expect(localized).toBeUndefined();
    });

    it("required-key NESTED inside an object param localizes to the CONTAINING kwarg, tie-broken toward sent-args evidence", () => {
      const schema: ToolJsonSchema = {
        type: "object",
        properties: {
          query: {
            type: "object",
            properties: { cond: { type: "string" }, term: { type: "string" } },
            required: ["cond"],
          },
        },
      };
      const localized = localizeFailingParam("'cond' is a required property", { query: { term: "x" } }, schema);
      expect(localized?.path).toEqual(["query"]);
    });

    it("fuzz: a random arg tree with a PLANTED cross-param value collision always resolves undefined for value-mismatch", () => {
      // Deterministic LCG (no external fuzz dependency) — small, reproducible, no seed drift
      // across CI runs. Every iteration plants the SAME collision (two sibling string params
      // sharing one value) inside an otherwise-random tree shape, then asserts the invariant:
      // 2+ candidates ⇒ undefined, regardless of how much unrelated noise surrounds them.
      let seed = 42;
      const rand = (): number => {
        seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
        return seed / 0x7f_ff_ff_ff;
      };
      const randomString = (): string => Math.floor(rand() * 1e9).toString(36);

      for (let i = 0; i < 50; i++) {
        const collisionValue = `collide-${i}`;
        const noiseKeys = Math.floor(rand() * 4);
        const sentArgs: Record<string, unknown> = { alpha: collisionValue, beta: collisionValue };
        const schema: ToolJsonSchema = {
          type: "object",
          properties: { alpha: { type: "string" }, beta: { type: "string" } },
        };
        for (let n = 0; n < noiseKeys; n++) sentArgs[`noise${n}`] = randomString();
        const errorText = `'${collisionValue}' is not of type 'number'`;
        expect(localizeFailingParam(errorText, sentArgs, schema)).toBeUndefined();
      }
    });

    it("fuzz: a SINGLE planted match amid random noise always resolves to exactly that path", () => {
      let seed = 7;
      const rand = (): number => {
        seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
        return seed / 0x7f_ff_ff_ff;
      };
      const randomString = (): string => Math.floor(rand() * 1e9).toString(36);

      for (let i = 0; i < 50; i++) {
        const target = `unique-${i}`;
        const noiseKeys = Math.floor(rand() * 4);
        const sentArgs: Record<string, unknown> = { needle: target };
        const schema: ToolJsonSchema = { type: "object", properties: { needle: { type: "string" } } };
        for (let n = 0; n < noiseKeys; n++) {
          const noiseVal = randomString();
          sentArgs[`noise${n}`] = noiseVal;
          (schema.properties as Record<string, JsonSchemaProperty>)[`noise${n}`] = { type: "string" };
        }
        const errorText = `'${target}' is not of type 'number'`;
        const localized = localizeFailingParam(errorText, sentArgs, schema);
        expect(localized?.path).toEqual(["needle"]);
      }
    });
  });

  // ─── S3 — ArgsFailureTracker (§2.4) ───

  describe("S3 — ArgsFailureTracker: L1→L2→L3 monotone per (tool,param), capped; success clears the whole tool (design doc §2.4)", () => {
    it("recordFailure is monotone 1→2→3, capped at 3 on further failures", () => {
      const tracker = new ArgsFailureTracker();
      expect(tracker.recordFailure("t/tool", ["query"])).toBe(1);
      expect(tracker.recordFailure("t/tool", ["query"])).toBe(2);
      expect(tracker.recordFailure("t/tool", ["query"])).toBe(3);
      expect(tracker.recordFailure("t/tool", ["query"])).toBe(3);
      expect(tracker.recordFailure("t/tool", ["query"])).toBe(3);
    });

    it("counters are independent PER (tool, param) — a different param starts its own L1", () => {
      const tracker = new ArgsFailureTracker();
      tracker.recordFailure("t/tool", ["query"]);
      tracker.recordFailure("t/tool", ["query"]);
      expect(tracker.recordFailure("t/tool", ["filter"])).toBe(1);
      expect(tracker.recordFailure("t/tool", ["query"])).toBe(3);
    });

    it("counters are independent PER TOOL — the same param name on a different tool starts its own L1", () => {
      const tracker = new ArgsFailureTracker();
      tracker.recordFailure("t/tool-a", ["query"]);
      tracker.recordFailure("t/tool-a", ["query"]);
      expect(tracker.recordFailure("t/tool-b", ["query"])).toBe(1);
    });

    it("recordSuccess(tool) clears EVERY param counter for that tool; the next failure restarts at L1", () => {
      const tracker = new ArgsFailureTracker();
      tracker.recordFailure("t/tool", ["query"]);
      tracker.recordFailure("t/tool", ["query"]);
      tracker.recordFailure("t/tool", ["filter"]);
      tracker.recordSuccess("t/tool");
      expect(tracker.recordFailure("t/tool", ["query"])).toBe(1);
      expect(tracker.recordFailure("t/tool", ["filter"])).toBe(1);
    });

    it("recordSuccess(tool) does NOT clear a DIFFERENT tool's counters", () => {
      const tracker = new ArgsFailureTracker();
      tracker.recordFailure("t/tool-a", ["query"]);
      tracker.recordFailure("t/tool-a", ["query"]);
      tracker.recordSuccess("t/tool-b");
      expect(tracker.recordFailure("t/tool-a", ["query"])).toBe(3);
    });

    it("the '⊥' (unlocalized, paramPath undefined) key escalates identically to a named param", () => {
      const tracker = new ArgsFailureTracker();
      expect(tracker.recordFailure("t/tool", undefined)).toBe(1);
      expect(tracker.recordFailure("t/tool", undefined)).toBe(2);
      expect(tracker.recordFailure("t/tool", undefined)).toBe(3);
      expect(tracker.recordFailure("t/tool", undefined)).toBe(3);
      tracker.recordSuccess("t/tool");
      expect(tracker.recordFailure("t/tool", undefined)).toBe(1);
    });

    it("the ⊥ key and a named param are tracked SEPARATELY on the same tool", () => {
      const tracker = new ArgsFailureTracker();
      tracker.recordFailure("t/tool", undefined);
      tracker.recordFailure("t/tool", undefined);
      expect(tracker.recordFailure("t/tool", ["query"])).toBe(1);
    });

    it("exportState/importState round-trips the counters exactly (session-store precedent)", () => {
      const tracker = new ArgsFailureTracker();
      tracker.recordFailure("t/tool", ["query"]);
      tracker.recordFailure("t/tool", ["query"]);
      tracker.recordFailure("t/tool", undefined);
      const state = tracker.exportState();

      const restored = new ArgsFailureTracker();
      restored.importState(state);
      expect(restored.recordFailure("t/tool", ["query"])).toBe(3);
      expect(restored.recordFailure("t/tool", undefined)).toBe(2);
    });

    it("importState REPLACES wholesale — a prior tracker's own state doesn't survive underneath it", () => {
      const tracker = new ArgsFailureTracker();
      tracker.recordFailure("t/tool", ["query"]);
      tracker.recordFailure("t/tool", ["query"]);
      tracker.importState({ entries: [] });
      expect(tracker.recordFailure("t/tool", ["query"])).toBe(1);
    });

    it("importState DISCARDS a counter that is not a valid level (corrupt/tampered blob) — the entry restores to no-history (fresh L1), never a fabricated escalation; valid siblings survive", () => {
      const tracker = new ArgsFailureTracker();
      const valid = new ArgsFailureTracker();
      valid.recordFailure("t/tool", ["ok"]);
      valid.recordFailure("t/tool", ["ok"]);
      const [okEntry] = valid.exportState().entries;
      tracker.importState({
        entries: [
          okEntry!,
          [okEntry![0].replace("ok", "zero"), 0],
          [okEntry![0].replace("ok", "neg"), -5],
          [okEntry![0].replace("ok", "big"), 99],
          [okEntry![0].replace("ok", "frac"), 2.5],
          [okEntry![0].replace("ok", "nan"), Number.NaN],
        ],
      });
      expect(tracker.recordFailure("t/tool", ["ok"])).toBe(3); // valid 2 survived → 3
      expect(tracker.recordFailure("t/tool", ["zero"])).toBe(1);
      expect(tracker.recordFailure("t/tool", ["neg"])).toBe(1);
      expect(tracker.recordFailure("t/tool", ["big"])).toBe(1);
      expect(tracker.recordFailure("t/tool", ["frac"])).toBe(1);
      expect(tracker.recordFailure("t/tool", ["nan"])).toBe(1);
    });
  });

  // S4: a non-enum slot must read as an unfillable TYPE-PLACEHOLDER hole (`#|string|#`,
  // matching the signature's own type vocabulary), never a fabricated concrete datum —
  // concrete examples drift: models copy rendered exprs verbatim, so an invented value becomes
  // the model's next call. An enum slot shows a REAL member (schema fact, not invention).
  it(
    "S4 — synthesizeExampleCall renders a TYPE-PLACEHOLDER comment (#|string|#) for a non-enum required " +
      "slot instead of a concrete invented stub, while an enum slot still shows a real member (design doc " +
      "§2.3, §2.6)",
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
