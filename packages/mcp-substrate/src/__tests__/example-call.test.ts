// example-call — synthesizeExampleCall: every stub rule, nesting, and rendering-convention
// case BEFORE this utility is wired into doors.ts (Part 2) or manifold-tool.ts (Part 3). See
// example-call.ts's header for the design rationale (real-value precedence, the numeric clamp,
// the boolean default, the one-level object-nesting bound, and why the renderer is MIRRORED
// from doors.ts rather than imported).

import { describe, expect, it } from "vitest";

import { synthesizeExampleCall } from "../example-call.js";
import type { ToolJsonSchema } from "../tool-schema.js";

describe("synthesizeExampleCall — edge cases (no schema, empty schema, all-optional)", () => {
  it("no schema at all → a bare zero-arg call", () => {
    expect(synthesizeExampleCall("filesystem_read_text_file", undefined)).toBe("(filesystem_read_text_file)");
  });

  it("an empty object schema (no properties, no required) → a bare zero-arg call", () => {
    expect(synthesizeExampleCall("ping_check", { type: "object" })).toBe("(ping_check)");
  });

  it("an all-optional schema → a bare zero-arg call (no required param to stub)", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { verbose: { type: "boolean" }, limit: { type: "number" } },
    };
    expect(synthesizeExampleCall("search_run", schema)).toBe("(search_run)");
  });
});

describe("synthesizeExampleCall — per-type stub rules", () => {
  it('string → "string value"', () => {
    const schema: ToolJsonSchema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
    expect(synthesizeExampleCall("filesystem_read_text_file", schema)).toBe(
      '(filesystem_read_text_file :path "string value")',
    );
  });

  it("number/integer with no bounds → 0", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { count: { type: "number" }, page: { type: "integer" } },
      required: ["count", "page"],
    };
    expect(synthesizeExampleCall("paginate", schema)).toBe("(paginate :count 0 :page 0)");
  });

  it("number with a minimum above 0 → clamps UP to the minimum", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { amount: { type: "number", minimum: 5 } },
      required: ["amount"],
    };
    expect(synthesizeExampleCall("billing_charge", schema)).toBe("(billing_charge :amount 5)");
  });

  it("number with a maximum below 0 → clamps DOWN to the maximum", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { delta: { type: "number", maximum: -3 } },
      required: ["delta"],
    };
    expect(synthesizeExampleCall("adjust", schema)).toBe("(adjust :delta -3)");
  });

  it("number where 0 satisfies both bounds → 0, not either bound", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { level: { type: "number", minimum: -10, maximum: 10 } },
      required: ["level"],
    };
    expect(synthesizeExampleCall("set_level", schema)).toBe("(set_level :level 0)");
  });

  it("number where 0 violates BOTH bounds — clamps to the nearer one still applied in order (minimum then maximum)", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { level: { type: "number", minimum: -10, maximum: -2 } },
      required: ["level"],
    };
    // 0 < minimum? no (-10). 0 > maximum? yes (-2) → clamps to -2.
    expect(synthesizeExampleCall("set_level", schema)).toBe("(set_level :level -2)");
  });

  it("boolean → false (documented: mirrors the numeric stub's zero-value convention)", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { dryRun: { type: "boolean" } },
      required: ["dryRun"],
    };
    expect(synthesizeExampleCall("deploy", schema)).toBe("(deploy :dryRun false)");
  });

  it("enum → the FIRST listed value, regardless of declared type", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { unit: { type: "string", enum: ["celsius", "fahrenheit"] } },
      required: ["unit"],
    };
    expect(synthesizeExampleCall("weather_get_forecast", schema)).toBe('(weather_get_forecast :unit "celsius")');
  });

  it("unknown/missing type on a REQUIRED param → the safest fallback, a quoted string", () => {
    const schema: ToolJsonSchema = { type: "object", properties: { payload: {} }, required: ["payload"] };
    expect(synthesizeExampleCall("misc_tool", schema)).toBe('(misc_tool :payload "string value")');
  });

  it("array with a scalar items schema → ONE synthesized item wrapped in [...]", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
      required: ["tags"],
    };
    expect(synthesizeExampleCall("label_apply", schema)).toBe('(label_apply :tags ["string value"])');
  });

  it("array with NO declared items schema → degrades to a one-element string-value list", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { channels: { type: "array" } },
      required: ["channels"],
    };
    expect(synthesizeExampleCall("slack_send", schema)).toBe('(slack_send :channels ["string value"])');
  });
});

describe(
  "synthesizeExampleCall — array minItems/maxItems (found+fixed 2026-07-05: previously " +
    "ignored entirely — a declared minItems > 1 synthesized a schema-INVALID single-item call)",
  () => {
    it("minItems: 3 on a required array synthesizes exactly 3 items, not 1", () => {
      const schema: ToolJsonSchema = {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string" }, minItems: 3 } },
        required: ["tags"],
      };
      expect(synthesizeExampleCall("label_apply", schema)).toBe(
        '(label_apply :tags ["string value" "string value" "string value"])',
      );
    });

    it("minItems: 0 (or absent) still synthesizes ONE item — the existing shape-demonstration floor, unchanged", () => {
      const schema: ToolJsonSchema = {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string" }, minItems: 0 } },
        required: ["tags"],
      };
      expect(synthesizeExampleCall("label_apply", schema)).toBe('(label_apply :tags ["string value"])');
    });

    it("maxItems: 0 (an array that must stay empty) synthesizes ZERO items, not one", () => {
      const schema: ToolJsonSchema = {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string" }, maxItems: 0 } },
        required: ["tags"],
      };
      expect(synthesizeExampleCall("label_apply", schema)).toBe("(label_apply :tags [])");
    });

    it("maxItems: 2, no minItems → still just the ONE-item demonstration floor (already within bounds)", () => {
      const schema: ToolJsonSchema = {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string" }, maxItems: 2 } },
        required: ["tags"],
      };
      expect(synthesizeExampleCall("label_apply", schema)).toBe('(label_apply :tags ["string value"])');
    });

    it("contradictory bounds (minItems > maxItems): clamps in order (min then max) → lands on maxItems, mirroring numericStub's own precedent", () => {
      const schema: ToolJsonSchema = {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string" }, minItems: 5, maxItems: 2 } },
        required: ["tags"],
      };
      expect(synthesizeExampleCall("label_apply", schema)).toBe('(label_apply :tags ["string value" "string value"])');
    });

    it("minItems on an array-of-objects repeats the SAME recursively-synthesized object item", () => {
      const schema: ToolJsonSchema = {
        type: "object",
        properties: {
          flights: {
            type: "array",
            minItems: 2,
            items: {
              type: "object",
              properties: { origin: { type: "string" } },
              required: ["origin"],
            },
          },
        },
        required: ["flights"],
      };
      expect(synthesizeExampleCall("airline_book", schema)).toBe(
        '(airline_book :flights [{:origin "string value"} {:origin "string value"}])',
      );
    });
  },
);

describe("synthesizeExampleCall — real-value precedence: const > examples[0] > default > enum[0] > type", () => {
  it("const wins over examples, default, AND enum", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: {
        unit: {
          type: "string",
          const: "kelvin",
          examples: ["celsius"],
          default: "fahrenheit",
          enum: ["celsius", "fahrenheit"],
        },
      },
      required: ["unit"],
    };
    expect(synthesizeExampleCall("t", schema)).toBe('(t :unit "kelvin")');
  });

  it("examples[0] wins over default and enum when const is absent", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: {
        unit: { type: "string", examples: ["celsius", "fahrenheit"], default: "fahrenheit", enum: ["a", "b"] },
      },
      required: ["unit"],
    };
    expect(synthesizeExampleCall("t", schema)).toBe('(t :unit "celsius")');
  });

  it("default wins over enum when const/examples are absent", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { unit: { type: "string", default: "fahrenheit", enum: ["a", "b"] } },
      required: ["unit"],
    };
    expect(synthesizeExampleCall("t", schema)).toBe('(t :unit "fahrenheit")');
  });

  it("a null const is a legitimate real value (renders as nil), not treated as absent", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { parent: { type: "string", const: null } },
      required: ["parent"],
    };
    expect(synthesizeExampleCall("t", schema)).toBe("(t :parent nil)");
  });

  it("a numeric 0 default is honored (not treated as falsy-absent)", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { offset: { type: "number", default: 0, minimum: 5 } },
      required: ["offset"],
    };
    // default (0) wins over the numeric-clamp synthesis entirely — it's a REAL value.
    expect(synthesizeExampleCall("t", schema)).toBe("(t :offset 0)");
  });
});

describe("synthesizeExampleCall — required-first-then-optional; optional omitted entirely", () => {
  it("only required params get stub values; optional ones are omitted from the call", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    };
    expect(synthesizeExampleCall("search_run", schema)).toBe('(search_run :query "string value")');
  });

  it("required-before-declared-order: a required field declared AFTER an optional one still comes first", () => {
    // "b" is declared before "a", but only "a" is required.
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { b: { type: "number" }, a: { type: "string" } },
      required: ["a"],
    };
    expect(synthesizeExampleCall("t", schema)).toBe('(t :a "string value")');
  });

  it("multiple required fields preserve their declared order", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { z: { type: "string" }, a: { type: "string" } },
      required: ["z", "a"],
    };
    expect(synthesizeExampleCall("t", schema)).toBe('(t :z "string value" :a "string value")');
  });
});

describe("synthesizeExampleCall — object/nested properties, bounded to one level of nesting", () => {
  it("a required object-typed param recurses into ITS required fields", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { status: { type: "string" }, includeArchived: { type: "boolean" } },
          required: ["status"],
        },
      },
      required: ["filter"],
    };
    expect(synthesizeExampleCall("search_run", schema)).toBe('(search_run :filter {:status "string value"})');
  });

  it("a nested object's OPTIONAL fields are also omitted (minimal call at every depth)", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { status: { type: "string" }, note: { type: "string" } },
          required: ["status"],
        },
      },
      required: ["filter"],
    };
    const call = synthesizeExampleCall("search_run", schema);
    expect(call).toBe('(search_run :filter {:status "string value"})');
    expect(call).not.toContain("note");
  });

  it("a SECOND level of object nesting collapses to an empty object — the one-level bound", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: { inner: { type: "object", properties: { deep: { type: "string" } }, required: ["deep"] } },
          required: ["inner"],
        },
      },
      required: ["config"],
    };
    expect(synthesizeExampleCall("configure", schema)).toBe("(configure :config {:inner {}})");
  });

  it("array-of-object → one recursively-synthesized object item", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: {
        flights: {
          type: "array",
          items: {
            type: "object",
            properties: { origin: { type: "string" }, destination: { type: "string" }, seatCount: { type: "number" } },
            required: ["origin", "destination"],
          },
        },
      },
      required: ["flights"],
    };
    expect(synthesizeExampleCall("airline_book_reservation", schema)).toBe(
      '(airline_book_reservation :flights [{:origin "string value" :destination "string value"}])',
    );
  });

  it("a SECOND level of object nesting reached THROUGH an array also collapses to {}", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              cells: {
                type: "array",
                items: { type: "object", properties: { v: { type: "string" } }, required: ["v"] },
              },
            },
            required: ["cells"],
          },
        },
      },
      required: ["rows"],
    };
    // rows[0] is depth-0→1 (one object level, fully expanded: "cells" is required and kept);
    // cells[0] would be a SECOND object level (depth 1 already) → collapses to {}.
    expect(synthesizeExampleCall("grid_fill", schema)).toBe("(grid_fill :rows [{:cells [{}]}])");
  });

  it("VERIFIED (no bug): array-of-array-of-object — TWO array levels before an object still apply the one-level object-nesting bound at the right point", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: {
        matrix: {
          type: "array",
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { foo: { type: "object", properties: { bar: { type: "string" } }, required: ["bar"] } },
              required: ["foo"],
            },
          },
        },
      },
      required: ["matrix"],
    };
    // Arrays never consume the depth budget (only entering an object's own fields does — see
    // stubValue's doc), so the FIRST object level ("foo") still expands fully; ITS nested "bar"
    // object is the second object level and collapses to {}, exactly like the existing
    // single-array "SECOND level of object nesting reached THROUGH an array" test above, just
    // with an extra array layer in front.
    expect(synthesizeExampleCall("grid_fill", schema)).toBe("(grid_fill :matrix [[{:foo {}}]])");
  });

  it("VERIFIED (no bug): three levels of plain array nesting terminate correctly (no infinite loop/stack overflow)", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: {
        cube: { type: "array", items: { type: "array", items: { type: "array", items: { type: "string" } } } },
      },
      required: ["cube"],
    };
    expect(synthesizeExampleCall("cube_fill", schema)).toBe('(cube_fill :cube [[["string value"]]])');
  });

  it('an object with `properties` but no explicit type: "object" is still treated as an object shape', () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { meta: { properties: { id: { type: "string" } }, required: ["id"] } },
      required: ["meta"],
    };
    expect(synthesizeExampleCall("t", schema)).toBe('(t :meta {:id "string value"})');
  });
});

describe("synthesizeExampleCall — rendering conventions (mirrors doors.ts's renderRetryExpr/renderJsonLiteral)", () => {
  it("nested dicts and lists use the {:k v} / [a b] literal grammar, not (dict ...)/(list ...)", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: {
        meta: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["meta", "tags"],
    };
    expect(synthesizeExampleCall("t", schema)).toBe('(t :meta {:name "string value"} :tags ["string value"])');
  });

  it("a string real-value is escaped the same way renderJsonLiteral escapes it", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { note: { type: "string", const: 'a "quoted" value\nwith a newline' } },
      required: ["note"],
    };
    expect(synthesizeExampleCall("t", schema)).toBe(String.raw`(t :note "a \"quoted\" value\nwith a newline")`);
  });

  it("a non-identifier-safe key (from a const/default OBJECT value) renders as a quoted string key", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { meta: { type: "object", const: { "weird key!": 1 } } },
      required: ["meta"],
    };
    expect(synthesizeExampleCall("t", schema)).toBe('(t :meta {"weird key!" 1})');
  });
});

describe("synthesizeExampleCall — FIXED: a non-bare TOP-LEVEL property name no longer renders invalid scheme", () => {
  // ★ This WAS a bug, now fixed — but NOT by quoting. There are TWO key renderers here:
  //   • renderLiteral (nested object keys): `BARE_KEY.test(k) ? ":${k}" : '"${...}"'` — QUOTES a
  //     non-bare key. The test just below proves this works for a nested object.
  //   • renderCall (TOP-LEVEL kwargs): used to emit `:${k}` unconditionally, no bare-key guard.
  // The obvious-looking fix ("just reuse renderLiteral's quoting here too") turns out to be
  // WRONG: verified empirically against the real reader that `:"weird key"` does NOT parse as a
  // quoted-keyword atom at all — it splits into a bare `:` plus a stray string, producing an
  // unrelated "Unbound variable" error, never a working call. Quoting only exists as a DICT
  // LITERAL key (a `{...}` object's key slot); the `:key value` kwargs-call grammar has no
  // quoted-key form to fall back on — a non-bare-identifier property name is STRUCTURALLY
  // inexpressible as a kwarg at all, however it's spelled.
  // So the actual fix: `renderCall` now detects any non-bare-identifier key among its entries
  // and degrades to the SAME safe bare-call fallback this file already uses for "no schema" /
  // "all-optional" — `(qualifiedName)` alone — rather than emit syntax that would silently fail
  // to parse as intended. Never a crash, never a fabricated-looking but broken argument.
  it("a space in a required top-level key degrades to the bare call — no broken kwargs emitted", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { "weird key!": { type: "string" } },
      required: ["weird key!"],
    };
    expect(synthesizeExampleCall("t", schema)).toBe("(t)");
  });

  it("two non-bare keys still degrade cleanly to the bare call, not a mangled one", () => {
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { "a b": { type: "string" }, "c d": { type: "number" } },
      required: ["a b", "c d"],
    };
    expect(synthesizeExampleCall("t", schema)).toBe("(t)");
  });

  it("CONTRAST: the SAME non-bare key NESTED inside an object IS correctly quoted (renderLiteral path)", () => {
    // Proves the renderer can quote — renderCall's top-level kwarg path just fails to.
    const schema: ToolJsonSchema = {
      type: "object",
      properties: {
        meta: { type: "object", properties: { "weird key!": { type: "string" } }, required: ["weird key!"] },
      },
      required: ["meta"],
    };
    expect(synthesizeExampleCall("t", schema)).toBe('(t :meta {"weird key!" "string value"})');
  });
});

describe("synthesizeExampleCall — degenerate / contradictory schemas (adversarial — never crash, defensible output)", () => {
  // These are genuine adversarial attempts that the synthesizer handles gracefully — pinned as
  // WORKS-CORRECTLY (defensible, non-crashing) so the behavior on impossible/degenerate input is
  // a documented baseline, not an accident.
  it("contradictory bounds (minimum > maximum): clamps in order (min then max) → lands on the MAXIMUM", () => {
    // No value satisfies min 10 AND max 5. numericStub applies minimum first (0→10), then maximum
    // (10→5), so it returns the maximum. Defensible: some bound is honored; it never crashes.
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { n: { type: "number", minimum: 10, maximum: 5 } },
      required: ["n"],
    };
    expect(synthesizeExampleCall("t", schema)).toBe("(t :n 5)");
  });

  it("an EMPTY enum on a required prop falls through to the declared type (no crash, no `undefined`)", () => {
    // stubValue guards `prop.enum.length > 0`, so an empty enum is skipped and the string type
    // supplies the placeholder — never `enum[0]` (which would be `undefined`).
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { u: { type: "string", enum: [] } },
      required: ["u"],
    };
    expect(synthesizeExampleCall("t", schema)).toBe('(t :u "string value")');
  });

  it("VERIFIED (no bug): an enum/type MISMATCH (numbers under a string-declared prop) still honors enum-wins-over-type, consistent with typeToken's own precedent — the schema itself is unsatisfiable either way", () => {
    // type: "string" + enum: [1,2,3] together admit ZERO valid instances (no string is in the
    // enum, no enum member is a string) — a schema-author contradiction this synthesizer can't
    // repair. `stubValue` already prefers enum over the declared type (mirrors tool-signature.ts's
    // `typeToken`); this just confirms that precedent doesn't crash or misrender for a
    // TYPE-inconsistent enum, it renders the enum member with its OWN actual (numeric) grammar.
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { unit: { type: "string", enum: [1, 2, 3] } },
      required: ["unit"],
    };
    expect(synthesizeExampleCall("weather_get", schema)).toBe("(weather_get :unit 1)");
  });

  it("a `required` name with NO matching property is silently dropped (no fabricated arg, no crash)", () => {
    // orderedFields only ever yields fields that exist in `properties`; a `required` entry with no
    // property schema simply never becomes a field. The minimal call omits it rather than
    // inventing a placeholder for a param whose shape is entirely unknown.
    const schema: ToolJsonSchema = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "ghost"],
    };
    expect(synthesizeExampleCall("t", schema)).toBe('(t :a "string value")');
  });
});
