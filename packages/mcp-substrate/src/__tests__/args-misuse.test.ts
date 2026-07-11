// args-misuse — the localization + escalation contract behind the localized args-misuse door
// (second-foundation/arrival-manifold/docs/args-error-reporting-v2.md §7.2). The door replaces
// the bare Signature + Example echo with a LOCALIZED teach — the failing parameter named, its
// sub-schema taught, a copy-paste-correct retry shape — escalating on repeated failure of the
// same (tool, param). S1 contracts `extractClues`, S2 `localizeFailingParam`, S3
// `ArgsFailureTracker`, S4 `synthesizeExampleCall`'s hole rendering, S5 `buildRetryShape`
// (the §2.6 composition — flipped from it.todo when args-misuse-door.ts landed).

import { describe, expect, it } from "vitest";

import { ArgsFailureTracker } from "../args-failure-tracker.js";
import { extractClues, localizeFailingParam, type ArgsClue } from "../args-misuse.js";
import { buildRetryShape, renderArgsMisuseTeaching } from "../args-misuse-door.js";
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

    it("family PRIORITY order: zod-path, then value-mismatch, unexpected-keys, required-key (own-decode families outrank all — separate row below)", () => {
      // A contrived text carrying all four upstream shapes at once — extraction order is the
      // family priority `localizeFailingParam` relies on (zod-path tried first among the
      // upstream families, "authoritative").
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

    it("own-decode grammar (kwargs-rejection.ts): per-issue lines parse head-gated; unknown-key lines become own-unknown-key clues and OUTRANK the path lines (a top-level typo usually causes the sibling missing-required)", () => {
      const text = "toy/add: arguments rejected — 2 problem(s):\n  :aa — unknown key\n  :a — missing (required)";
      expect(extractClues(text)).toEqual([
        { kind: "own-unknown-key", tokens: ["aa"] },
        { kind: "own-decode", tokens: ["a"], issue: "missing (required)" },
      ] satisfies ArgsClue[]);
    });

    it("own-decode lines only parse under the frozen head — a stray ' :foo — ' in unrelated upstream prose never becomes a clue", () => {
      expect(extractClues("  :foo — something upstream said")).toEqual([]);
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

  // S5: the retry-shape builder (§2.3's `Retry shape:` line, §2.6's composition priority
  // order) — holes appear ONLY inside the rewritten (failing) param, every other sent arg is
  // echoed verbatim; the whole result parses as a valid reader form (T1's coherence law:
  // renderer vs reader — asserted against arrival's REAL tokenizer/parser, not a regex); it
  // NEVER contains the model's own sent SCALAR relocated as though it were a real fix (case
  // A's "pick-a-key menu", never a silent relocation) nor any invented concrete data outside
  // a declared enum member.
  describe("S5 — buildRetryShape (design doc §2.3 construction rules, §2.6 priority order)", () => {
    const QUALIFIED = "clinicaltrialsgov-mcp-server/clinicaltrials_list_studies";
    const QUERY_SUBSCHEMA: JsonSchemaProperty = {
      type: "object",
      properties: {
        cond: { type: "string", description: "Conditions or disease query." },
        term: { type: "string", description: "Other terms query." },
      },
    };

    /** The coherence law, proven against the REAL reader (never a regex): a hole-free retry
     *  expr parses as one form as-is; a hole-bearing one parses once the model fills the hole
     *  — and must NOT parse blind (the hole strips as a block comment, leaving an uneven dict:
     *  our invention can never run as plausible data — the anti-copy-paste feature,
     *  example-call.ts's TypePlaceholder contract). */
    async function parsesAsOneForm(expr: string): Promise<boolean> {
      const { parse } = await import("@here.build/arrival");
      try {
        return (await parse(expr)).length === 1;
      } catch {
        return false;
      }
    }

    it("case A (value-mismatch on a keyed object param): the rewritten param carries a #|type|# hole under the first declared key + a pick-a-key menu; the OTHER sent args are echoed verbatim; the sent scalar is NEVER relocated", async () => {
      const sent = "King Saud University";
      const sentArgs = { query: sent, pageSize: 50 };
      const localized = localizeFailingParam(`'${sent}' is not of type 'object'`, sentArgs, {
        type: "object",
        properties: { query: QUERY_SUBSCHEMA, pageSize: { type: "number" } },
      })!;
      const shape = buildRetryShape(QUALIFIED, sentArgs, localized);
      expect(shape).toBeDefined();
      expect(shape!.expr).toContain(":query {:cond #|string|#}");
      expect(shape!.expr).toContain(":pageSize 50"); // other args verbatim
      expect(shape!.expr).not.toContain(sent); // never the sent scalar relocated
      expect(shape!.menu).toContain("cond (Conditions or disease query.)");
      // Blind copy-paste FAILS at the reader (the dict-literal hole strips to an uneven
      // dict); filling the hole with a real value parses as one form.
      await expect(parsesAsOneForm(shape!.expr)).resolves.toBe(false);
      await expect(parsesAsOneForm(shape!.expr.replace("#|string|#", '"diabetes"'))).resolves.toBe(true);
    });

    it("case B (unexpected-key at edit distance 1): the model's OWN object is echoed with just the key renamed — copy-paste-correct, no holes (the model's data is not our invention)", async () => {
      const sentArgs = { query: { terms: "King Saud University" } };
      const localized = localizeFailingParam(
        "Additional properties are not allowed ('terms' was unexpected)",
        sentArgs,
        { type: "object", properties: { query: QUERY_SUBSCHEMA } },
      )!;
      const shape = buildRetryShape(QUALIFIED, sentArgs, localized);
      expect(shape).toBeDefined();
      expect(shape!.expr).toBe(`(${QUALIFIED} :query {:term "King Saud University"})`);
      expect(shape!.menu).toBeUndefined();
      await expect(parsesAsOneForm(shape!.expr)).resolves.toBe(true);
    });

    it("declines (undefined) on a NESTED failing path — rewriting the container would drop its healthy siblings, so no retry expr beats a wrong one", () => {
      const schema: ToolJsonSchema = {
        type: "object",
        properties: { filter: { type: "object", properties: { geo: { type: "string" } } } },
      };
      const sentArgs = { filter: { geo: "x" } };
      const localized = localizeFailingParam('[{"path": ["filter", "geo"], "message": "m"}]', sentArgs, schema)!;
      expect(localized.path).toEqual(["filter", "geo"]);
      expect(buildRetryShape(QUALIFIED, sentArgs, localized)).toBeUndefined();
    });

    it("declines (undefined) without sent args — there is no call of the model's own to echo", () => {
      const schema: ToolJsonSchema = { type: "object", properties: { query: QUERY_SUBSCHEMA } };
      const localized = localizeFailingParam('[{"path": ["query"], "message": "m"}]', undefined, schema)!;
      expect(buildRetryShape(QUALIFIED, undefined, localized)).toBeUndefined();
    });

    it("case-B rename DECLINES when the target key already exists on the sent object — a rename would clobber the model's own value while reading as an explicit fact (triad finding, 2026-07-11)", () => {
      const sentArgs = { query: { terms: "bad spelling", term: "the real one" } };
      const localized = localizeFailingParam(
        "Additional properties are not allowed ('terms' was unexpected)",
        sentArgs,
        { type: "object", properties: { query: QUERY_SUBSCHEMA } },
      )!;
      const shape = buildRetryShape(QUALIFIED, sentArgs, localized);
      // Falls to the hole-skeleton + menu path instead — no data destroyed, no false certainty.
      expect(shape).toBeDefined();
      expect(shape!.expr).not.toContain('"bad spelling"');
      expect(shape!.expr).toContain("#|");
    });
  });

  // ─── own-unknown-key — the strict decode's TOP-LEVEL typo family (triad finding) ───
  describe("own-unknown-key — top-level keyword typos localize via the tight-match gate", () => {
    const SCHEMA: ToolJsonSchema = {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    };

    it("a lone unknown-key rejection localizes to the tight-matched declared param (the model typo'd it), clue keeps the bad spelling", () => {
      const localized = localizeFailingParam("toy/add: arguments rejected — 1 problem(s):\n  :aa — unknown key", undefined, SCHEMA);
      expect(localized?.path).toEqual(["a"]);
      expect(localized?.clue).toEqual({ kind: "own-unknown-key", tokens: ["aa"] });
    });

    it("unknown-key + missing-required in ONE rejection teaches the TYPO (the root cause), not the missing key it caused", () => {
      const text = "toy/add: arguments rejected — 2 problem(s):\n  :aa — unknown key\n  :a — missing (required)";
      const localized = localizeFailingParam(text, undefined, SCHEMA);
      expect(localized?.clue.kind).toBe("own-unknown-key");
      expect(localized?.path).toEqual(["a"]);
    });

    it("zero or several tight matches ⇒ decline, never a guessed rename", () => {
      // "zz" matches nothing; "ab" is distance 1 from BOTH "a" and "b" — ambiguous.
      expect(
        localizeFailingParam("t: arguments rejected — 1 problem(s):\n  :zz — unknown key", undefined, SCHEMA),
      ).toBeUndefined();
      const ambiguous = localizeFailingParam(
        "t: arguments rejected — 1 problem(s):\n  :ab — unknown key",
        undefined,
        SCHEMA,
      );
      expect(ambiguous?.clue.kind).not.toBe("own-unknown-key");
    });
  });

  // The discovery nudge (MCP-Atlas 2026-07-11 forensics, tasks …e8a/…fd3): a MISSING required
  // arg — the model lacks a value it needs — must teach "discover it, don't ask the user",
  // never on a type-mismatch (there the model HAS a value, just the wrong type).
  describe("discovery nudge on missing-required args", () => {
    const SCHEMA: ToolJsonSchema = {
      type: "object",
      properties: { repo_path: { type: "string" }, revision: { type: "string" } },
      required: ["repo_path"],
    };
    it("a missing-required own-decode fact line carries the 'discover it, don't ask the user' nudge", () => {
      const loc = localizeFailingParam("git/git_log: arguments rejected — 1 problem(s):\n  :repo_path — missing (required)", undefined, SCHEMA)!;
      const body = renderArgsMisuseTeaching({ qualifiedName: "git/git_log", sentArgs: undefined, localized: loc, level: 1 });
      expect(body).toContain("Failing argument: :repo_path — it is required and was not sent");
      expect(body).toContain("discover it with a listing/search tool");
      expect(body).toContain("rather than asking the user");
    });
    it("a TYPE-mismatch own-decode does NOT carry the discovery nudge (the model has a value, wrong type)", () => {
      const loc = localizeFailingParam('git/git_log: arguments rejected — 1 problem(s):\n  :repo_path — expected string, got number: 5', undefined, SCHEMA)!;
      const body = renderArgsMisuseTeaching({ qualifiedName: "git/git_log", sentArgs: undefined, localized: loc, level: 1 });
      expect(body).not.toContain("discover it");
    });
  });
});
