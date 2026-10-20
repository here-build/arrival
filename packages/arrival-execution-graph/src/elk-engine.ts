/**
 * ELK engines. The default runs `elkjs/lib/elk.bundled.js` on the main thread, imported lazily on
 * first layout so the ~1.4MB layouter stays out of the consumer's main chunk. For off-main-thread
 * layout, `createWorkerEngine` takes the URL of `elkjs/lib/elk-worker.min.js` as the consumer's
 * bundler serves it (Vite: `import url from "elkjs/lib/elk-worker.min.js?url"`).
 */
// elkjs is CJS with an ESM-style .d.ts; under NodeNext the default import types as the module
// namespace (no construct signature) although at runtime, through the bundler's CJS interop, the
// value is the constructor. Cast to the constructor shape.
import type { ElkNode } from "elkjs";

export interface ElkEngine {
  layout(graph: ElkNode): Promise<ElkNode>;
}

type ElkCtor = new (opts?: { workerUrl: string }) => ElkEngine;

const ctorOf = (mod: unknown): ElkCtor => ((mod as { default?: unknown }).default ?? mod) as ElkCtor;

let bundled: Promise<ElkEngine> | null = null;

/** The main-thread engine: elk.bundled.js, imported and constructed once on first layout. */
export const defaultEngine: ElkEngine = {
  layout: async (graph) => {
    bundled ??= import("elkjs/lib/elk.bundled.js").then((m) => new (ctorOf(m))());
    const elk = await bundled;
    return elk.layout(graph);
  },
};

/** A worker-backed engine over `elk-api`; the worker is spawned on first layout. */
export function createWorkerEngine(workerUrl: string | URL): ElkEngine {
  let engine: Promise<ElkEngine> | null = null;
  return {
    layout: async (graph) => {
      engine ??= import("elkjs/lib/elk-api.js").then((m) => new (ctorOf(m))({ workerUrl: String(workerUrl) }));
      const elk = await engine;
      return elk.layout(graph);
    },
  };
}

export type { ElkNode } from "elkjs";
