// ls-client — the LIGHT side of the worker protocol (wire types + connect).
//
// Deliberately imports nothing heavy: the main thread loads THIS to talk to a
// worker-hosted service, so it must not drag `typescript` + the bundles into
// the main bundle (that's the worker's chunk). The serve side lives in
// ls-server.ts; `./ls-protocol` barrels both for in-process use and tests.
//
// NB `onmessage` PROPERTY assignment is load-bearing: it AUTO-STARTS a
// MessagePort; addEventListener requires an explicit `port.start()` the
// LsPort seam doesn't carry.

/* eslint-disable unicorn/prefer-add-event-listener */

import type { SchemeLanguageService } from "./service-core.js";

/** The wire-safe creation options (a structurally-cloneable subset). */
export interface SchemeLsWorkerOptions {
  compilerOptions?: Record<string, unknown>;
  host?: { prelude: string; members: readonly string[] };
}

export type LsInit = { kind: "init"; id: number; options: SchemeLsWorkerOptions };
export type LsCall = { kind: "call"; id: number; method: string; args: unknown[] };
export type LsReply =
  | { kind: "reply"; id: number; ok: true; value: unknown }
  | { kind: "reply"; id: number; ok: false; error: string };

/** The port shape both sides need — Worker, SharedWorker.port, and
 *  MessageChannel ports all satisfy it structurally. */
export interface LsPort {
  postMessage(data: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** The service's async twin: same methods, promise-returning — structurally a
 *  `SchemeIdeBackend` for the CodeMirror extensions. Plus the transport-level
 *  `setProjectFiles`: `(require …)` resolution can't ship a callback over
 *  postMessage, so the host pushes a files snapshot instead (re-push whenever
 *  the project changes; replace-wholesale). */
export type AsyncSchemeLanguageService = {
  [M in keyof SchemeLanguageService]: (
    ...args: Parameters<SchemeLanguageService[M]>
  ) => Promise<Awaited<ReturnType<SchemeLanguageService[M]>>>;
} & {
  setProjectFiles(files: Record<string, string>): Promise<void>;
};

export const LS_METHODS = [
  "getSemanticDiagnostics",
  "getQuickInfoAtPosition",
  "getCompletionsAtPosition",
  "getCompletionContext",
  "getDefinitionAtPosition",
  "getSemanticClassifications",
  "getTypeValidCandidates",
] as const;

/** Connect to a served port. Resolves once the server acknowledges the init —
 *  i.e. the worker module actually loaded and built a service — or rejects on
 *  `timeoutMs` (a worker that failed to load never replies; a fallback ladder
 *  needs a bounded wait, not a hang). */
export function connectSchemeLs(
  port: LsPort,
  options: SchemeLsWorkerOptions,
  timeoutMs = 15_000,
): Promise<AsyncSchemeLanguageService> {
  let nextId = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  port.onmessage = (ev) => {
    const msg = ev.data as LsReply;
    const entry = pending.get(msg.id);
    if (entry === undefined) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.value);
    else entry.reject(new Error(msg.error));
  };
  const call = (message: Omit<LsInit, "id"> | Omit<LsCall, "id">): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      port.postMessage({ ...message, id });
    });

  const client = {
    ...Object.fromEntries(
      LS_METHODS.map((method) => [method, (...args: unknown[]) => call({ kind: "call", method, args })]),
    ),
    setProjectFiles: (files: Record<string, string>) =>
      (call as (m: Record<string, unknown>) => Promise<unknown>)({ kind: "files", files }) as Promise<void>,
  } as AsyncSchemeLanguageService;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("scheme-ls: worker init timed out")), timeoutMs);
    void (async () => {
      try {
        await call({ kind: "init", options });
        clearTimeout(timer);
        resolve(client);
      } catch (error) {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}
