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

/** Service per options-profile — THE sharing point. */
const sharedServices = new Map<string, SchemeLanguageService>();
function serviceFor(options: SchemeLsWorkerOptions): SchemeLanguageService {
  const key = JSON.stringify(options);
  let svc = sharedServices.get(key);
  if (svc === undefined) {
    svc = createBrowserSchemeLanguageService(options as SchemeLanguageServiceOptions);
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
  port.onmessage = (ev) => {
    const msg = ev.data as LsInit | LsCall;
    try {
      if (msg.kind === "init") {
        service = serviceFor(msg.options);
        port.postMessage({ kind: "reply", id: msg.id, ok: true, value: null } satisfies LsReply);
        return;
      }
      if (service === null) throw new Error("scheme-ls: call before init");
      if (!(LS_METHODS as readonly string[]).includes(msg.method))
        throw new Error(`scheme-ls: unknown method ${msg.method}`);
      const value = (service[msg.method as MethodName] as (...a: unknown[]) => unknown)(...msg.args);
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
