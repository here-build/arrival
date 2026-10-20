/**
 * Hand-built RenderGraphs covering the whole visual palette of the execution graph (v3, fold
 * model): every step state; every area kind in every state; z-frames with their instance strips
 * (every instance state, a strip past the tab cap, `selected`, `pinned`); branch lanes taken /
 * not-taken / undecided; call and designated-function areas, a recursion z-frame with its stub;
 * guard's on-raise lane; transform blocks; projection `path` and `expr` pills; the loop return
 * contour; the dataflow banner; an unplanned step. Each sheet mirrors a small arrival-scheme
 * program (quoted above it); spans are arrival's `head@line:col` (1-based lines, 0-based
 * columns) and ids are plan keys (`callSite▸` inside an inlined call, `#k` per arm, `ƒ<wire>` per
 * transform).
 *
 * The graphs are a palette, not one consistent run: they put states side by side that a single
 * run would show at different moments.
 */
import {
  portIds,
  type RenderEdge,
  type RenderFrame,
  type RenderFrameKind,
  type RenderGraph,
  type RenderNode,
  type RenderPort,
  type RenderState,
  type PathStep,
  type RenderInstance,
  type RenderStep,
  type RenderTransform,
  type SkippedBecause,
} from "../types.js";

const ROOT = "<program>";
const IN = (name: string): RenderPort => ({ id: portIds.param(name), side: "in", label: name });
const OUT: RenderPort = { id: portIds.out, side: "out" };
const CONTROL: RenderPort = { id: portIds.control, side: "control" };
const CLEAN = { unplacedInvocations: 0, droppedEdges: 0, notes: [] };

/** `[source]` = no value yet; `[source, value]` = captured. */
type Arg = [source: string, value?: unknown];

interface StepOpts {
  parent: string;
  symbol: string;
  span: string;
  key?: string;
  ordinals?: number[];
  args: Arg[];
  state: RenderState;
  output?: unknown;
  error?: string;
  unplanned?: boolean;
  skippedBecause?: SkippedBecause;
}

function step(id: string, o: StepOpts): RenderStep {
  return {
    kind: "step",
    id,
    parent: o.parent,
    span: o.span,
    symbol: o.symbol,
    instance: { key: o.key ?? o.span, ordinals: o.ordinals ?? [], span: o.span },
    input: o.args.map(([source, ...v], k) => ({
      slot: `arg${k}`,
      source,
      hasValue: v.length > 0,
      ...(v.length > 0 ? { value: v[0] } : {}),
    })),
    output: {
      hasValue: o.output !== undefined,
      ...(o.output === undefined ? {} : { value: o.output }),
      ...(o.error ? { error: o.error } : {}),
    },
    state: o.state,
    ports: [...o.args.map((_, k): RenderPort => ({ id: portIds.arg(k), side: "in" })), OUT],
    ...(o.unplanned ? { unplanned: true } : {}),
    ...(o.skippedBecause ? { skippedBecause: o.skippedBecause } : {}),
  };
}

function frame(
  id: string,
  parent: string | null,
  kind: RenderFrameKind,
  label: string,
  state: RenderState,
  extra: Partial<RenderFrame> = {},
): RenderFrame {
  return { kind: "frame", id, parent, span: extra.span ?? id, frame: kind, label, state, ports: [], ...extra };
}

type End = string | [node: string, port: string];
const endOf = (e: End, port: string) => (typeof e === "string" ? { node: e, port } : { node: e[0], port: e[1] });

const TARGET_PORT: Partial<Record<RenderEdge["kind"], string>> = { order: "order", control: portIds.control };

/** A bare id is the node's `out` (source) / `in:arg0` (target). */
function edge(
  from: End,
  to: End,
  kind: RenderEdge["kind"],
  state: RenderState,
  extra: { label?: string; path?: PathStep[]; expr?: string } = {},
): RenderEdge {
  const f = endOf(from, kind === "order" ? "order" : portIds.out);
  const t = endOf(to, TARGET_PORT[kind] ?? portIds.arg(0));
  return { id: `${f.node}:${f.port}->${t.node}:${t.port}`, from: f, to: t, kind, state, ...extra };
}

/** A compute wire's block: `inputs` producers → `in:0…`, `out` → its consumer. */
function transform(
  id: string,
  parent: string,
  op: string,
  text: string,
  inputs: number,
  state: RenderState,
  value?: unknown,
): RenderTransform {
  return {
    kind: "transform",
    id,
    parent,
    op,
    text,
    state,
    hasValue: value !== undefined,
    ...(value === undefined ? {} : { value }),
    ports: [...Array.from({ length: inputs }, (_, k): RenderPort => ({ id: `in:${k}`, side: "in" })), OUT],
  };
}

/** A z-frame's picker strip: one instance per state, in ordinal order. */
const strip = (states: readonly RenderState[]): RenderInstance[] =>
  states.map((state, ordinal) => ({ ordinal, state }));

// ── Steps: every step state ─────────────────────────────────────────────────────────────────
//   1 (define topic (ask "pick a topic"))
//   2 (define draft (fetch topic))
//   3 (define notes (ask draft))
//   4 (ask (fetch "https://x.example/404"))
//   5 (notify "team")
//   6 (log topic)
// plus an `audit` call the plan did not know (unplanned).

const TOPIC = "Constraint grammars beat utility CSS";

export const steps: RenderGraph = {
  nodes: [
    frame(ROOT, null, "seq", "program", "running", { ports: [OUT] }),
    step("ask@1:14", {
      parent: ROOT,
      symbol: "ask",
      span: "ask@1:14",
      args: [['"pick a topic"', "pick a topic"]],
      state: "resolved",
      output: TOPIC,
    }),
    step("fetch@2:14", {
      parent: ROOT,
      symbol: "fetch",
      span: "fetch@2:14",
      args: [["topic", TOPIC]],
      state: "running",
    }),
    step("ask@3:14", { parent: ROOT, symbol: "ask", span: "ask@3:14", args: [["draft"]], state: "pending" }),
    step("fetch@4:5", {
      parent: ROOT,
      symbol: "fetch",
      span: "fetch@4:5",
      args: [['"https://x.example/404"', "https://x.example/404"]],
      state: "rejected",
      error: "HTTP 404 Not Found",
    }),
    step("ask@4:0", {
      parent: ROOT,
      symbol: "ask",
      span: "ask@4:0",
      args: [['(fetch "https://x.example/404")']],
      state: "cancelled",
    }),
    step("notify@5:0", {
      parent: ROOT,
      symbol: "notify",
      span: "notify@5:0",
      args: [['"team"']],
      state: "skipped",
      skippedBecause: "not-reached",
    }),
    step("log@6:0", {
      parent: ROOT,
      symbol: "log",
      span: "log@6:0",
      args: [["topic", TOPIC]],
      state: "resolved",
      output: null,
    }),
    step(`${ROOT}~audit@2:30#0`, {
      parent: ROOT,
      symbol: "audit",
      span: "audit@2:30",
      args: [["topic", TOPIC]],
      state: "resolved",
      output: "ok",
      unplanned: true,
    }),
  ],
  edges: [
    edge("ask@1:14", "fetch@2:14", "data", "resolved"),
    edge("fetch@2:14", "ask@3:14", "data", "running"),
    edge("ask@3:14", "fetch@4:5", "order", "pending"),
    edge("fetch@4:5", "ask@4:0", "data", "rejected", { label: '(fetch "https://x.example/404")' }),
    edge("ask@4:0", "notify@5:0", "order", "cancelled"),
    edge("notify@5:0", "log@6:0", "order", "skipped"),
    edge("ask@1:14", "log@6:0", "data", "resolved"),
  ],
  diagnostics: CLEAN,
};

// ── Areas: every area kind in every state ────────────────────────────────────────────────────
// A notional program, one line per row: `${head}@${row}:${col}` spans, one column per state,
// chained by `order` edges so each row reads left to right. z-frames carry their picker strip,
// consistent with their state; branches are always lanes.

const STATES = ["pending", "running", "resolved", "rejected", "cancelled", "skipped"] as const;
type AreaKind = Exclude<RenderFrameKind, "arm">;
const HEAD: Record<AreaKind, string> = {
  seq: "and",
  par: "map",
  loop: "let",
  branch: "if",
  call: "summarize",
  callback: "for-each",
};
const ROWS: readonly AreaKind[] = ["seq", "par", "loop", "branch", "call", "callback"];
const CAPTION: Partial<Record<AreaKind, string>> = {
  par: "in parallel",
  loop: "in loop",
  callback: "×? via for-each",
};
/** The strip a z-frame in `state` would show. */
const STRIP: Record<(typeof STATES)[number], RenderState[]> = {
  pending: [],
  running: ["resolved", "running", "pending"],
  resolved: ["resolved", "resolved", "resolved"],
  rejected: ["resolved", "rejected", "resolved"],
  cancelled: ["resolved", "cancelled", "cancelled"],
  skipped: [],
};

const OUTCOME: Partial<Record<RenderState, { output?: unknown; error?: string }>> = {
  resolved: { output: "q!" },
  rejected: { error: "HTTP 500" },
};

/** The smallest body: one `ask` in `state`. */
const probe = (id: string, parent: string, state: RenderState, skippedBecause?: SkippedBecause): RenderStep =>
  step(id, {
    parent,
    symbol: "ask",
    span: id,
    args: [state === "resolved" || state === "rejected" || state === "running" ? ['"q"', "q"] : ['"q"']],
    state,
    ...OUTCOME[state],
    ...(skippedBecause ? { skippedBecause } : {}),
  });

/** A cell's skip reason: the cell after a cancelled one — the run never got there. */
const reachOf = (state: RenderState): { skippedBecause?: SkippedBecause } =>
  state === "skipped" ? { skippedBecause: "not-reached" } : {};

/** The strip and the painted ordinal of a z-frame in `state` (follow live). */
function picker(state: (typeof STATES)[number]): Partial<RenderFrame> {
  const instances = STRIP[state];
  if (instances.length === 0) return {};
  const deviation = instances.findIndex((i) => i === "running" || i === "rejected" || i === "cancelled");
  return { instances: strip(instances), selected: deviation === -1 ? instances.length - 1 : deviation };
}

/** A condition's two lanes: the taken lane painted in the branch's state, the other not taken;
 *  an undecided (pending) or unreached branch paints both alike. */
function lanes(span: string, row: number, col: number, state: (typeof STATES)[number]): RenderNode[] {
  const decided = state !== "pending" && state !== "skipped";
  const other: RenderState = decided ? "skipped" : state;
  const otherWhy = decided ? { skippedBecause: "not-taken" as const } : reachOf(state);
  return [
    frame(`${span}#0`, span, "arm", "then", state, { span, ...reachOf(state) }),
    probe(`ask@${row}:${col * 12 + 4}`, `${span}#0`, state, reachOf(state).skippedBecause),
    frame(`${span}#1`, span, "arm", "else", other, { span, ...otherWhy }),
    probe(`ask@${row}:${col * 12 + 8}`, `${span}#1`, other, otherWhy.skippedBecause),
  ];
}

function areaCell(kind: AreaKind, row: number, col: number, state: (typeof STATES)[number]): RenderNode[] {
  const span = `${HEAD[kind]}@${row}:${col * 12}`;
  const z = kind === "par" || kind === "loop" || kind === "callback";
  const area = frame(span, ROOT, kind, kind === "call" ? "summarize" : HEAD[kind], state, {
    ...(CAPTION[kind] ? { caption: CAPTION[kind] } : {}),
    ...(kind === "call" ? { symbol: "summarize", ports: [IN("u"), OUT] } : {}),
    ...(kind === "branch" ? { ports: [CONTROL, OUT] } : {}),
    ...(z ? picker(state) : {}),
    ...reachOf(state),
  });
  if (kind === "branch") return [area, ...lanes(span, row, col, state)];
  return [area, probe(`ask@${row}:${col * 12 + 4}`, span, state, reachOf(state).skippedBecause)];
}

export const areas: RenderGraph = {
  nodes: [
    frame(ROOT, null, "seq", "program", "running"),
    ...ROWS.flatMap((kind, r) => STATES.flatMap((st, c) => areaCell(kind, r + 1, c, st))),
  ],
  edges: ROWS.flatMap((kind, r) =>
    STATES.slice(1).map((_, c) =>
      edge(`${HEAD[kind]}@${r + 1}:${c * 12}`, `${HEAD[kind]}@${r + 1}:${(c + 1) * 12}`, "order", STATES[c]!),
    ),
  ),
  diagnostics: CLEAN,
};

// ── Fold: z-frames and their pickers ─────────────────────────────────────────────────────────
//   1 (define pages (map (lambda (u) (fetch u)) urls))
//   2 (define kept (map (lambda (p) (ask p)) pages))
//   3 (define best (let loop ((n 0) (d (ask "draft")))
//   4   (if (< n 24) (loop (+ n 1) (critique d)) d)))
//   5 (for-each (lambda (p) (store p)) kept)
//   6 (define (deep n) (if (= n 0) (fetch "end") (string-append (ask "x") (deep (- n 1)))))
//   7 (deep 3)

const PAGES = "map@1:13";
const KEPT = "map@2:12";
const LOOP = "let@3:13";
const LOOP_IF = "if@4:2";
const EACH = "for-each@5:0";
const DEEP = "deep@7:0";
const DEEP_IF = `${DEEP}▸if@6:17`;
const STUB = `${DEEP}▸deep@6:68`;

/** Every instance state, deviations scattered (tracks finish in completion order). */
const EIGHT: RenderState[] = [
  "resolved",
  "running",
  "rejected",
  "resolved",
  "cancelled",
  "running",
  "pending",
  "resolved",
];

export const fold: RenderGraph = {
  nodes: [
    frame(ROOT, null, "seq", "program", "running"),
    // Following live: the first running track is painted.
    frame(PAGES, ROOT, "par", "map", "running", {
      caption: "in parallel",
      ports: [IN("u"), OUT],
      instances: strip(EIGHT),
      selected: 1,
      progress: { resolved: 3, running: 2, rejected: 1, pending: 1, cancelled: 1, total: 8 },
    }),
    step("fetch@1:31", {
      parent: PAGES,
      symbol: "fetch",
      span: "fetch@1:31",
      args: [["u", "https://b.example/notes"]],
      state: "running",
    }),
    // Pinned by the reader: the rejected track stays painted while the run goes on.
    frame(KEPT, ROOT, "par", "map", "running", {
      caption: "in parallel",
      ports: [IN("p"), OUT],
      instances: strip(EIGHT),
      selected: 2,
      pinned: true,
      progress: { resolved: 3, running: 2, rejected: 1, pending: 1, cancelled: 1, total: 8 },
    }),
    step("ask@2:29", {
      parent: KEPT,
      symbol: "ask",
      span: "ask@2:29",
      args: [["p", "<html>…"]],
      state: "rejected",
      error: "rate limited (429)",
    }),
    step("ask@3:29", {
      parent: ROOT,
      symbol: "ask",
      span: "ask@3:29",
      args: [['"draft"', "draft"]],
      state: "resolved",
      output: "v0",
    }),
    // 25 iterations: past the tab cap the picker is a stepper; the latest is painted.
    frame(LOOP, ROOT, "loop", "loop", "running", {
      caption: "in loop",
      ports: [IN("n"), IN("d"), OUT],
      instances: strip([...Array.from({ length: 24 }, (): RenderState => "resolved"), "running"]),
      selected: 24,
      progress: { resolved: 24, running: 1, rejected: 0, pending: 0, total: 25 },
    }),
    frame(LOOP_IF, LOOP, "branch", "if", "running", { ports: [OUT] }),
    frame(`${LOOP_IF}#0`, LOOP_IF, "arm", "then", "running", { span: LOOP_IF }),
    step("critique@4:31", {
      parent: `${LOOP_IF}#0`,
      symbol: "critique",
      span: "critique@4:31",
      args: [["d", "v23"]],
      state: "running",
    }),
    frame(`${LOOP_IF}#1`, LOOP_IF, "arm", "else", "pending", { span: LOOP_IF }),
    frame(EACH, ROOT, "callback", "for-each", "running", {
      caption: "×? via for-each",
      ports: [IN("p")],
      instances: strip(["resolved", "resolved", "running"]),
      selected: 2,
      progress: { resolved: 2, running: 1, rejected: 0, pending: 0 },
    }),
    step("store@5:22", { parent: EACH, symbol: "store", span: "store@5:22", args: [["p", "q!"]], state: "running" }),
    // A non-tail recursion is a z-frame of depth levels; the stub inside is the next depth.
    frame(DEEP, ROOT, "call", "deep", "running", {
      symbol: "deep",
      ports: [IN("n"), OUT],
      instances: strip(["running", "running", "running", "resolved"]),
      selected: 1,
      pinned: true,
    }),
    frame(DEEP_IF, DEEP, "branch", "if", "running", { span: "if@6:17", ports: [OUT] }),
    frame(`${DEEP_IF}#0`, DEEP_IF, "arm", "then", "skipped", { span: "if@6:17", skippedBecause: "not-taken" }),
    step(`${DEEP}▸fetch@6:29`, {
      parent: `${DEEP_IF}#0`,
      symbol: "fetch",
      key: `${DEEP}▸fetch@6:29`,
      span: "fetch@6:29",
      args: [['"end"']],
      state: "skipped",
      skippedBecause: "not-taken",
    }),
    frame(`${DEEP_IF}#1`, DEEP_IF, "arm", "else", "running", { span: "if@6:17" }),
    step(`${DEEP}▸ask@6:58`, {
      parent: `${DEEP_IF}#1`,
      symbol: "ask",
      key: `${DEEP}▸ask@6:58`,
      span: "ask@6:58",
      args: [['"x"', "x"]],
      state: "resolved",
      output: "x!",
    }),
    frame(STUB, `${DEEP_IF}#1`, "call", "deep", "running", {
      span: "deep@6:68",
      symbol: "deep",
      collapsed: true,
      ports: [IN("n"), OUT],
    }),
  ],
  edges: [
    edge([PAGES, portIds.param("u")], "fetch@1:31", "data", "running"),
    edge("fetch@1:31", [PAGES, portIds.out], "data", "running"),
    edge([PAGES, portIds.out], [KEPT, portIds.param("p")], "data", "running"),
    edge([KEPT, portIds.param("p")], "ask@2:29", "data", "running"),
    edge("ask@3:29", [LOOP, portIds.param("d")], "data", "resolved"),
    // The loop return: the counter as an `expr` pill, the work as a recur into the contour.
    edge([LOOP, portIds.param("n")], [LOOP, portIds.param("n")], "recur", "running", { expr: "(+ n 1)" }),
    edge([LOOP, portIds.param("d")], "critique@4:31", "data", "running"),
    edge("critique@4:31", [LOOP, portIds.param("d")], "recur", "running"),
    edge([LOOP_IF, portIds.out], [LOOP, portIds.out], "data", "pending"),
    edge([KEPT, portIds.out], [EACH, portIds.param("p")], "data", "running"),
    edge([EACH, portIds.param("p")], "store@5:22", "data", "running"),
    edge(`${DEEP}▸ask@6:58`, STUB, "order", "resolved"),
    edge([DEEP, portIds.param("n")], [STUB, portIds.param("n")], "data", "running", { expr: "(- n 1)" }),
    edge([DEEP_IF, portIds.out], [DEEP, portIds.out], "data", "running"),
  ],
  diagnostics: CLEAN,
};

// ── Control: lanes, calls, guard ─────────────────────────────────────────────────────────────
//   1 (define d (ask "urgent?"))
//   2 (if (:urgent d) (notify d) (archive d))
//   3 (cond ((urgent? d) (notify "now")) ((ask "later?") (schedule "later")) (else (archive d)))
//   4 (if (ask "publish?") (publish d) (archive d))
//   5 (define (summarize u) (ask (fetch u)))
//   6 (summarize "a")
//   7 (guard (e (#t (fetch "recovered"))) (ask "first") (boom "x") (ask "never"))

const IF = "if@2:0";
const COND = "cond@3:0";
const PUB = "if@4:0";
const CALL = "summarize@6:0";
const GUARD = "guard@7:0";
const RAISE = `${GUARD}/raise`;

export const control: RenderGraph = {
  nodes: [
    frame(ROOT, null, "seq", "program", "running"),
    step("ask@1:10", {
      parent: ROOT,
      symbol: "ask",
      span: "ask@1:10",
      args: [['"urgent?"', "urgent?"]],
      state: "resolved",
      output: { urgent: true },
    }),
    // Taken / not taken.
    frame(IF, ROOT, "branch", "if", "resolved", { ports: [CONTROL, OUT] }),
    frame(`${IF}#0`, IF, "arm", "then", "resolved", { span: IF }),
    step("notify@2:17", {
      parent: `${IF}#0`,
      symbol: "notify",
      span: "notify@2:17",
      args: [["d", { urgent: true }]],
      state: "resolved",
      output: "sent",
    }),
    frame(`${IF}#1`, IF, "arm", "else", "skipped", { span: IF, skippedBecause: "not-taken" }),
    step("archive@2:28", {
      parent: `${IF}#1`,
      symbol: "archive",
      span: "archive@2:28",
      args: [["d"]],
      state: "skipped",
      skippedBecause: "not-taken",
    }),
    // A clause whose test ran inside its lane and said no; the else taken.
    step("urgent?@3:8", {
      parent: ROOT,
      symbol: "urgent?",
      span: "urgent?@3:8",
      args: [["d", { urgent: true }]],
      state: "resolved",
      output: false,
    }),
    frame(COND, ROOT, "branch", "cond", "resolved", { ports: [CONTROL, OUT] }),
    frame(`${COND}#0`, COND, "arm", "(urgent? d)", "skipped", { span: COND, skippedBecause: "not-taken" }),
    step("notify@3:21", {
      parent: `${COND}#0`,
      symbol: "notify",
      span: "notify@3:21",
      args: [['"now"']],
      state: "skipped",
      skippedBecause: "not-taken",
    }),
    frame(`${COND}#1`, COND, "arm", '(ask "later?")', "resolved", { span: COND }),
    step("ask@3:37", {
      parent: `${COND}#1`,
      symbol: "ask",
      span: "ask@3:37",
      args: [['"later?"', "later?"]],
      state: "resolved",
      output: false,
    }),
    step("schedule@3:52", {
      parent: `${COND}#1`,
      symbol: "schedule",
      span: "schedule@3:52",
      args: [['"later"']],
      state: "skipped",
      skippedBecause: "not-taken",
    }),
    frame(`${COND}#2`, COND, "arm", "else", "resolved", { span: COND }),
    step("archive@3:79", {
      parent: `${COND}#2`,
      symbol: "archive",
      span: "archive@3:79",
      args: [["d"]],
      state: "resolved",
      output: "archived #4512",
    }),
    // Undecided: the selector still runs, both lanes wait.
    step("ask@4:4", {
      parent: ROOT,
      symbol: "ask",
      span: "ask@4:4",
      args: [['"publish?"', "publish?"]],
      state: "running",
    }),
    frame(PUB, ROOT, "branch", "if", "pending", { ports: [CONTROL, OUT] }),
    frame(`${PUB}#0`, PUB, "arm", "then", "pending", { span: PUB }),
    step("publish@4:21", {
      parent: `${PUB}#0`,
      symbol: "publish",
      span: "publish@4:21",
      args: [["d"]],
      state: "pending",
    }),
    frame(`${PUB}#1`, PUB, "arm", "else", "pending", { span: PUB }),
    step("archive@4:32", {
      parent: `${PUB}#1`,
      symbol: "archive",
      span: "archive@4:32",
      args: [["d"]],
      state: "pending",
    }),
    // A program function inlined at its call site; the designated variant leads with its symbol.
    frame(CALL, ROOT, "call", "summarize", "resolved", { ports: [IN("u"), OUT] }),
    step(`${CALL}▸fetch@5:27`, {
      parent: CALL,
      symbol: "fetch",
      key: `${CALL}▸fetch@5:27`,
      span: "fetch@5:27",
      args: [["u", "a"]],
      state: "resolved",
      output: "<html>…",
    }),
    step(`${CALL}▸ask@5:22`, {
      parent: CALL,
      symbol: "ask",
      key: `${CALL}▸ask@5:22`,
      span: "ask@5:22",
      args: [["(fetch u)", "<html>…"]],
      state: "resolved",
      output: "A short summary.",
    }),
    frame("summarize@6:20", ROOT, "call", "summarize", "running", {
      symbol: "summarize",
      span: "summarize@6:20",
      ports: [IN("u"), OUT],
    }),
    step("summarize@6:20▸fetch@5:27", {
      parent: "summarize@6:20",
      symbol: "fetch",
      key: "summarize@6:20▸fetch@5:27",
      span: "fetch@5:27",
      args: [["u", "b"]],
      state: "running",
    }),
    step("summarize@6:20▸ask@5:22", {
      parent: "summarize@6:20",
      symbol: "ask",
      key: "summarize@6:20▸ask@5:22",
      span: "ask@5:22",
      args: [["(fetch u)"]],
      state: "pending",
    }),
    // guard: the body, then its on-raise lane.
    frame(GUARD, ROOT, "seq", "guard", "resolved", { ports: [OUT] }),
    step("ask@7:39", {
      parent: GUARD,
      symbol: "ask",
      span: "ask@7:39",
      args: [['"first"', "first"]],
      state: "resolved",
      output: "first!",
    }),
    step("boom@7:51", {
      parent: GUARD,
      symbol: "boom",
      span: "boom@7:51",
      args: [['"x"', "x"]],
      state: "rejected",
      error: "fail x",
    }),
    step("ask@7:62", {
      parent: GUARD,
      symbol: "ask",
      span: "ask@7:62",
      args: [['"never"']],
      state: "skipped",
      skippedBecause: "not-reached",
    }),
    frame(RAISE, GUARD, "branch", "on raise", "resolved", { span: GUARD, caption: "on raise", ports: [OUT] }),
    frame(`${RAISE}#0`, RAISE, "arm", "handler", "resolved", { span: GUARD }),
    step("fetch@7:16", {
      parent: `${RAISE}#0`,
      symbol: "fetch",
      span: "fetch@7:16",
      args: [['"recovered"', "recovered"]],
      state: "resolved",
      output: "f:recovered!",
    }),
    frame(`${RAISE}#1`, RAISE, "arm", "else", "skipped", { span: GUARD, skippedBecause: "not-taken" }),
  ],
  edges: [
    edge("ask@1:10", IF, "control", "resolved", { path: [{ field: "urgent" }] }),
    edge("ask@1:10", "notify@2:17", "data", "resolved"),
    edge("notify@2:17", [IF, portIds.out], "data", "resolved"),
    edge("archive@2:28", [IF, portIds.out], "data", "skipped"),
    edge("urgent?@3:8", COND, "control", "resolved"),
    edge("archive@3:79", [COND, portIds.out], "data", "resolved"),
    edge("ask@4:4", PUB, "control", "running"),
    edge("publish@4:21", [PUB, portIds.out], "data", "pending"),
    edge("archive@4:32", [PUB, portIds.out], "data", "pending"),
    edge([CALL, portIds.param("u")], `${CALL}▸fetch@5:27`, "data", "resolved"),
    edge(`${CALL}▸fetch@5:27`, `${CALL}▸ask@5:22`, "data", "resolved"),
    edge(`${CALL}▸ask@5:22`, [CALL, portIds.out], "data", "resolved"),
    edge(CALL, "summarize@6:20", "order", "resolved"),
    edge(["summarize@6:20", portIds.param("u")], "summarize@6:20▸fetch@5:27", "data", "running"),
    edge("summarize@6:20▸fetch@5:27", "summarize@6:20▸ask@5:22", "data", "running"),
    edge("ask@7:39", "boom@7:51", "order", "resolved"),
    edge("boom@7:51", "ask@7:62", "order", "rejected"),
    edge("fetch@7:16", [RAISE, portIds.out], "data", "resolved"),
    edge([RAISE, portIds.out], [GUARD, portIds.out], "data", "resolved"),
  ],
  diagnostics: CLEAN,
};

// ── Blocks: transforms, projections ──────────────────────────────────────────────────────────
//   1 (let* ((title (ask "title")) (body (ask "body")) (tags (ask "tags"))
//   2   (fetch (string-append title "/" body "/" tags)))
//   3 (fetch (string-append (ask "slug") ".html"))
//   4 (define results (map (lambda (s) {:url (ask s)}) (list "a" "b")))
//   5 (fetch (:url (car results)))
//   6 (ask (list-ref results 1))

const FANIN = "ƒstring-append@2:9→fetch@2:2:in:arg0";
const PENDING_T = "ƒstring-append@3:7→fetch@3:0:in:arg0";
const RESULTS = "map@4:17";

export const blocks: RenderGraph = {
  nodes: [
    frame(ROOT, null, "seq", "program", "running"),
    step("ask@1:15", {
      parent: ROOT,
      symbol: "ask",
      span: "ask@1:15",
      args: [['"title"', "title"]],
      state: "resolved",
      output: "Fold",
    }),
    step("ask@1:35", {
      parent: ROOT,
      symbol: "ask",
      span: "ask@1:35",
      args: [['"body"', "body"]],
      state: "resolved",
      output: "one template",
    }),
    step("ask@1:54", {
      parent: ROOT,
      symbol: "ask",
      span: "ask@1:54",
      args: [['"tags"', "tags"]],
      state: "resolved",
      output: "v3",
    }),
    // Fan-in: three named producers, one computation, its value shown.
    transform(
      FANIN,
      ROOT,
      "string-append",
      '(string-append title "/" body "/" tags)',
      3,
      "resolved",
      "Fold/one template/v3",
    ),
    step("fetch@2:2", {
      parent: ROOT,
      symbol: "fetch",
      span: "fetch@2:2",
      args: [['(string-append title "/" body "/" tags)', "Fold/one template/v3"]],
      state: "resolved",
      output: "f:Fold/…",
    }),
    // A computation still waiting on its producer: no value yet (`—`).
    step("ask@3:22", { parent: ROOT, symbol: "ask", span: "ask@3:22", args: [['"slug"', "slug"]], state: "running" }),
    transform(PENDING_T, ROOT, "string-append", '(string-append (ask "slug") ".html")', 1, "pending"),
    step("fetch@3:0", {
      parent: ROOT,
      symbol: "fetch",
      span: "fetch@3:0",
      args: [['(string-append (ask "slug") ".html")']],
      state: "pending",
    }),
    // Projections: a path pill on the line.
    frame(RESULTS, ROOT, "par", "map", "resolved", {
      caption: "in parallel",
      ports: [IN("s"), OUT],
      instances: strip(["resolved", "resolved"]),
      selected: 1,
      progress: { resolved: 2, running: 0, rejected: 0, pending: 0, total: 2 },
    }),
    step("ask@4:43", {
      parent: RESULTS,
      symbol: "ask",
      span: "ask@4:43",
      args: [["s", "b"]],
      state: "resolved",
      output: "b!",
    }),
    step("fetch@5:0", {
      parent: ROOT,
      symbol: "fetch",
      span: "fetch@5:0",
      args: [["(:url (car results))", "a!"]],
      state: "resolved",
      output: "f:a!!",
    }),
    step("ask@6:0", {
      parent: ROOT,
      symbol: "ask",
      span: "ask@6:0",
      args: [["(list-ref results 1)"]],
      state: "pending",
    }),
  ],
  edges: [
    edge("ask@1:15", [FANIN, "in:0"], "data", "resolved"),
    edge("ask@1:35", [FANIN, "in:1"], "data", "resolved"),
    edge("ask@1:54", [FANIN, "in:2"], "data", "resolved"),
    edge(FANIN, "fetch@2:2", "data", "resolved"),
    edge("ask@3:22", [PENDING_T, "in:0"], "data", "running"),
    edge(PENDING_T, "fetch@3:0", "data", "pending"),
    edge([RESULTS, portIds.param("s")], "ask@4:43", "data", "resolved"),
    edge("ask@4:43", [RESULTS, portIds.out], "data", "resolved"),
    edge(RESULTS, "fetch@5:0", "data", "resolved", { path: [{ car: true }, { field: "url" }] }),
    edge(RESULTS, "ask@6:0", "data", "resolved", { path: [{ index: 1 }] }),
  ],
  diagnostics: CLEAN,
};

/** A non-zero conservation audit: the badge, with the notes as its tooltip. */
export const DIAGNOSTICS: RenderGraph["diagnostics"] = {
  unplacedInvocations: 2,
  droppedEdges: 1,
  notes: [
    "unplaced ask@4:0 (#17): ambiguous span — no key matches the call path",
    'dataflow unavailable — WireLocalityError: free variable "topic" in the wire at ? (arrival wireframe; upstream fix pending)',
  ],
};

/** The dataflow banner: some links traced, or none at all. */
export const DATAFLOW = {
  partial: { status: "partial", missing: 3 },
  unavailable: {
    status: "unavailable",
    reason: 'WireLocalityError: free variable "plan" is a port-reaching top-level define',
    missing: 0,
  },
} as const satisfies Record<string, NonNullable<RenderGraph["diagnostics"]["dataflow"]>>;

/** The same graph before any run: every node `potential`, no values, no instances. */
export function asPotential(g: RenderGraph): RenderGraph {
  return {
    ...g,
    nodes: g.nodes.map((n) => {
      if (n.kind === "frame") {
        const f: RenderFrame = { ...n, state: "potential" };
        delete f.progress;
        delete f.instances;
        delete f.selected;
        delete f.pinned;
        delete f.skippedBecause;
        return f;
      }
      if (n.kind === "transform") {
        const t: RenderTransform = { ...n, state: "potential", hasValue: false };
        delete t.value;
        return t;
      }
      const s: RenderStep = {
        ...n,
        state: "potential",
        input: n.input.map(({ slot, source }) => ({ slot, source, hasValue: false })),
        output: { hasValue: false },
      };
      delete s.skippedBecause;
      return s;
    }),
    edges: g.edges.map((e) => ({ ...e, state: "potential" as const })),
  };
}

/** A reader's pick on a z-frame: paint `ordinal` (pinned), or follow live again (`undefined`).
 *  Hand-built graphs have one painted instance, so only the strip's `selected` / `pinned` move. */
export function pick(g: RenderGraph, frameId: string, ordinal: number | undefined): RenderGraph {
  return {
    ...g,
    nodes: g.nodes.map((n) => {
      if (n.kind !== "frame" || n.id !== frameId || !n.instances) return n;
      if (ordinal !== undefined) return { ...n, selected: ordinal, pinned: true };
      const f: RenderFrame = { ...n };
      delete f.pinned;
      return f;
    }),
  };
}

export const PALETTE = { steps, areas, fold, control, blocks } as const;
