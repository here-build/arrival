/**
 * Mandatory head census for demand-harvest totality (eng-review G3).
 * Fail if LIST_DOMAIN_REVERSERS / source / opaque tables drift from emit discipline.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DEMAND_OPAQUE_HEADS,
  DEMAND_SOURCE_HEADS,
  LIST_DOMAIN_REVERSERS,
} from "../type-emit/emit.js";

const emitSrc = readFileSync(
  fileURLToPath(new URL("../type-emit/emit.ts", import.meta.url)),
  "utf8",
);

describe("demand algebra census (mandatory)", () => {
  it("reverser table has arity-safe take/drop (list at arg 1, never count)", () => {
    expect(LIST_DOMAIN_REVERSERS.get("take")).toEqual({ kind: "list-preserve-arg", argIndex: 1 });
    expect(LIST_DOMAIN_REVERSERS.get("drop")).toEqual({ kind: "list-preserve-arg", argIndex: 1 });
    expect(LIST_DOMAIN_REVERSERS.get("reverse")).toEqual({ kind: "list-preserve-arg", argIndex: 0 });
    expect(LIST_DOMAIN_REVERSERS.get("append")).toEqual({ kind: "list-preserve-all" });
    expect(LIST_DOMAIN_REVERSERS.get("cons")).toEqual({ kind: "cons" });
    expect(LIST_DOMAIN_REVERSERS.get("list")).toEqual({ kind: "list-elements" });
  });

  it("source + opaque heads are named (no silent fallthrough vocabulary)", () => {
    expect([...DEMAND_SOURCE_HEADS]).toContain("map");
    expect([...DEMAND_OPAQUE_HEADS]).toEqual(
      expect.arrayContaining(["cut", "apply", "dict", "require"]),
    );
  });

  it("emit.ts does not special-case list reverse outside LIST_DOMAIN_REVERSERS keys", () => {
    // Guard against re-introducing hand if-chains for list/cons/append without table row.
    for (const head of ["list", "cons", "append", "reverse", "take", "drop", "filter", "remove"]) {
      expect(LIST_DOMAIN_REVERSERS.has(head), `missing reverser row: ${head}`).toBe(true);
    }
    // applyDomainToArg should dispatch via the map, not a free-standing head === "append"
    expect(emitSrc).toMatch(/LIST_DOMAIN_REVERSERS\.get/);
    expect(emitSrc).not.toMatch(/head\(arg\) === "append"/);
  });
});
