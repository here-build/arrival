/**
 * Shared by capture / progress tests: run real arrival programs against an async host port
 * (`io`: string → `${s}!`, `fail`: rejects) whose calls can be HELD and released one by one,
 * so a test can project the trace while steps are in flight. Plus a tiny `Plan` fixture
 * builder (keys = `path + span`, the build-plan convention).
 */
import { disposeRunContext, EnvCapability, execState, LexicalScope } from "@here.build/arrival";

import type { FrameKind, Plan, PlanFrame, PlanItem, PlanStep } from "../plan.js";

interface Held {
  readonly arg: string;
  readonly resolve: (v: string) => void;
}

/** Host-port gate. `hold = false`: calls resolve on the next tick. `hold = true`: calls park
 *  until `release(arg)`. */
export class Gate {
  hold = false;
  readonly held: Held[] = [];
  readonly calls: string[] = [];

  call(arg: string): Promise<string> {
    this.calls.push(arg);
    if (!this.hold) return Promise.resolve(`${arg}!`);
    return new Promise((resolve) => this.held.push({ arg, resolve }));
  }

  release(arg?: string): void {
    const i = arg === undefined ? 0 : this.held.findIndex((h) => h.arg === arg);
    if (i < 0) throw new Error(`no held call for ${arg} (held: ${this.held.map((h) => h.arg).join(", ")})`);
    const [h] = this.held.splice(i, 1);
    h!.resolve(`${h!.arg}!`);
  }

  releaseAll(): void {
    this.hold = false;
    while (this.held.length > 0) this.release();
  }
}

export function ioCapability(gate: Gate) {
  return EnvCapability.define("execution-graph-test/io", {
    symbols: (symbol: any, sz: any) => ({
      io: symbol.rosetta`io: async test port`({ input: [sz.string], output: [sz.string] }, (s: string) => gate.call(s)),
      fail: symbol.rosetta`fail: rejecting test port`(
        { input: [sz.string], output: [sz.string] },
        async (s: string) => {
          throw new Error(`fail ${s}`);
        },
      ),
    }),
  });
}

export interface Run {
  readonly done: Promise<{ error?: unknown }>;
}

/** Start `src` with `tap`; `done` settles (never rejects) when the run does. */
export function start(src: string, tap: unknown, gate = new Gate(), signal?: AbortSignal): Run {
  const done = execState(src, {
    scope: LexicalScope.fresh("t"),

    tap: tap as any,
    capabilities: [ioCapability(gate)],
    config: {},
    ...(signal ? { signal } : {}),
  }).then(
    async (state) => {
      await disposeRunContext(state.runCtx);
      return {};
    },
    (error: unknown) => ({ error }),
  );
  return { done };
}

export const run = (src: string, tap: unknown, gate?: Gate) => start(src, tap, gate).done;

export async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}

export const text = (v: unknown): string | undefined =>
  v === undefined ? undefined : String((v as { valueOf(): unknown }).valueOf());

// ── Plan fixtures ──────────────────────────────────────────────────────────────────────────

export const step = (span: string, symbol: string, path = ""): PlanStep => ({
  kind: "step",
  key: path + span,
  span,
  path,
  symbol,
  args: [],
});

export const frame = (
  kind: FrameKind,
  span: string,
  children: PlanItem[],
  extra: Partial<Omit<PlanFrame, "kind" | "key" | "span" | "frame" | "children">> & { path?: string } = {},
): PlanFrame => {
  const { path = "", ...rest } = extra;
  return {
    kind: "frame",
    key: path + span,
    span,
    path,
    frame: kind,
    label: kind,
    children,
    params: [],
    bodyRoots: [],
    ...rest,
  };
};

/** A branch with arms `${span}#k`, each `{ roots, children }`. */
export const branch = (
  span: string,
  arms: { roots: string[]; children?: PlanItem[] }[],
  extra: { path?: string; armTests?: (string | undefined)[] } = {},
): PlanFrame =>
  frame(
    "branch",
    span,
    arms.map((a, k) => frame("arm", `${span}#${k}`, a.children ?? [], { path: extra.path, bodyRoots: a.roots })),
    {
      path: extra.path,
      bodyRoots: arms.flatMap((a) => a.roots),
      ...(extra.armTests ? { armTests: extra.armTests } : {}),
    },
  );

export function planOf(children: PlanItem[]): Plan {
  const root = frame("seq", "<program>", children);
  const byKey = new Map<string, PlanItem>();
  const bySpan = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  const index = (f: PlanFrame) => {
    for (const c of f.children) {
      byKey.set(c.key, c);
      parentOf.set(c.key, f.key);
      bySpan.set(c.span, [...(bySpan.get(c.span) ?? []), c.key]);
      if (c.kind === "frame") index(c);
    }
  };
  index(root);
  return { root, byKey, bySpan, parentOf, edges: [], diagnostics: [] };
}
