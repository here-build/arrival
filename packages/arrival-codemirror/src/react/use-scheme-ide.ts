import { useEffect, useState } from "react";
import type { LsPort } from "@here.build/arrival-type-lens/ls-client";

import type { SchemeIdeBackend } from "../index.js";

/**
 * The scheme language service for the editor — worker-hosted, shared, lazy.
 *
 * The ladder, best first:
 *   1. SharedWorker — the service runs OFF the main thread and is shared
 *      across every editor AND every tab (one prelude compilation, one warm
 *      cache for the whole browser profile);
 *   2. dedicated Worker — same off-thread benefits, per-tab (browsers without
 *      module SharedWorkers — Firefox at the time of writing);
 *   3. in-thread service — the original path, still fully functional;
 *   4. null — the editor stays a plain (highlighted, hinted) editor.
 *
 * Each rung is bounded: connect rejects on worker error or init timeout, so a
 * broken rung degrades to the next instead of hanging. The service itself is
 * self-contained (bundled prelude + TS libs — no CDN, works offline); the
 * heavy typescript chunk loads inside the worker on rungs 1-2 and the main
 * thread only ever loads the featherweight ls-client.
 *
 * noImplicitAny OFF: at the lens's current maturity a `(define (f x) …)`
 * parameter is untyped, and strict mode would squiggle every such define —
 * false alarms on correct code. The editor surfaces only PROVEN bites.
 */
const LS_OPTIONS = { compilerOptions: { noImplicitAny: false } };

// ── env-derived name roster: host rosettas + scheme stdlib preamble ─────────
// The lens otherwise knows only its hand-written builtin leaves, so every
// arrival env binding (`infer`, `require`, `http/*`) and every scheme-prelude
// helper (`field`, `values-of`, `take`) reads as an unresolved name. Both
// rosters are DERIVED from the env's single source of truth — `host` from
// `assembleHostPrelude([...rosettaTypesOf(env)])`, `schemePrelude` is the
// `BUILTIN_PREAMBLE` source string — and threaded in here. Plain data, so they
// cross the worker boundary in the init options as-is.
let hostConfig: { host?: { prelude: string; members: readonly string[] }; schemePrelude?: string } = {};

/** Supply the env-derived name roster (host rosettas + scheme stdlib preamble)
 *  to the scheme IDE. Call once at app boot, before {@link preloadSchemeIde}. */
export function configureSchemeIdeHost(config: {
  host?: { prelude: string; members: readonly string[] };
  schemePrelude?: string;
}): void {
  hostConfig = config;
}

let idePromise: Promise<SchemeIdeBackend | null> | null = null;

async function workerBackend(shared: boolean): Promise<SchemeIdeBackend> {
  const { connectSchemeLs } = await import("@here.build/arrival-type-lens/ls-client");
  const connectOptions = { ...LS_OPTIONS, ...hostConfig };
  // All constructions are written out INLINE on purpose: bundlers' worker
  // transforms (vite/rollup) only recognize the syntactic pattern
  // `new (Shared)Worker(new URL("…", import.meta.url), { type: "module" })` —
  // hoisting the URL into a variable silently skips bundling the worker.
  const target = shared
    ? new SharedWorker(new URL("scheme-ls.worker.js", import.meta.url), {
        type: "module",
        name: "arrival-scheme-ls",
      })
    : new Worker(new URL("scheme-ls.worker.js", import.meta.url), {
        type: "module",
        name: "arrival-scheme-ls",
      });
  const port = (shared ? (target as SharedWorker).port : target) as unknown as LsPort;
  return await new Promise<SchemeIdeBackend>((resolve, reject) => {
    // A worker whose module fails to load never answers — its error event is
    // the early exit (the connect timeout is the backstop).
    (target as Worker).addEventListener("error", (e) => {
      reject(new Error(`scheme-ls worker error: ${(e as ErrorEvent).message ?? "load failed"}`));
    });
    connectSchemeLs(port, connectOptions).then(resolve, reject);
  });
}

// ── `(require …)` resolution plumbing ───────────────────────────────────────
// The lens is filesystem-blind; the HOST pushes the project's files. One
// module-level table feeds whichever rung won the ladder: worker rungs get a
// `setProjectFiles` push (a callback can't cross postMessage), the in-thread
// rung resolves through the live table directly.
let projectFiles: Record<string, string> = {};
let pushFiles: ((files: Record<string, string>) => void) | null = null;

// The require-TYPE twin of projectFiles: `{ path → TS type string }`,
// synthesized HOST-side from the runtime loader registry (resolveRequireType).
// Data-file `(require)`s resolve to their granular shape; the lens can't run the
// registry over postMessage, so the host ships the resolved types instead.
let requireTypes: Record<string, string> = {};
let pushRequireTypes: ((types: Record<string, string>) => void) | null = null;

/** Publish the project's files for `(require "path")` resolution — call on
 *  project open and whenever files change (replace-wholesale; keys are the
 *  require-style paths). Idempotent and cheap; safe before the IDE loads. */
export function setSchemeIdeFiles(files: Record<string, string>): void {
  projectFiles = files;
  pushFiles?.(files);
}

/** Publish data-file require TYPES (`{ path → TS type string }`) so a
 *  `(require "data.json")` resolves to its precise shape. Synthesize host-side
 *  via the loader registry's `resolveRequireType`. Replace-wholesale; pairs with
 *  `setSchemeIdeFiles`. */
export function setSchemeIdeRequireTypes(types: Record<string, string>): void {
  requireTypes = types;
  pushRequireTypes?.(types);
}

function loadIde(): Promise<SchemeIdeBackend | null> {
  idePromise ??= (async () => {
    if (typeof SharedWorker === "function") {
      try {
        const backend = await workerBackend(true);
        wireFilesPush(backend);
        wireRequireTypesPush(backend);
        return backend;
      } catch (error) {
        console.warn("scheme LS: SharedWorker unavailable — trying a dedicated worker", error);
      }
    }
    if (typeof Worker === "function") {
      try {
        const backend = await workerBackend(false);
        wireFilesPush(backend);
        wireRequireTypesPush(backend);
        return backend;
      } catch (error) {
        console.warn("scheme LS: worker unavailable — falling back to the main thread", error);
      }
    }
    try {
      const m = await import("@here.build/arrival-type-lens/browser");
      // In-thread rung: resolve straight off the live table.
      return m.createBrowserSchemeLanguageService({
        ...LS_OPTIONS,
        ...hostConfig,
        resolveModule: (path) => projectFiles[path] ?? projectFiles[path.replace(/^\.\//, "")] ?? null,
        resolveRequireType: (path) => requireTypes[path] ?? requireTypes[path.replace(/^\.\//, "")] ?? null,
      });
    } catch (error) {
      console.warn("scheme IDE backend failed to load — editing without type intel", error);
      return null;
    }
  })();
  return idePromise;
}

/** Wire the worker-rung files push: send the current table now, re-send on
 *  every setSchemeIdeFiles. */
function wireFilesPush(backend: SchemeIdeBackend): void {
  const push = (backend as { setProjectFiles?: (f: Record<string, string>) => Promise<void> }).setProjectFiles;
  if (push === undefined) return;
  pushFiles = (files) => void push.call(backend, files).catch(() => undefined);
  if (Object.keys(projectFiles).length > 0) pushFiles(projectFiles);
}

/** Wire the worker-rung require-types push: send the current table now, re-send
 *  on every setSchemeIdeRequireTypes. Parallel to wireFilesPush. */
function wireRequireTypesPush(backend: SchemeIdeBackend): void {
  const push = (backend as { setRequireTypes?: (t: Record<string, string>) => Promise<void> }).setRequireTypes;
  if (push === undefined) return;
  pushRequireTypes = (types) => void push.call(backend, types).catch(() => undefined);
  if (Object.keys(requireTypes).length > 0) pushRequireTypes(requireTypes);
}

const idle = (fn: () => void): void => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => fn());
  else setTimeout(fn, 50);
};

/** Kick the IDE bootstrap (worker spawn + compilation warm-up, both off the
 *  main thread) ahead of the first `.scm` editor mount — call at app boot /
 *  project open so the first squiggle pass is near-instant. Idempotent. */
export function preloadSchemeIde(): void {
  idle(() => void loadIde());
}

/** The shared scheme IDE backend, or `null` while loading / when unavailable /
 *  when `enabled` is false. Flips state at most once per mount. */
export function useSchemeIde(enabled: boolean): SchemeIdeBackend | null {
  const [ide, setIde] = useState<SchemeIdeBackend | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void loadIde().then((backend) => {
      if (live && backend !== null) setIde(backend);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return enabled ? ide : null;
}
