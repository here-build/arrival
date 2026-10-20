/**
 * ExecutionGraph — what an arrival program does over a set of named symbols.
 *
 * `mode: "potential"` answers "what will this program do": every call site of a designated
 * symbol, inside the control structures that decide how often and in what order it runs, wired
 * by the dataflow between them. `mode: "actual"` answers "what has it done / is it doing": the
 * same graph painted from a live trace — values on every step, and each par / loop / recursion
 * painted from one of its instances (a track, an iteration, a depth): the one the reader picked,
 * else the one the run is at. The layout is the plan's: a run and a pick only repaint it.
 *
 * Contract:
 * - One program text, one parse. `program` must be exactly the text the traced run executes:
 *   plan and trace meet by source span.
 * - One fresh trace per run, ideally an `ExecutionCapture` (`createExecutionCapture(symbols)`
 *   passed as the run's `tap`) — it keeps operand and result values the plain trace prunes.
 *   For a long-lived trace pass `since`, the first invocation id of the run to show.
 * - Functions defined by an EARLIER run are invisible: arrival captures the tap when a closure
 *   is defined, so their bodies report into that run's trace.
 * - `outcome` is the run promise's state: the trace alone cannot tell that a run ended, so steps
 *   still running when the run rejects or is cancelled read `cancelled` only once it is passed.
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type LexicalScope, parse } from "@here.build/arrival";
import type { EvalTrace } from "@here.build/arrival/provenance";
import { reaction } from "mobx";

import { buildPlan } from "./build-plan.js";
import { ExecutionCapture } from "./capture.js";
import { attachDataflow } from "./dataflow.js";
import type { ElkEngine } from "./elk-engine.js";
import { GraphView, type StepContentProps } from "./GraphView.js";
import type { Plan, Vocabulary } from "./plan.js";
import { ProgressProjector, type RunOutcome } from "./progress.js";
import { retainedSpans, toRenderGraph } from "./render-graph.js";
import type { GraphMode, RenderGraph } from "./types.js";

export interface ExecutionGraphProps {
  /** The program text — exactly what the traced run executes. */
  program: string;
  /** The designated symbols: the call sites the graph is about. */
  symbols: readonly string[];
  /** `loadVocabulary(capabilities)` for the capabilities the program runs with. */
  vocabulary: Vocabulary;
  /** The scope the program runs in, for functions bound there rather than in the text. */
  scope?: LexicalScope;
  mode: GraphMode;
  /** Actual mode: the run's trace — an `ExecutionCapture` carries values. */
  trace?: EvalTrace;
  /** The run promise's state. */
  outcome?: RunOutcome;
  /** First invocation id of this run, for a trace that holds earlier runs. */
  since?: number;
  /** Renders a step box's contents; chrome, ports and edges stay the graph's. */
  renderNode?: (p: StepContentProps) => ReactNode;
  engine?: ElkEngine;
  /** The run's abort signal: an abort rejection carrying its `reason` reads as cancelled. */
  signal?: AbortSignal;
}

type Planned = { readonly plan: Plan } | { readonly error: string };

/** Throttle bounds: the next build waits at least as long as the last rebuild took — the build
 *  itself and the view's layout of the previous graph, whichever is longer. */
const MIN_INTERVAL_MS = 16;
const MAX_INTERVAL_MS = 1000;

const NO_SELECTION: ReadonlyMap<string, number> = new Map();

const message = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

function usePlan(
  program: string,
  symbols: readonly string[],
  vocabulary: Vocabulary,
  scope: LexicalScope | undefined,
): Planned | undefined {
  const [planned, setPlanned] = useState<Planned>();
  const symbolsKey = symbols.join("\u0000");
  useEffect(() => {
    let cancelled = false;
    const set = new Set(symbolsKey === "" ? [] : symbolsKey.split("\u0000"));
    const run = async (): Promise<void> => {
      let result: Planned;
      try {
        const forms = await parse(program);
        const skeleton = buildPlan({ forms, symbols: set, vocabulary, ...(scope ? { scope } : {}) });
        result = { plan: await attachDataflow(skeleton, { forms, symbols: set, vocabulary }) };
      } catch (error) {
        result = { error: message(error) };
      }
      if (!cancelled) setPlanned(result);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [program, symbolsKey, vocabulary, scope]);
  return planned;
}

/** The live graph: a projector per (plan, trace), rebuilt on trace ticks under an adaptive
 *  throttle — the next build no sooner than max(last build cost, last layout cost) (16 ms – 1 s);
 *  the trailing tick always lands. `onLayout` takes the view's layout measurement. */
function useActualGraph(
  plan: Plan | undefined,
  trace: EvalTrace | undefined,
  options: {
    symbols: readonly string[];
    since: number | undefined;
    outcome: RunOutcome | undefined;
    selection: ReadonlyMap<string, number>;
    signal: AbortSignal | undefined;
  },
): { graph: RenderGraph | undefined; onLayout: (ms: number) => void } {
  const [graph, setGraph] = useState<RenderGraph>();
  const layoutCost = useRef(0);
  const onLayout = useCallback((ms: number) => {
    layoutCost.current = ms;
  }, []);
  const projector = useRef<{ p: ProgressProjector; schedule: () => void; now: () => void } | null>(null);
  // The outcome a NEW projector starts from; later changes reach the live one through `settle`.
  const outcome = useRef(options.outcome);
  const { since, signal } = options;
  // Read at build time: a pick repaints the next build, never re-creates the projector.
  const selection = useRef(options.selection);
  const symbolsKey = options.symbols.join("\u0000");

  useEffect(() => {
    outcome.current = options.outcome;
  }, [options.outcome]);

  useEffect(() => {
    if (!plan || !trace) return;
    const symbols = symbolsKey === "" ? [] : symbolsKey.split("\u0000");
    // Transform results the trace would prune: retained from here on (earlier exits are lost).
    if (trace instanceof ExecutionCapture) trace.retainSpans(retainedSpans(plan));
    const p = new ProgressProjector(plan, trace, {
      symbols,
      ...(since === undefined ? {} : { since }),
      ...(outcome.current ? { outcome: outcome.current } : {}),
      ...(signal ? { signal } : {}),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = -Infinity;
    let cost = MIN_INTERVAL_MS;
    let disposed = false;
    const build = () => {
      clearTimeout(timer);
      timer = undefined;
      if (disposed) return;
      const t0 = performance.now();
      setGraph(toRenderGraph(plan, p.update(), { selection: selection.current }));
      last = performance.now();
      cost = last - t0;
    };
    const schedule = () => {
      if (timer !== undefined || disposed) return;
      const interval = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, cost, layoutCost.current));
      timer = setTimeout(build, Math.max(0, last + interval - performance.now()));
    };
    projector.current = { p, schedule, now: build };
    // `revision` moves on every enter and exit; a plain trace only ticks `entries` on enter.
    const dispose = reaction(
      () => (trace instanceof ExecutionCapture ? trace.revision : (trace as unknown as { entries: number }).entries),
      schedule,
      { fireImmediately: true },
    );
    return () => {
      disposed = true;
      dispose();
      clearTimeout(timer);
      projector.current = null;
    };
  }, [plan, trace, since, symbolsKey, signal]);

  // A pick is paint-only (the structure is the plan's): rebuild at once.
  useEffect(() => {
    if (selection.current === options.selection) return;
    selection.current = options.selection;
    projector.current?.now();
  }, [options.selection]);

  useEffect(() => {
    const cur = projector.current;
    if (!cur || !options.outcome || cur.p.outcome === options.outcome) return;
    cur.p.settle(options.outcome);
    cur.schedule();
  }, [options.outcome]);

  // No plan or no trace: no graph, whatever an earlier projector built.
  return { graph: plan && trace ? graph : undefined, onLayout };
}

export function ExecutionGraph({
  program,
  symbols,
  vocabulary,
  scope,
  mode,
  trace,
  outcome,
  since,
  renderNode,
  engine,
  signal,
}: ExecutionGraphProps) {
  const planned = usePlan(program, symbols, vocabulary, scope);
  const plan = planned && "plan" in planned ? planned.plan : undefined;
  // The reader's picks, by selection key (the z-frame's plan key) — for this plan and trace only.
  const [picked, setPicked] = useState<{ plan?: Plan; trace?: EvalTrace; selection: ReadonlyMap<string, number> }>({
    selection: NO_SELECTION,
  });
  const selection = picked.plan === plan && picked.trace === trace ? picked.selection : NO_SELECTION;
  const potential = useMemo(() => (plan ? toRenderGraph(plan) : undefined), [plan]);
  const { graph: actual, onLayout } = useActualGraph(
    mode === "actual" ? plan : undefined,
    mode === "actual" ? trace : undefined,
    {
      symbols,
      since,
      outcome,
      selection,
      signal,
    },
  );
  // A pick goes under the frame's selection key (its plan key, depth-qualified inside a
  // recursion level) as the painted graph names it.
  const onSelect = useCallback(
    (frameId: string, ordinal: number | undefined) => {
      const frame = actual?.nodes.find((n) => n.id === frameId);
      const key = (frame?.kind === "frame" ? frame.selectionKey : undefined) ?? frameId;
      setPicked((prev) => {
        const next = new Map(prev.plan === plan && prev.trace === trace ? prev.selection : NO_SELECTION);
        if (ordinal === undefined) next.delete(key);
        else next.set(key, ordinal);
        return { ...(plan ? { plan } : {}), ...(trace ? { trace } : {}), selection: next };
      });
    },
    [plan, trace, actual],
  );

  if (planned && "error" in planned) {
    return (
      <div className="eg-message" data-tone="danger" role="alert">
        cannot plan this program — {planned.error}
      </div>
    );
  }
  // Actual mode before a run (or before its first tick): the plan itself.
  const graph = (mode === "actual" ? actual : undefined) ?? potential;
  if (!graph) return null;
  return (
    <GraphView
      graph={graph}
      mode={mode}
      {...(mode === "actual" ? { onLayout, onSelect } : {})}
      {...(renderNode ? { renderNode } : {})}
      {...(engine ? { engine } : {})}
    />
  );
}
