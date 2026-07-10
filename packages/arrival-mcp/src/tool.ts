import { z as sz } from "@here.build/arrival";
import type { Activation } from "@here.build/arrival/capability";
import { Contract, symbol, VectorSpec } from "@here.build/arrival/symbol";
import * as z from "zod";

// CACHE CLASS (R1, arrival-mcp-rework-over-phases.md §2.3, D4 — lazy classification):
// every verb authored through this wrapper is deliberately UNCLASSIFIED (regenerateable,
// the safe default — re-runs on replay, never cache-absorbed). `view` is structurally
// barred here today: the wrapper hardcodes `output: [sz.value]` (the raw escape hatch),
// which the bake-time shape gate (`assertCacheClassShape`) rejects for a serializable
// cache entry. A verb wanting `view` semantics (a boundary snapshot) first narrows its
// output to data codecs, then declares — per capability owner, when the semantics are
// actually wanted; unclassified is CORRECT, not a gap.
export const tool = (tpl: TemplateStringsArray, ...sub: (string | number)[]) => {
  const full = String.raw({ raw: tpl }, ...sub);
  const match = full.match(/^([^:]+):\s*(.*)$/);
  const name = match?.[1] ? match[1].trim() : full.trim();
  const doc = match?.[2] ? match[2].trim() : "";

  return <
    S extends z.ZodRawShape,
    const O extends VectorSpec,
    M extends Record<string, any> = Record<string, any>,
  >(
    contract: Contract<[] /* todo: map S to I */, O, undefined> & {
      shape: S,
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
          // Forwarded (previously declared-and-DROPPED — the live consumer gap the
          // exec-phases design closes): rides the def's metadata bag as a dynamic
          // field; the annotation lift + the DiscoveryTool catalog resolve it against
          // the describe-time activation.
          ...(contract.dynamicDescription === undefined ? {} : { dynamicDescription: contract.dynamicDescription }),
        },
      },
    );
  };
};
