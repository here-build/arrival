/**
 * Shared hand-built StaticProv constructors for the renderer test twins
 * (`circuit-sexpr.test.ts`, `circuit-mermaid.test.ts`). Same fixture-first
 * discipline as `verdict/circuit-verdict.test.ts`: every circuit is HAND-BUILT
 * (never produced by calling `extract`), and `site` is irrelevant to any
 * rendering check — every node shares one dummy NodeId.
 */
import type { NodeId } from "../../coreform/types.js";
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

export const S = 0 as NodeId;

export const input = (name: string): InputProv => ({ kind: "input", site: S, name });
export const mint = (head: string, integrity: Integrity, closed: readonly StaticProv[] = []): MintProv => ({
  kind: "mint",
  site: S,
  head,
  integrity,
  closed,
});
export const konst = (): ConstProv => ({ kind: "const", site: S });
export const fused = (...sources: StaticProv[]): FusedProv => ({ kind: "fused", site: S, sources });
export const muxOf = (k: string | number | null, source: StaticProv): MuxProv => ({ kind: "mux", site: S, key: k, source });
export const build = (ctor: BuildProv["ctor"], parts: BuildProv["parts"]): BuildProv => ({ kind: "build", site: S, ctor, parts });
export const stringOf = (...runs: StaticProv[]): StringProv => ({ kind: "string", site: S, runs });
export const choice = (guards: readonly StaticProv[], alts: readonly StaticProv[]): ChoiceProv => ({
  kind: "choice",
  site: S,
  guards,
  alts,
});
export const fan = (collection: StaticProv, body: StaticProv, collapse: CollapseKind): FanProv => ({
  kind: "fan",
  site: S,
  collection,
  body,
  collapse,
});
export const opaque = (reason = "test/unmodeled"): OpaqueProv => ({ kind: "opaque", site: S, reason });
