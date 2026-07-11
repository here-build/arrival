import { z as sz } from "@here.build/arrival";
import type { Activation } from "@here.build/arrival/capability";
import { Contract, symbol, VectorSpec } from "@here.build/arrival/symbol";
import * as z from "zod";

/** Parse `"name: human doc"` off a tagged-template head — shared by every `tool.*` factory
 *  arm (bare `tool` included) so all five read the same head shape. */
function parseHead(tpl: TemplateStringsArray, sub: (string | number)[]): { name: string; doc: string } {
  const full = String.raw({ raw: tpl }, ...sub);
  const match = full.match(/^([^:]+):\s*(.*)$/);
  return { name: match?.[1] ? match[1].trim() : full.trim(), doc: match?.[2] ? match[2].trim() : "" };
}

/** The shared per-verb metadata bag every `tool.*` factory arm writes onto the baked def,
 *  beside `description` (parsed off the tagged-template head — never a `meta` field, so a
 *  verb can't declare two conflicting descriptions).
 *
 *  `isTool: true` is the STATIC exposure flag (arrival-mcp-extended-capability.md §2.5): a
 *  verb so marked is BOTH a declared action AND (once a runner derives `tools/list` from it)
 *  its own structured MCP tool. Boolean, never a fn — `tools/list` membership must be stable
 *  data (a per-read exposure flip would make the catalog lie between list and call).
 *
 *  `dynamicDescription` is the A2 read-time channel: resolved lazily, per catalog read (no
 *  memo), against the OWNING capability's describe-ambient `Activation` — the same channel
 *  bare `tool``` already forwards (`dynamic-metadata.test.ts` pins its end-to-end path).
 *
 *  Anything else (`risky`, a dashboard grouping tag, …) rides the bag INERT — a plain data
 *  field the catalog carries but assigns no meaning to unless a specific reader (e.g. the
 *  `risky` convention `tool.risky` stamps) declares one. */
export interface ToolMeta {
  isTool?: true;
  dynamicDescription?: (this: Activation<any, any>) => string | undefined | Promise<string | undefined>;
  [key: string]: unknown;
}

// ── tool`` — UNCLASSIFIED (regenerateable, the safe default) ───────────────────────────────
//
// Every verb authored through this bare arm is deliberately UNCLASSIFIED: re-runs on replay,
// never cache-absorbed. `view` is structurally barred here — this arm hardcodes
// `output: [sz.value]` (the raw escape hatch), which the bake-time shape gate
// (`assertCacheClassShape`) rejects for a serializable cache entry. A verb wanting `view`/
// `pure`/`effect` semantics reaches for the matching `tool.*` arm below instead — unclassified
// is the CORRECT default here, not a gap this file needs to close.
function toolFn<S extends z.ZodRawShape, const O extends VectorSpec, M extends Record<string, any> = Record<string, any>>(
  tpl: TemplateStringsArray,
  ...sub: (string | number)[]
) {
  const { name, doc } = parseHead(tpl, sub);
  return (
    contract: Contract<[] /* todo: map S to I */, O, undefined> & {
      shape: S;
      /** A DYNAMIC metadata field (exec-phases-and-dynamic-metadata.md §2.7): resolved
       *  lazily at describe/catalog time against the assembly's activation (`this` —
       *  host config + host resources; actor args don't exist at describe time), per
       *  read, no memo. Resolving `undefined` falls back to the static `description`
       *  and is NOT flagged session-generated (the honest-failure contract). */
      dynamicDescription?: (this: Activation<any, any>) => string | undefined | Promise<string | undefined>;
    },
    impl: (args: any) => any,
  ) => {
    const shape: S = contract.shape;
    const hasArgs = Object.keys(shape).length > 0;

    return symbol.rosetta`${name}: ${doc}`(
      {
        input: [],
        inputRest: hasArgs ? shape : {},
        output: [sz.value],
      },
      (argsObj: any) => impl(argsObj),
      {
        metadata: {
          inputSchema: contract.shape,
          description: doc,
          // Rides the def's metadata bag as a dynamic field; the annotation lift +
          // the DiscoveryTool catalog resolve it against the describe-time activation.
          ...(contract.dynamicDescription === undefined ? {} : { dynamicDescription: contract.dynamicDescription }),
        },
      },
    );
  };
}

/** `tool.view`` — a boundary snapshot worth persisting (cross-run cacheable, R2 substrate
 *  inherited whole: record-mode overwrite, replay-mode serve, single-flight). DEMANDS a real
 *  output codec vector — unlike bare `tool``, `output` is REQUIRED here, never the `[sz.value]`
 *  escape hatch, because the `assertCacheClassShape` gate throws at bake on a `view`
 *  whose contract carries a `z.value`/`z.lambda` slot (a cache entry must serialize). */
function toolView<S extends z.ZodRawShape, const O extends VectorSpec>(
  tpl: TemplateStringsArray,
  ...sub: (string | number)[]
) {
  const { name, doc } = parseHead(tpl, sub);
  return (contract: { shape: S; output: O }, impl: (args: any) => any, meta: ToolMeta = {}) => {
    const shape: S = contract.shape;
    const hasArgs = Object.keys(shape).length > 0;
    return symbol.rosetta`${name}: ${doc}`(
      {
        input: [],
        inputRest: hasArgs ? shape : {},
        output: contract.output,
        cacheClass: "view",
      },
      (argsObj: any) => impl(argsObj),
      { metadata: { description: doc, ...meta } },
    );
  };
}

/** `tool.pure`` — deterministic from decoded args (contractually where needed — `infer`'s own
 *  shape is the canon: a provenance SOURCE declaring `cacheClass: "pure"`). Recovery = re-call;
 *  NEVER persisted cross-run. No shape gate (nothing of it is stored) — `output` stays optional
 *  and defaults to the `[sz.value]` escape hatch, same default bare `tool`` hardcodes, for a
 *  verb with nothing narrower to declare. */
function toolPure<S extends z.ZodRawShape, const O extends VectorSpec>(
  tpl: TemplateStringsArray,
  ...sub: (string | number)[]
) {
  const { name, doc } = parseHead(tpl, sub);
  return (contract: { shape: S; output?: O }, impl: (args: any) => any, meta: ToolMeta = {}) => {
    const shape: S = contract.shape;
    const hasArgs = Object.keys(shape).length > 0;
    return symbol.rosetta`${name}: ${doc}`(
      {
        input: [],
        inputRest: hasArgs ? shape : {},
        output: contract.output ?? [sz.value],
        cacheClass: "pure",
      },
      (argsObj: any) => impl(argsObj),
      { metadata: { description: doc, ...meta } },
    );
  };
}

/** `tool.effect`` — a mutation verb. `provenance: "sink"` pre-applied; `output` is NOT a
 *  parameter here (void by law — the sink shape gate, `assertProvenanceRoleShape`,
 *  demands no real egress on a `"sink"`-role contract, which is also what makes the run-cache
 *  tombstone-skip sound). A `tool.effect` verb is burst-gatherable by construction: the
 *  effect-burst's gather arm reads `provenance === "sink"` off the bound value, which this
 *  factory stamps unconditionally. */
function toolEffect<S extends z.ZodRawShape>(tpl: TemplateStringsArray, ...sub: (string | number)[]) {
  const { name, doc } = parseHead(tpl, sub);
  return (contract: { shape: S }, impl: (args: any) => any, meta: ToolMeta = {}) => {
    const shape: S = contract.shape;
    const hasArgs = Object.keys(shape).length > 0;
    return symbol.rosetta`${name}: ${doc}`(
      {
        input: [],
        inputRest: hasArgs ? shape : {},
        output: [sz.undefinedResult],
        provenance: "sink",
      },
      (argsObj: any) => impl(argsObj),
      { metadata: { description: doc, ...meta } },
    );
  };
}

/** `tool.risky`` — `tool.effect` plus `risky: true`, riding the SYMBOL METADATA channel
 *  (bake-time metadata stamping — `BakeRuntimeOpts.metadata`). "Danger is an attribute
 *  of the ACTION, not the arguments set": riskiness is STATIC, factory-declared here on every
 *  call this verb ever receives, never something a caller flips via an argument. Delegates to
 *  `tool.effect` verbatim (same sink/void contract) — the only difference is the extra
 *  metadata key. */
function toolRisky<S extends z.ZodRawShape>(tpl: TemplateStringsArray, ...sub: (string | number)[]) {
  const effectFactory = toolEffect<S>(tpl, ...sub);
  return (contract: { shape: S }, impl: (args: any) => any, meta: ToolMeta = {}) =>
    effectFactory(contract, impl, { ...meta, risky: true });
}

/** The `tool` factory family: `tool`` (bare, unclassified) plus three pre-applied arms —
 *  `tool.view` / `tool.pure` / `tool.effect` — and `tool.risky` (a `tool.effect` convenience).
 *  All five are SUGAR over `symbol.rosetta`, same tagged-template head, differing only in
 *  which `Contract` fields + metadata keys they pre-apply (arrival-mcp-extended-capability.md
 *  §2.3). Nothing here is a new symbol kind — a `tool.view` def is byte-shape a
 *  `RosettaSymbolDef` with `cacheClass: "view"`. */
export const tool = Object.assign(toolFn, {
  view: toolView,
  pure: toolPure,
  effect: toolEffect,
  risky: toolRisky,
});
