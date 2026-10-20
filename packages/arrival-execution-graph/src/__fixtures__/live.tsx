/**
 * The live harness the ExecutionGraph stories share: real arrival programs over program-defined
 * designated functions, run against the held/released `io` host port of the test harness (or a
 * story's own `CapabilityPack`, whose host calls park in the same `Gate`). In
 * actual mode the program RUNS with an `ExecutionCapture`; every `io` call parks and one is
 * released every `tick` ms, out of order, so progress animates. `cancelAfter` aborts the run
 * mid-flight through its real `AbortController`: arrival rejects every parked call with the abort
 * reason, the run settles `cancelled`, and — given the same signal — progress reads those steps
 * as `cancelled`.
 */
import { type ReactNode, useEffect, useState } from "react";
import { disposeRunContext, type EnvCapability, execState, LexicalScope } from "@here.build/arrival";

import { Gate, ioCapability } from "../__tests__/program-harness.js";
import { createExecutionCapture, type ExecutionCapture } from "../capture.js";
import { ExecutionGraph } from "../ExecutionGraph.js";
import type { StepContentProps } from "../GraphView.js";
import type { Vocabulary } from "../plan.js";
import type { RunOutcome } from "../progress.js";
import type { GraphMode } from "../types.js";
import { loadVocabulary } from "../vocabulary.js";

/** Designated functions, all program-defined over the `io` / `fail` host ports (io: s → "s!"). */
export const PRELUDE = `(define (ask p) (io p))
(define (fetch u) (io (string-append "f:" u)))
(define (pred s) (equal? (io s) "yes!"))
(define (boom s) (fail s))
`;
export const SYMBOLS = ["ask", "fetch", "pred", "boom"];

/** What a live story runs against: host functions whose calls park in the run's `Gate`, the
 *  program text prepended to every story, and the symbols designated by default. */
export interface CapabilityPack {
  readonly prelude: string;
  readonly symbols: readonly string[];
  /** A fresh capability for one run (and once, with a throwaway gate, for the vocabulary). */
  capability(gate: Gate): EnvCapability;
}

/** The constructs pack: the `io` / `fail` test ports and the prelude over them. */
export const IO_PACK: CapabilityPack = { prelude: PRELUDE, symbols: SYMBOLS, capability: ioCapability };

const vocabularies = new WeakMap<CapabilityPack, Promise<Vocabulary>>();
function useVocabulary(pack: CapabilityPack): Vocabulary | undefined {
  const [v, setV] = useState<Vocabulary>();
  useEffect(() => {
    let loaded = vocabularies.get(pack);
    if (!loaded) {
      loaded = loadVocabulary([pack.capability(new Gate())]);
      vocabularies.set(pack, loaded);
    }
    void loaded.then(setV);
  }, [pack]);
  return v;
}

export interface LiveProps {
  /** Program body; the prelude defining the designated functions is prepended. */
  program: string;
  mode: GraphMode;
  /** Extra designated symbols (e.g. a program-defined function that should read as one). */
  symbols?: string[];
  /** Release one held host call every `tick` ms. */
  tick: number;
  /** Cancel the run this many ms after it started. */
  cancelAfter?: number;
  renderNode?: (p: StepContentProps) => ReactNode;
  /** The host the program runs against (default: the constructs' `io` pack). */
  pack?: CapabilityPack;
}

export function LiveExecutionGraph({
  program,
  mode,
  symbols = [],
  tick,
  cancelAfter,
  renderNode,
  pack = IO_PACK,
}: LiveProps) {
  const vocab = useVocabulary(pack);
  const src = pack.prelude + program;
  const allSymbols = [...pack.symbols, ...symbols];
  const symbolsKey = allSymbols.join(" ");
  const [runId, setRunId] = useState(0);
  const [run, setRun] = useState<{ trace: ExecutionCapture; outcome: RunOutcome; signal: AbortSignal }>();

  useEffect(() => {
    if (mode !== "actual") return;
    const gate = new Gate();
    gate.hold = true;
    const trace = createExecutionCapture(symbolsKey.split(" "));
    const abort = new AbortController();
    let outcome: RunOutcome = "running";
    const settle = (o: RunOutcome) => {
      if (outcome !== "running") return;
      outcome = o;
      setRun({ trace, outcome: o, signal: abort.signal });
    };
    // The run is the external system this effect starts; its trace must reach render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRun({ trace, outcome, signal: abort.signal });
    void (async () => {
      try {
        const state = await execState(src, {
          scope: LexicalScope.fresh("story"),

          tap: trace as any,
          capabilities: [pack.capability(gate)],
          config: {},
          signal: abort.signal,
        });
        settle("resolved");
        await disposeRunContext(state.runCtx);
      } catch {
        settle(abort.signal.aborted ? "cancelled" : "rejected");
      }
    })();
    // Release out of order (a stride through the parked calls), so tracks finish shuffled.
    let stride = 0;
    const timer = setInterval(() => {
      if (gate.held.length === 0 || outcome !== "running") return;
      stride += 3;
      gate.release(gate.held[stride % gate.held.length]!.arg);
    }, tick);
    const cancel = cancelAfter === undefined ? undefined : setTimeout(() => abort.abort(), cancelAfter);
    return () => {
      clearInterval(timer);
      clearTimeout(cancel);
      if (outcome === "running") abort.abort();
      outcome = "cancelled";
    };
  }, [src, mode, tick, cancelAfter, runId, symbolsKey, pack]);

  if (!vocab) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%", height: "100%" }}>
      {mode === "actual" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button type="button" onClick={() => setRunId((n) => n + 1)}>
            Run again
          </button>
          <span data-outcome={run?.outcome}>{run?.outcome}</span>
        </div>
      )}
      <ExecutionGraph
        program={src}
        symbols={allSymbols}
        vocabulary={vocab}
        mode={mode}
        {...(mode === "actual" && run ? { trace: run.trace, outcome: run.outcome, signal: run.signal } : {})}
        {...(renderNode ? { renderNode } : {})}
      />
    </div>
  );
}

/** Shared Storybook controls for the live stories. */
export const liveArgTypes = {
  mode: { control: "inline-radio", options: ["potential", "actual"] },
  tick: { control: { type: "range", min: 20, max: 2000, step: 20 } },
  program: { control: "text" },
} as const;

export const liveDecorator = (Story: () => ReactNode) => (
  <div style={{ width: "100vw", height: "100vh" }}>{Story()}</div>
);
