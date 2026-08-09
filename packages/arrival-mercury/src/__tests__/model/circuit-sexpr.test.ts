/**
 * circuitToSexpr's own contract (T6b). FIXTURE-FIRST, same discipline as
 * verdict/circuit-verdict.test.ts: every circuit below is HAND-BUILT (never
 * produced by calling `extract`), and `site` is irrelevant to any check here
 * (it rides along for rendering, never compared on) — every node shares one
 * dummy NodeId.
 *
 * The per-kind render rows are ONE protocol table (`SEXPR_ROWS`) over the
 * shared hand-built constructors (`circuit-render-fixtures.ts`, shared with
 * the mermaid twin): `{ name, circuit, golden }`, plus `contains` for the
 * deep-nesting row that only pins fragments.
 */
import { describe, expect, it } from "vitest";

import { circuitToSexpr } from "../../model/circuit-sexpr.js";
import type { StaticProv } from "../../model/static-prov.js";
import { build, choice, fan, fused, input, konst, mint, muxOf, opaque, stringOf } from "./circuit-render-fixtures.js";

interface SexprRow {
  readonly name: string;
  readonly circuit: StaticProv;
  /** Whole-string golden (`toBe`) when present… */
  readonly golden?: string;
  /** …else the fragments a deep circuit pins (`toContain` each). */
  readonly contains?: readonly string[];
}

const SEXPR_ROWS: readonly SexprRow[] = [
  { name: "input", circuit: input("e"), golden: '(input :site 0 :name "e")' },
  {
    name: "mint without closed inputs",
    circuit: mint("infer", "evidence"),
    golden: "(mint :site 0 :head \"infer\" :integrity evidence)",
  },
  {
    name: "mint with closed inputs",
    circuit: mint("now", "ambient", [konst()]),
    golden: "(mint :site 0 :head \"now\" :integrity ambient :closed ((const :site 0)))",
  },
  { name: "const stays a bare leaf — the fabrication mark", circuit: konst(), golden: "(const :site 0)" },
  {
    name: "fused folds N sources",
    circuit: fused(input("a"), input("b")),
    golden: '(fused :site 0 :sources ((input :site 0 :name "a") (input :site 0 :name "b")))',
  },
  {
    name: "mux renders a known key",
    circuit: muxOf("v", input("e")),
    golden: '(mux :site 0 :key "v" :source (input :site 0 :name "e"))',
  },
  {
    name: "mux renders a null (statically-unknown) key",
    circuit: muxOf(null, input("e")),
    golden: "(mux :site 0 :key nil :source (input :site 0 :name \"e\"))",
  },
  {
    name: "build renders every part with its key",
    circuit: build("pair", [
      { key: 0, prov: konst() },
      { key: 1, prov: input("e") },
    ]),
    golden: '(build :site 0 :ctor pair :parts ((:key 0 :prov (const :site 0)) (:key 1 :prov (input :site 0 :name "e"))))',
  },
  {
    name: "string folds ordered runs",
    circuit: stringOf(konst(), input("e")),
    golden: '(string :site 0 :runs ((const :site 0) (input :site 0 :name "e")))',
  },
  {
    name: "choice shows ALL alts, every one gray — no valuation at this layer",
    circuit: choice([input("guard")], [konst(), input("e")]),
    golden:
      '(choice :site 0 :guards ((input :site 0 :name "guard")) :alts ((gray (const :site 0)) (gray (input :site 0 :name "e"))))',
  },
  {
    name: "fan carries its collapse kind",
    circuit: fan(input("xs"), input("x"), "combine"),
    golden: '(fan :site 0 :collapse combine :collection (input :site 0 :name "xs") :body (input :site 0 :name "x"))',
  },
  {
    name: "opaque stays opaque — reason surfaces, never a guess at what it hides",
    circuit: opaque("unknown-head/frobnicate"),
    golden: '(opaque :site 0 :reason "unknown-head/frobnicate")',
  },
  {
    name: "nests arbitrarily deep — a choice of fused mints inside a fan body",
    circuit: fan(input("xs"), choice([input("guard")], [fused(mint("infer", "evidence"), konst())]), "lowered"),
    contains: ["(fan :site 0 :collapse lowered", "(gray (fused :site 0 :sources ((mint :site 0"],
  },
];

describe("circuitToSexpr — every StaticProv kind renders", () => {
  for (const row of SEXPR_ROWS) {
    it(row.name, () => {
      const out = circuitToSexpr(row.circuit);
      if (row.golden !== undefined) expect(out).toBe(row.golden);
      for (const fragment of row.contains ?? []) expect(out).toContain(fragment);
    });
  }
});
