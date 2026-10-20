/**
 * Hand-written RenderGraphs in L4's shape, for the view and layout tests and the GraphView stories.
 * Each mirrors a small arrival-scheme program; spans are `head@line:col` of that program (arrival's
 * convention: 1-based lines, 0-based columns), ids are plan keys (prefixed `callSite▸` inside an
 * inlined call). Fold model: every par / loop template is drawn ONCE, painted from the selected
 * instance; `instances` is the picker strip.
 */
import {
  type PathStep,
  portIds,
  type RenderEdge,
  type RenderFrame,
  type RenderFrameKind,
  type RenderGraph,
  type RenderInstance,
  type RenderPort,
  type RenderState,
  type RenderStep,
} from "../types.js";

const IN = (name: string): RenderPort => ({ id: portIds.param(name), side: "in", label: name });
const OUT: RenderPort = { id: portIds.out, side: "out" };
const CONTROL: RenderPort = { id: portIds.control, side: "control" };
const CLEAN = { unplacedInvocations: 0, droppedEdges: 0, notes: [] };

interface StepOpts {
  parent: string | null;
  symbol: string;
  key: string;
  span?: string;
  ordinals?: number[];
  args: [source: string, value?: unknown][];
  state: RenderState;
  output?: unknown;
  error?: string;
}

function step(id: string, o: StepOpts): RenderStep {
  const span = o.span ?? o.key;
  return {
    kind: "step",
    id,
    parent: o.parent,
    span,
    symbol: o.symbol,
    instance: { key: o.key, ordinals: o.ordinals ?? [], span },
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

/** A bare node id means its `out` (as source) / `in:arg0` (as target). `path`: a projection. */
function edge(from: End, to: End, kind: RenderEdge["kind"], state: RenderState, path?: PathStep[]): RenderEdge {
  const f = endOf(from, portIds.out);
  const t = endOf(to, portIds.arg(0));
  return { id: `${f.node}.${f.port}->${t.node}.${t.port}`, from: f, to: t, kind, state, ...(path ? { path } : {}) };
}

const strip = (states: RenderState[]): RenderInstance[] => states.map((state, ordinal) => ({ ordinal, state }));

// ── (a)/(b) plan → map ask → fetch ───────────────────────────────────────────
//   1 (define plan (ask "make a plan"))
//   2 (define steps (map (lambda (s) (ask s)) (:steps plan)))
//   3 (fetch (car steps))

const ROOT = "seq@root";
const PLAN = "ask@1:13";
const MAP = "map@2:14";
const ASK_S = "ask@2:31";
const FETCH = "fetch@3:0";

export const planMapFetchPotential: RenderGraph = {
  nodes: [
    frame(ROOT, null, "seq", "program", "potential"),
    step(PLAN, { parent: ROOT, symbol: "ask", key: PLAN, args: [['"make a plan"']], state: "potential" }),
    frame(MAP, ROOT, "par", "map", "potential", { ports: [IN("s"), OUT] }),
    step(ASK_S, { parent: MAP, symbol: "ask", key: ASK_S, args: [["s"]], state: "potential" }),
    step(FETCH, { parent: ROOT, symbol: "fetch", key: FETCH, args: [["(car steps)"]], state: "potential" }),
  ],
  edges: [
    edge(PLAN, [MAP, portIds.param("s")], "data", "potential", [{ field: ":steps" }]),
    edge([MAP, portIds.param("s")], ASK_S, "data", "potential"),
    edge(ASK_S, [MAP, portIds.out], "data", "potential"),
    edge([MAP, portIds.out], FETCH, "data", "potential", [{ car: true }]),
  ],
  diagnostics: CLEAN,
};

const PLAN_STEPS = [
  "outline the essay",
  "draft each section",
  "edit for tone",
  "cut 20%",
  "title",
  "abstract",
  "references",
  "publish",
];

/** The painted track: the first running one (follow live). */
const SHOWN = 1;
const TRACK_STATES: RenderState[] = [
  "resolved",
  "running",
  "rejected",
  "resolved",
  "running",
  "resolved",
  "pending",
  "pending",
];

export const planMapFetchActual: RenderGraph = {
  nodes: [
    frame(ROOT, null, "seq", "program", "running"),
    step(PLAN, {
      parent: ROOT,
      symbol: "ask",
      key: PLAN,
      args: [['"make a plan"', "make a plan"]],
      state: "resolved",
      output: { steps: PLAN_STEPS },
    }),
    frame(MAP, ROOT, "par", "map", "running", {
      caption: "in parallel",
      ports: [IN("s"), OUT],
      instances: strip(TRACK_STATES),
      selected: SHOWN,
      progress: { resolved: 3, running: 2, rejected: 1, pending: 2, total: 8 },
    }),
    step(ASK_S, {
      parent: MAP,
      symbol: "ask",
      key: ASK_S,
      ordinals: [SHOWN],
      args: [["s", PLAN_STEPS[SHOWN]]],
      state: "running",
    }),
    step(FETCH, { parent: ROOT, symbol: "fetch", key: FETCH, args: [["(car steps)"]], state: "pending" }),
  ],
  edges: [
    edge(PLAN, [MAP, portIds.param("s")], "data", "resolved", [{ field: ":steps" }]),
    edge([MAP, portIds.param("s")], ASK_S, "data", "resolved"),
    edge(ASK_S, [MAP, portIds.out], "data", "running"),
    edge([MAP, portIds.out], FETCH, "data", "running", [{ car: true }]),
  ],
  diagnostics: CLEAN,
};

// ── (c) loop, painted from its third (running) iteration ─────────────────────
//   1 (define first (ask "draft a tagline"))
//   2 (define best (let refine ((draft first) (n 0))
//   3   (if (< n 2) (refine (critique draft) (+ n 1)) draft)))
//   4 (publish best)

const FIRST = "ask@1:14";
const LOOP = "let@2:13";
const CRIT = "critique@3:22";
const PUB = "publish@4:0";

export const loopIterations: RenderGraph = {
  nodes: [
    frame(ROOT, null, "seq", "program", "running"),
    step(FIRST, {
      parent: ROOT,
      symbol: "ask",
      key: FIRST,
      args: [['"draft a tagline"', "draft a tagline"]],
      state: "resolved",
      output: "Faster shipping for thoughtful teams.",
    }),
    frame(LOOP, ROOT, "loop", "refine", "running", {
      caption: "in loop",
      ports: [IN("draft"), OUT],
      instances: strip(["resolved", "resolved", "running"]),
      selected: 2,
      progress: { resolved: 2, running: 1, rejected: 0, pending: 0 },
    }),
    step(CRIT, {
      parent: LOOP,
      symbol: "critique",
      key: CRIT,
      ordinals: [2],
      args: [["draft", "Think slower. Ship sooner."]],
      state: "running",
    }),
    step(PUB, { parent: ROOT, symbol: "publish", key: PUB, args: [["best"]], state: "pending" }),
  ],
  edges: [
    edge(FIRST, [LOOP, portIds.param("draft")], "data", "resolved"),
    edge([LOOP, portIds.param("draft")], CRIT, "data", "resolved"),
    edge(CRIT, [LOOP, portIds.param("draft")], "recur", "running"),
    edge(CRIT, [LOOP, portIds.out], "data", "pending"),
    edge([LOOP, portIds.out], PUB, "data", "pending"),
  ],
  diagnostics: CLEAN,
};

// ── (d) branch: the taken arm and the untaken one, both lanes ────────────────
//   1 (define d (ask "is it urgent?"))
//   2 (define r (if (:urgent d) (notify d) (archive d)))
//   3 (log r)

const SEL = "ask@1:10";
const IF = "if@2:10";
const NOTIFY = "notify@2:26";
const ARCHIVE = "archive@2:37";
const LOG = "log@3:0";
const VERDICT = { urgent: true, reason: "customer blocked on login" };

export const branchArms: RenderGraph = {
  nodes: [
    frame(ROOT, null, "seq", "program", "resolved"),
    step(SEL, {
      parent: ROOT,
      symbol: "ask",
      key: SEL,
      args: [['"is it urgent?"', "is it urgent?"]],
      state: "resolved",
      output: VERDICT,
    }),
    frame(IF, ROOT, "branch", "if", "resolved", { ports: [CONTROL, OUT] }),
    frame(`${IF}#0`, IF, "arm", "then", "resolved", { span: NOTIFY }),
    step(NOTIFY, {
      parent: `${IF}#0`,
      symbol: "notify",
      key: NOTIFY,
      args: [["d", VERDICT]],
      state: "resolved",
      output: "sent #4512",
    }),
    frame(`${IF}#1`, IF, "arm", "else", "skipped", { span: ARCHIVE, skippedBecause: "not-taken" }),
    step(ARCHIVE, { parent: `${IF}#1`, symbol: "archive", key: ARCHIVE, args: [["d"]], state: "skipped" }),
    step(LOG, { parent: ROOT, symbol: "log", key: LOG, args: [["r", "sent #4512"]], state: "resolved", output: null }),
  ],
  edges: [
    edge(SEL, [IF, portIds.control], "control", "resolved", [{ field: ":urgent" }]),
    edge(SEL, NOTIFY, "data", "resolved"),
    edge(SEL, ARCHIVE, "data", "skipped"),
    edge(NOTIFY, [IF, portIds.out], "data", "resolved"),
    edge(ARCHIVE, [IF, portIds.out], "data", "skipped"),
    edge([IF, portIds.out], LOG, "data", "resolved"),
  ],
  diagnostics: CLEAN,
};

// ── (e) call frame inside a par template ─────────────────────────────────────
//   1 (define (summarize u) (ask (fetch u)))
//   2 (log "start")
//   3 (define urls (ask "list sources"))
//   4 (map (lambda (u) (summarize u)) urls)

const START = "log@2:0";
const URLS = "ask@3:13";
const EMAP = "map@4:0";
const CALL = "summarize@4:17";
export const EFETCH = `${CALL}▸fetch@1:27`;
export const EASK = `${CALL}▸ask@1:22`;
const URL_LIST = ["https://a.example/post", "https://b.example/notes"];

export const callInTrack: RenderGraph = {
  nodes: [
    frame(ROOT, null, "seq", "program", "running"),
    step(START, {
      parent: ROOT,
      symbol: "log",
      key: START,
      args: [['"start"', "start"]],
      state: "resolved",
      output: null,
    }),
    step(URLS, {
      parent: ROOT,
      symbol: "ask",
      key: URLS,
      args: [['"list sources"', "list sources"]],
      state: "resolved",
      output: URL_LIST,
    }),
    frame(EMAP, ROOT, "par", "map", "running", {
      caption: "in parallel",
      ports: [IN("u"), OUT],
      instances: strip(["resolved", "running"]),
      selected: 1,
    }),
    frame(CALL, EMAP, "call", "summarize", "running", {
      symbol: "summarize",
      instance: { key: CALL, ordinals: [1], span: CALL },
      ports: [IN("u"), OUT],
    }),
    step(EFETCH, {
      parent: CALL,
      symbol: "fetch",
      key: EFETCH,
      span: "fetch@1:27",
      ordinals: [1],
      args: [["u", URL_LIST[1]]],
      state: "resolved",
      output: "<html>… 48kB",
    }),
    step(EASK, {
      parent: CALL,
      symbol: "ask",
      key: EASK,
      span: "ask@1:22",
      ordinals: [1],
      args: [["(fetch u)"]],
      state: "running",
    }),
  ],
  edges: [
    edge(START, [EMAP, "order"], "order", "resolved"),
    edge(URLS, [EMAP, portIds.param("u")], "data", "resolved"),
    edge([EMAP, portIds.param("u")], [CALL, portIds.param("u")], "data", "resolved"),
    edge([CALL, portIds.param("u")], EFETCH, "data", "resolved"),
    edge(EFETCH, EASK, "data", "resolved"),
    edge(EASK, [CALL, portIds.out], "data", "running"),
    edge([CALL, portIds.out], [EMAP, portIds.out], "data", "running"),
  ],
  diagnostics: CLEAN,
};

export const FIXTURES = { planMapFetchPotential, planMapFetchActual, loopIterations, branchArms, callInTrack } as const;
