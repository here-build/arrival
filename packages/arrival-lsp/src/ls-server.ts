// ls-server — the HEAVY side of the worker protocol (hosts the real service).
//
// Lives apart from ls-client so the main thread never imports the service
// (typescript + the bundles belong to the worker's chunk).
//
// Sharing model: services are memoized by options-profile, so every
// connection (every tab of a SharedWorker, every editor in a tab) with the
// same options shares ONE instance — one prelude compilation, one document
// registry, one warm cache. The service's methods are synchronous and
// self-contained per call (each loads its own source first), so interleaved
// requests from multiple ports are safe by construction.
//
// NB `onmessage` PROPERTY assignment is load-bearing (auto-starts
// MessagePorts; addEventListener would need `port.start()`).

/* eslint-disable unicorn/prefer-add-event-listener */

import { createBrowserSchemeLanguageService } from "./browser.js";
import {
  LS_METHODS,
  type LsCall,
  type LsInit,
  type LsPort,
  type LsReply,
  type SchemeLsWorkerOptions,
} from "./ls-client.js";
import type { SchemeLanguageService, SchemeLanguageServiceOptions } from "./service-core.js";

type MethodName = (typeof LS_METHODS)[number];

/** `(require …)` resolution over the wire: a CALLBACK can't cross postMessage,
 *  so each CONNECTION pushes its project-files table ({kind:"files"}) and the
 *  shared service resolves through this swap slot. Sound because the worker
 *  dispatches messages one at a time and the service's methods are fully
 *  synchronous — the slot is set for exactly one call's duration. */
let activeFiles: Readonly<Record<string, string>> | null = null;
const resolveThroughActiveFiles = (path: string): string | null =>
  activeFiles?.[path] ?? activeFiles?.[path.replace(/^\.\//, "")] ?? null;

/** The require-TYPE twin of `activeFiles`: a precomputed `{ path → TS type }`
 *  map pushed by the connection ({kind:"requireTypes"}). Read through the same
 *  one-call-at-a-time swap slot — a `resolveRequireType` callback can't cross
 *  postMessage, so the type is synthesized host-side and the result shipped. */
let activeRequireTypes: Readonly<Record<string, string>> | null = null;
const resolveThroughActiveRequireTypes = (path: string): string | null =>
  activeRequireTypes?.[path] ?? activeRequireTypes?.[path.replace(/^\.\//, "")] ?? null;

/** Service per options-profile — THE sharing point. */
const sharedServices = new Map<string, SchemeLanguageService>();
function serviceFor(options: SchemeLsWorkerOptions): SchemeLanguageService {
  const key = JSON.stringify(options);
  let svc = sharedServices.get(key);
  if (svc === undefined) {
    svc = createBrowserSchemeLanguageService({
      ...(options as SchemeLanguageServiceOptions),
      resolveModule: resolveThroughActiveFiles,
      resolveRequireType: resolveThroughActiveRequireTypes,
    });
    sharedServices.set(key, svc);
    // Warm the first compilation off ANY caller's request path.
    const warm = svc;
    setTimeout(() => {
      try {
        warm.getSemanticDiagnostics(";");
      } catch {
        // warm-up only — a failure surfaces on a real call
      }
    }, 0);
  }
  return svc;
}

/** Host the language service on a port. One call per connection. */
export function serveSchemeLs(port: LsPort): void {
  let service: SchemeLanguageService | null = null;
  let files: Readonly<Record<string, string>> | null = null;
  let requireTypes: Readonly<Record<string, string>> | null = null;
  port.onmessage = (ev) => {
    const msg = ev.data as
      | LsInit
      | LsCall
      | { kind: "files"; id: number; files: Record<string, string> }
      | { kind: "requireTypes"; id: number; types: Record<string, string> };
    try {
      if (msg.kind === "init") {
        service = serviceFor(msg.options);
        port.postMessage({ kind: "reply", id: msg.id, ok: true, value: null } satisfies LsReply);
        return;
      }
      if (msg.kind === "files") {
        // The connection's require-resolution table (replace-wholesale; the
        // host pushes a fresh snapshot whenever the project changes).
        files = msg.files;
        port.postMessage({ kind: "reply", id: msg.id, ok: true, value: null } satisfies LsReply);
        return;
      }
      if (msg.kind === "requireTypes") {
        // The connection's require-TYPE table (replace-wholesale; pushed fresh
        // whenever the project's data files change).
        requireTypes = msg.types;
        port.postMessage({ kind: "reply", id: msg.id, ok: true, value: null } satisfies LsReply);
        return;
      }
      if (service === null) throw new Error("scheme-ls: call before init");
      if (!(LS_METHODS as readonly string[]).includes(msg.method))
        throw new Error(`scheme-ls: unknown method ${msg.method}`);
      activeFiles = files;
      activeRequireTypes = requireTypes;
      let value: unknown;
      try {
        value = (service[msg.method as MethodName] as (...a: unknown[]) => unknown)(...msg.args);
      } finally {
        activeFiles = null;
        activeRequireTypes = null;
      }
      port.postMessage({ kind: "reply", id: msg.id, ok: true, value } satisfies LsReply);
    } catch (error) {
      port.postMessage({
        kind: "reply",
        id: msg.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies LsReply);
    }
  };
}
