/**
 * circuitToSexpr's own contract (T6b). FIXTURE-FIRST, same discipline as
 * verdict/circuit-verdict.test.ts: every circuit below is HAND-BUILT (never
 * produced by calling `extract`), and `site` is irrelevant to any check here
 * (it rides along for rendering, never compared on) — every node shares one
 * dummy NodeId.
 */
import { describe, expect, it } from "vitest";

import type { NodeId } from "../../coreform/types.js";
import { circuitToSexpr } from "../../model/circuit-sexpr.js";
import type {
  BuildProv,
  ChoiceProv,
  CollapseKind,
  ConstProv,
  FanProv,
  FusedProv,
  Integrity,
  InputProv,
  MintProv,
  MuxProv,
  OpaqueProv,
  StaticProv,
  StringProv,
} from "../../model/static-prov.js";

const S = 0 as NodeId;

const input = (name: string): InputProv => ({ kind: "input", site: S, name });
const mint = (head: string, integrity: Integrity, closed: readonly StaticProv[] = []): MintProv => ({
  kind: "mint",
  site: S,
  head,
  integrity,
  closed,
});
const konst = (): ConstProv => ({ kind: "const", site: S });
const fused = (...sources: StaticProv[]): FusedProv => ({ kind: "fused", site: S, sources });
const muxOf = (k: string | number | null, source: StaticProv): MuxProv => ({ kind: "mux", site: S, key: k, source });
const build = (ctor: BuildProv["ctor"], parts: BuildProv["parts"]): BuildProv => ({ kind: "build", site: S, ctor, parts });
const stringOf = (...runs: StaticProv[]): StringProv => ({ kind: "string", site: S, runs });
const choice = (guards: readonly StaticProv[], alts: readonly StaticProv[]): ChoiceProv => ({
  kind: "choice",
  site: S,
  guards,
  alts,
});
const fan = (collection: StaticProv, body: StaticProv, collapse: CollapseKind): FanProv => ({
  kind: "fan",
  site: S,
  collection,
  body,
  collapse,
});
const opaque = (reason = "test/unmodeled"): OpaqueProv => ({ kind: "opaque", site: S, reason });

describe("circuitToSexpr — every StaticProv kind renders", () => {
  it("input", () => {
    expect(circuitToSexpr(input("e"))).toBe('(input :site 0 :name "e")');
  });

  it("mint, with and without closed inputs", () => {
    expect(circuitToSexpr(mint("infer", "evidence"))).toBe("(mint :site 0 :head \"infer\" :integrity evidence)");
    expect(circuitToSexpr(mint("now", "ambient", [konst()]))).toBe(
      "(mint :site 0 :head \"now\" :integrity ambient :closed ((const :site 0)))",
    );
  });

  it("const stays a bare leaf — the fabrication mark", () => {
    expect(circuitToSexpr(konst())).toBe("(const :site 0)");
  });

  it("fused folds N sources", () => {
    expect(circuitToSexpr(fused(input("a"), input("b")))).toBe(
      '(fused :site 0 :sources ((input :site 0 :name "a") (input :site 0 :name "b")))',
    );
  });

  it("mux renders a known key and a null (statically-unknown) key", () => {
    expect(circuitToSexpr(muxOf("v", input("e")))).toBe('(mux :site 0 :key "v" :source (input :site 0 :name "e"))');
    expect(circuitToSexpr(muxOf(null, input("e")))).toBe("(mux :site 0 :key nil :source (input :site 0 :name \"e\"))");
  });

  it("build renders every part with its key", () => {
    const b = build("pair", [
      { key: 0, prov: konst() },
      { key: 1, prov: input("e") },
    ]);
    expect(circuitToSexpr(b)).toBe(
      '(build :site 0 :ctor pair :parts ((:key 0 :prov (const :site 0)) (:key 1 :prov (input :site 0 :name "e"))))',
    );
  });

  it("string folds ordered runs", () => {
    expect(circuitToSexpr(stringOf(konst(), input("e")))).toBe(
      '(string :site 0 :runs ((const :site 0) (input :site 0 :name "e")))',
    );
  });

  it("choice shows ALL alts, every one gray — no valuation at this layer", () => {
    const c = choice([input("guard")], [konst(), input("e")]);
    expect(circuitToSexpr(c)).toBe(
      '(choice :site 0 :guards ((input :site 0 :name "guard")) :alts ((gray (const :site 0)) (gray (input :site 0 :name "e"))))',
    );
  });

  it("fan carries its collapse kind", () => {
    const f = fan(input("xs"), input("x"), "combine");
    expect(circuitToSexpr(f)).toBe(
      '(fan :site 0 :collapse combine :collection (input :site 0 :name "xs") :body (input :site 0 :name "x"))',
    );
  });

  it("opaque stays opaque — reason surfaces, never a guess at what it hides", () => {
    expect(circuitToSexpr(opaque("unknown-head/frobnicate"))).toBe('(opaque :site 0 :reason "unknown-head/frobnicate")');
  });

  it("nests arbitrarily deep — a choice of fused mints inside a fan body", () => {
    const nested = fan(
      input("xs"),
      choice([input("guard")], [fused(mint("infer", "evidence"), konst())]),
      "lowered",
    );
    expect(circuitToSexpr(nested)).toContain("(fan :site 0 :collapse lowered");
    expect(circuitToSexpr(nested)).toContain("(gray (fused :site 0 :sources ((mint :site 0");
  });
});
