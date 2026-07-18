/**
 * The two named strategies, as DATA — design doc §2. `ts-base` (opinions.ts) is
 * the shared opinion set; a `Strategy` is `ts-base ++ that runtime's rt/* fills`,
 * in table order, so `Strategy.opinions` (and therefore `strategyHash`) is stable
 * by construction — no sort step, no set-vs-array ambiguity.
 */
import { type Opinion, type OpinionId, RUNTIME_OPINIONS, TS_BASE_OPINIONS } from "./opinions.js";

export interface Strategy {
  readonly id: "ts-vercel-ai" | "ts-langchain";
  /** Strategy-level version — bump on ANY opinion change (finer-grained per-opinion
   *  versions live on `Opinion.version`). */
  readonly version: number;
  /** Resolved, ORDERED, closed — ts-base ids first (table order), then this
   *  strategy's own `rt/*` ids (table order). */
  readonly opinions: readonly OpinionId[];
}

const baseIds = TS_BASE_OPINIONS.map((o) => o.id);

function strategyOf(id: Strategy["id"]): Strategy {
  // Per-strategy version — bumps only when THAT strategy's own realized opinions
  // change (finer-grained than one shared wave number, so W4/W5 landing on
  // different days never force a false bump on the sibling strategy):
  //   ts-langchain: 3 (W3's ts-base bump, inherited, PLUS W5 — rt/plain-infer ·
  //     rt/chat-messages · rt/structured-output · rt/client-module realized for
  //     real; output changed deliberately for this strategy — it's ALSO the
  //     default, so this bump is the one that rebaselines the characterization
  //     corpus. rt/agentic-loop / rt/mcp-tools stay a door, matching ts-vercel-
  //     ai's own W4 door — `(mcp "name")` has no source-vocabulary lowering yet).
  //   ts-vercel-ai: 3 (W3's ts-base bump, inherited, PLUS W4 — the same four
  //     opinions realized for real; output changed deliberately for this
  //     strategy only).
  const version = 3;
  return { id, version, opinions: [...baseIds, ...RUNTIME_OPINIONS[id].map((o) => o.id)] };
}

export const STRATEGIES: Record<Strategy["id"], Strategy> = {
  "ts-vercel-ai": strategyOf("ts-vercel-ai"),
  "ts-langchain": strategyOf("ts-langchain"),
};

/**
 * The default every compile entry point falls back to when `strategy` is
 * omitted — `ts-langchain` (both strategies have a landed prompt backend and a
 * realized `rt/*` fill as of W4/W5; this is a naming choice, not a completeness
 * gap). The W1 byte-identity-to-pre-registry claim was version 1's; W3 changed
 * output under version 2 (ts-base register); W5 changes it again under version 3
 * (rt/* realized for real) — the characterization gate now pins THIS version's
 * bytes, and rebaselines deliberately each time, never silently.
 */
export const DEFAULT_STRATEGY: Strategy = STRATEGIES["ts-langchain"];

/** Every opinion definition that applies under `strategyId`, ts-base first. */
export function opinionsFor(strategyId: Strategy["id"]): readonly Opinion[] {
  return [...TS_BASE_OPINIONS, ...RUNTIME_OPINIONS[strategyId]];
}

/** The full `Opinion` record for `id` under `strategyId` (rt/* ids resolve to
 *  that runtime's OWN decision — same id, different fill, §2.2 vs §2.3). */
export function resolveOpinion(strategyId: Strategy["id"], id: OpinionId): Opinion | undefined {
  return opinionsFor(strategyId).find((o) => o.id === id);
}

/** Is `id` a member of `strategy`'s resolved opinion set? */
export function hasOpinion(strategy: Strategy, id: OpinionId): boolean {
  return strategy.opinions.includes(id);
}
