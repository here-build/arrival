import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FIXTURES } from "../__fixtures__/render-graphs.js";
import type { ElkEngine, ElkNode } from "../elk-engine.js";
import { GraphView, SCALE_MAX, structureOf, TAB_CAP } from "../GraphView.js";
import type { RenderFrame, RenderGraph, RenderInstance, RenderState } from "../types.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Counts layouts; returns the input unpositioned (geometry is not under test here). */
const countingEngine = (): ElkEngine & { calls: number } => {
  const engine = {
    calls: 0,
    layout: async (g: ElkNode) => {
      engine.calls++;
      return g;
    },
  };
  return engine;
};

const withStates = (g: RenderGraph, state: RenderState): RenderGraph => ({
  ...g,
  nodes: g.nodes.map((n) => ({ ...n, state })),
});

/** A structurally new graph: one more step under the root. */
const grown = (g: RenderGraph, i: number): RenderGraph => {
  const root = g.nodes[0]!.id;
  return {
    ...g,
    nodes: [
      ...g.nodes,
      {
        kind: "step",
        id: `extra${i}`,
        parent: root,
        span: `x@${i}:1`,
        symbol: "x",
        instance: { key: `x@${i}:1`, ordinals: [], span: `x@${i}:1` },
        input: [],
        output: { hasValue: false },
        state: "running",
        ports: [],
      },
    ],
  };
};

describe("GraphView relayout scheduling", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const render = (graph: RenderGraph, engine: ElkEngine, onLayout?: (ms: number) => void) =>
    act(() => root.render(<GraphView graph={graph} mode="actual" engine={engine} onLayout={onLayout} />));
  const measureLayer = () => container.querySelector(".eg-measure-layer")!.innerHTML;
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it("does not relayout for state-only changes, and reports each layout's duration", async () => {
    const engine = countingEngine();
    const onLayout = vi.fn();
    const g = FIXTURES.planMapFetchActual;
    render(g, engine, onLayout);
    await advance(300);
    expect(engine.calls).toBe(1);
    expect(onLayout).toHaveBeenCalledTimes(1);
    expect(onLayout.mock.calls[0]![0]).toBeGreaterThanOrEqual(0);

    const states: RenderState[] = ["running", "resolved", "rejected", "pending", "resolved"];
    for (const s of states) {
      render(withStates(g, s), engine, onLayout);
      await advance(16);
    }
    await advance(300);
    expect(engine.calls).toBe(1);
  });

  it("lands a structural change within the max wait even while changes keep coming", async () => {
    const engine = countingEngine();
    const g = FIXTURES.planMapFetchActual;
    render(g, engine);
    await advance(300);
    expect(engine.calls).toBe(1);

    // A new structure every 16ms for 400ms: a pure trailing debounce would never fire.
    for (let i = 0; i < 16; i++) {
      render(grown(g, i), engine);
      await advance(16);
    }
    expect(engine.calls).toBeGreaterThanOrEqual(2); // landed by 256ms into the burst
  });

  it("shows a dataflow banner unless dataflow is complete", async () => {
    const engine = countingEngine();
    const g = FIXTURES.planMapFetchActual;
    const withDataflow = (dataflow: RenderGraph["diagnostics"]["dataflow"]): RenderGraph => ({
      ...g,
      diagnostics: { ...g.diagnostics, dataflow },
    });
    render(withDataflow({ status: "unavailable", reason: "wireframe material: γ re-invoke", missing: 0 }), engine);
    expect(container.textContent).toContain("Data edges unavailable for this program (an arrival limitation)");
    expect(container.textContent).not.toContain("wireframe material"); // the raw reason is hover detail
    expect(container.querySelector("[role=status]")?.getAttribute("title")).toBe("wireframe material: γ re-invoke");
    render(withDataflow({ status: "partial", missing: 3 }), engine);
    expect(container.textContent).toContain("Dataflow partial — 3 links could not be traced.");
    render(withDataflow({ status: "partial", missing: 1 }), engine);
    expect(container.textContent).toContain("Dataflow partial — 1 link could not be traced.");
    render(withDataflow({ status: "complete", missing: 0 }), engine);
    expect(container.querySelector("[role=status]")).toBeNull();
    render(g, engine);
    expect(container.querySelector("[role=status]")).toBeNull();
    await advance(300);
  });

  it("renders the latest graph's states and values on the existing layout (no relayout)", async () => {
    const engine = countingEngine();
    const g = FIXTURES.planMapFetchActual;
    render(g, engine);
    await advance(300);
    expect(engine.calls).toBe(1);
    const canvasText = () => container.querySelector("[class*=canvas]")?.textContent ?? "";
    expect(canvasText()).not.toContain("FRESH-VALUE");
    const runningCount = () => container.querySelectorAll("[class*=canvas] [data-state=running]").length;
    const before = runningCount();

    const running = g.nodes.find((n) => n.kind === "step" && n.state === "running")!;
    const next: RenderGraph = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === running.id && n.kind === "step"
          ? { ...n, state: "resolved", output: { hasValue: true, value: "FRESH-VALUE" } }
          : n,
      ),
    };
    render(next, engine);
    // Same frame, no timers advanced: the positioned layer already shows the new content.
    expect(canvasText()).toContain("FRESH-VALUE");
    expect(runningCount()).toBe(before - 1);
    await advance(300);
    expect(engine.calls).toBe(1); // jsdom measures every box as 0×0, so sizes did not change either
  });

  it("STATIC LAYOUT: same structure, different selection / states / values → zero relayouts, identical skeletons", async () => {
    const engine = countingEngine();
    const g = zGraph(5, 0);
    render(g, engine);
    await advance(300);
    expect(engine.calls).toBe(1);
    const skeleton = measureLayer();
    const variants: RenderGraph[] = [
      zGraph(5, 3, true),
      zGraph(9, 8), // more instances arrived: still the same template
      withStates(zGraph(9, 2, true), "rejected"),
      {
        ...g,
        nodes: g.nodes.map((n) =>
          n.kind === "step"
            ? {
                ...n,
                state: "resolved",
                input: n.input.map((a) => ({ ...a, hasValue: true, value: "x".repeat(5000) })),
                output: { hasValue: true, value: { long: "y".repeat(5000) } },
              }
            : n,
        ),
      },
    ];
    for (const v of variants) {
      expect(structureOf(v, "actual")).toBe(structureOf(g, "actual"));
      render(v, engine);
      await advance(16);
      expect(measureLayer()).toBe(skeleton);
    }
    await advance(300);
    expect(engine.calls).toBe(1);
  });
});

const stateAt = (ordinal: number, n: number): RenderState => {
  if (ordinal === 1) return "rejected";
  return ordinal === n - 1 ? "running" : "resolved";
};

/** A par z-frame over one step, `n` instances, painted from `selected`. */
function zGraph(n: number, selected: number, pinned = false): RenderGraph {
  const instances: RenderInstance[] = Array.from({ length: n }, (_, ordinal) => ({
    ordinal,
    state: stateAt(ordinal, n),
  }));
  return {
    nodes: [
      {
        kind: "frame",
        id: "root",
        parent: null,
        span: "root",
        frame: "seq",
        label: "program",
        state: "running",
        ports: [],
      },
      {
        kind: "frame",
        id: "par",
        parent: "root",
        span: "par",
        frame: "par",
        label: "map",
        caption: "in parallel",
        state: "running",
        ports: [{ id: "in:x", side: "in", label: "x" }],
        instances,
        selected,
        pinned,
      },
      {
        kind: "step",
        id: "s",
        parent: "par",
        span: "s",
        symbol: "ask",
        instance: { key: "s", ordinals: [selected], span: "s" },
        input: [{ slot: "arg0", source: "x", hasValue: true, value: `v${selected}` }],
        output: { hasValue: selected !== n - 1, value: `out ${selected}` },
        state: instances[selected]!.state,
        ports: [
          { id: "in:arg0", side: "in" },
          { id: "out", side: "out" },
        ],
      },
    ],
    edges: [{ id: "e", from: { node: "par", port: "in:x" }, to: { node: "s", port: "in:arg0" }, kind: "data" }],
    diagnostics: { unplacedInvocations: 0, droppedEdges: 0, notes: [] },
  };
}

/** Gives every node a box so the positioned layer renders. */
const placingEngine: ElkEngine = {
  layout: async (g: ElkNode) => {
    const place = (n: ElkNode): ElkNode => ({
      ...n,
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      children: n.children?.map(place) ?? [],
      edges: (n.edges ?? []).map((e) => ({
        ...e,
        sections: [{ id: `${e.id}:s`, startPoint: { x: 0, y: 0 }, endPoint: { x: 40, y: 0 } }],
      })),
    });
    return place(g);
  },
};

describe("picker", () => {
  let container: HTMLDivElement;
  let root: Root;
  const engine = placingEngine;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
  const show = async (graph: RenderGraph, onSelect = vi.fn()) => {
    act(() => root.render(<GraphView graph={graph} mode="actual" engine={engine} onSelect={onSelect} />));
    await settle();
    return onSelect;
  };
  const tabs = () => [...container.querySelectorAll<HTMLButtonElement>(".eg-canvas [role=tab]")];

  it("is a tablist of #k tabs; dots mark deviations only; the selected tab is the painted instance", async () => {
    await show(zGraph(4, 2));
    expect(container.querySelector(".eg-canvas [role=tablist]")).not.toBeNull();
    expect(tabs().map((t) => t.textContent)).toEqual(["#1", "#2", "#3", "#4"]);
    expect(tabs().map((t) => t.querySelector<HTMLElement>(".eg-dot")?.dataset.state ?? null)).toEqual([
      null,
      "rejected",
      null,
      "running",
    ]);
    expect(tabs().map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "false", "true", "false"]);
    expect(container.querySelector(".eg-live")).toBeNull(); // following live: nothing to unpin
  });

  it("a click pins (onSelect with the ordinal); arrows move; the live control unpins", async () => {
    const onSelect = await show(zGraph(4, 2));
    act(() => tabs()[0]!.click());
    expect(onSelect).toHaveBeenLastCalledWith("par", 0);
    act(() => {
      tabs()[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(onSelect).toHaveBeenLastCalledWith("par", 3);
    await show(zGraph(4, 0, true), onSelect);
    const live = container.querySelector<HTMLButtonElement>(".eg-live")!;
    expect(live).not.toBeNull();
    act(() => live.click());
    expect(onSelect).toHaveBeenLastCalledWith("par", undefined);
  });

  it(`past ${TAB_CAP} instances it is a stepper ‹ k/N ›`, async () => {
    const onSelect = await show(zGraph(TAB_CAP + 4, 5));
    expect(tabs()).toEqual([]);
    expect(container.querySelector(".eg-canvas .eg-stepper-text")?.textContent).toBe(`6/${TAB_CAP + 4}`);
    act(() => container.querySelector<HTMLButtonElement>(".eg-canvas [aria-label=next]")!.click());
    expect(onSelect).toHaveBeenLastCalledWith("par", 6);
  });

  it("draws no ring on the page's own ports; a transform without a value shows a muted dash", async () => {
    const g = zGraph(3, 0);
    const page = { ...g.nodes[0]!, ports: [{ id: "out", side: "out" as const }] };
    await show({
      ...g,
      nodes: [
        page,
        ...g.nodes.slice(1),
        {
          kind: "transform",
          id: "t",
          parent: "root",
          op: "+",
          text: "(+ x 1)",
          state: "running",
          hasValue: false,
          ports: [{ id: "out", side: "out" }],
        },
      ],
      edges: [
        ...g.edges,
        { id: "res", from: { node: "s", port: "out" }, to: { node: "root", port: "out" }, kind: "data" },
        { id: "res2", from: { node: "t", port: "out" }, to: { node: "s", port: "in:arg0" }, kind: "data" },
      ],
    });
    // the par's `in:x` ring stays, the page's `out` gets none
    expect(container.querySelectorAll(".eg-port").length).toBe(1);
    expect(container.querySelector(".eg-canvas .eg-transform .eg-value-line")?.textContent).toBe("—");
  });

  it("labels a plain wire with its compact expression, in a mono pill", async () => {
    const g = zGraph(3, 0);
    await show({ ...g, edges: g.edges.map((e) => ({ ...e, expr: "(+ i 1)" })) });
    const pill = container.querySelector<HTMLElement>(".eg-canvas .eg-edge-label")!;
    expect(pill.textContent).toBe("(+ i 1)");
    expect(pill.dataset.label).toBe("expr");
  });

  it("falls back to the stepper when the tabs overflow the head, keeping the live control", async () => {
    const tail = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("eg-frame-tail") ? 999 : 0;
      },
    });
    try {
      await show(zGraph(8, 2, true));
      expect(tabs()).toEqual([]);
      expect(container.querySelector(".eg-canvas .eg-stepper-text")?.textContent).toBe("3/8");
      expect(container.querySelector(".eg-canvas .eg-live")).not.toBeNull();
    } finally {
      if (tail) Object.defineProperty(HTMLElement.prototype, "scrollWidth", tail);
      else delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
    }
  });

  it("reserves a constant picker room in the measured head of a z-frame (actual mode only)", async () => {
    const room = () => container.querySelectorAll(".eg-measure-layer .eg-picker-room").length;
    await show(zGraph(2, 0));
    expect(room()).toBe(1);
    const two = container.querySelector(".eg-measure-layer")!.innerHTML;
    await show(zGraph(TAB_CAP + 9, 3, true));
    expect(container.querySelector(".eg-measure-layer")!.innerHTML).toBe(two);
    act(() => root.render(<GraphView graph={zGraph(2, 0)} mode="potential" engine={engine} />));
    expect(room()).toBe(0);
  });

  it("potential mode has no picker", async () => {
    const g = zGraph(3, 0);
    act(() => root.render(<GraphView graph={g} mode="potential" engine={engine} />));
    await settle();
    expect(container.querySelector(".eg-canvas")).not.toBeNull();
    expect(container.querySelector(".eg-tabs")).toBeNull();
  });
});

describe("structureOf", () => {
  it("ignores selection, instances, states and values; sees transforms and projection paths", () => {
    const g = zGraph(3, 0);
    expect(structureOf(zGraph(7, 6, true), "actual")).toBe(structureOf(g, "actual"));
    const withTransform: RenderGraph = {
      ...g,
      nodes: [
        ...g.nodes,
        {
          kind: "transform",
          id: "t",
          parent: "par",
          op: "+",
          text: "(+ x 1)",
          state: "potential",
          hasValue: false,
          ports: [],
        },
      ],
    };
    expect(structureOf(withTransform, "actual")).not.toBe(structureOf(g, "actual"));
    const otherText: RenderGraph = {
      ...withTransform,
      nodes: withTransform.nodes.map((n) =>
        n.kind === "transform" ? { ...n, text: "(+ x 2)", value: 3, hasValue: true } : n,
      ),
    };
    expect(structureOf(otherText, "actual")).not.toBe(structureOf(withTransform, "actual"));
    const projected: RenderGraph = { ...g, edges: g.edges.map((e) => ({ ...e, path: [{ field: ":url" }] })) };
    expect(structureOf(projected, "actual")).not.toBe(structureOf(g, "actual"));
    const frame = g.nodes[1] as RenderFrame;
    expect(
      structureOf({ ...g, nodes: [g.nodes[0]!, { ...frame, caption: "in series" }, g.nodes[2]!] }, "actual"),
    ).not.toBe(structureOf(g, "actual"));
  });
});

describe("zoom", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const boxes = () =>
    [...container.querySelectorAll<HTMLElement>(".eg-canvas > [data-state]")].map((el) => el.getAttribute("style"));
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`.eg-zoom [aria-label="${label}"]`)!;

  it("is view-only: the canvas scales and the spacer follows, the boxes and the layout stay", async () => {
    const engine = { calls: 0, layout: (g: ElkNode) => (engine.calls++, placingEngine.layout(g)) };
    act(() => root.render(<GraphView graph={FIXTURES.planMapFetchActual} mode="actual" engine={engine} />));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    const [before, calls] = [boxes(), engine.calls];
    const canvas = container.querySelector<HTMLElement>(".eg-canvas")!;
    const extent = container.querySelector<HTMLElement>(".eg-extent")!;
    expect(button("reset zoom to 100%").textContent).toBe("100%");
    expect(canvas.style.transform).toBe("scale(1)");
    const width = Number.parseFloat(extent.style.width);

    act(() => button("zoom in").click());
    expect(button("reset zoom to 100%").textContent).toBe("125%");
    expect(canvas.style.transform).toBe("scale(1.25)");
    expect(Number.parseFloat(extent.style.width)).toBeCloseTo(width * 1.25);
    // The measuring layer is outside the scaler, so it keeps measuring at scale 1.
    expect(canvas.querySelector(".eg-measure-layer")).toBeNull();
    for (let i = 0; i < 20; i++) act(() => button("zoom in").click());
    expect(canvas.style.transform).toBe(`scale(${SCALE_MAX})`);
    expect(button("zoom in").disabled).toBe(true);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(boxes()).toEqual(before);
    expect(engine.calls).toBe(calls);

    act(() => button("reset zoom to 100%").click());
    expect(canvas.style.transform).toBe("scale(1)");
    expect(button("zoom out")).not.toBeNull();
    expect(button("fit to view")).not.toBeNull();
  });
});
