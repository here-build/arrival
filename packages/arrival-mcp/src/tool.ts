import { z as sz } from "@here.build/arrival";
import { Contract, symbol, VectorSpec } from "@here.build/arrival/symbol";
import * as z from "zod";

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
    contract: Contract</*todo: map S to I*/, O, undefined> & {
      shape: S,
      dynamicDescription?: () => string;
    },
    impl: (args: any) => any,
  ) => {
    const shape: S = contract.shape;
    const hasArgs = Object.keys(shape).length > 0;

    return symbol.rosetta`${name}: ${doc}`(
      {
        input: hasArgs ? sz.kwargs(shape) : sz.kwargs({}),
        output: [sz.value],
      },
      (argsObj: any) => impl(argsObj),
      {
        metadata: {
          inputSchema: contract.shape,
          description: doc,
        },
      },
    );
  };
};
