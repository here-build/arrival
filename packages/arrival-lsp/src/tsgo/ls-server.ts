// tsgo/ls-server — the REUSABLE types-first artifact: the full tsgo scheme
// service hosted on a worker port, speaking the EXISTING ls-protocol
// (init/call/files — ls-client.ts), so `connectSchemeLs` and every consumer
// of `AsyncSchemeLanguageService` mount it UNCHANGED. The editor gets type
// hints (diagnostics, completions, hover, Σ∩T verdicts) as the FIRST layer;
// the neural layer (ranker / masked generation) attaches later as its own
// lazy worker — smarter functions second, by construction.
//
// Differences from the js-ts ls-server (../ls-server.ts):
//   • methods are AWAITED (the service is async-native — RPC to the wasm);
//   • `(require …)` files go through the service's own setProjectFiles —
//     per-service state, not the sync swap-slot (which RELIED on sync calls);
//   • the wasm source arrives FROM THE CLIENT: `tsgoWasmUrl` rides the init
//     options across postMessage, keeping this library bundler-agnostic —
//     only the consuming APP touches `?url` asset imports.
//
// One service per worker SCOPE (not per options-profile): the browser
// transport claims the scope's `globalThis.fs`, so a scope hosts exactly one
// wasm instance. First init wins and boots it; later inits with a DIFFERENT
// options profile are answered with an error naming the conflict.

// NB `onconnect`/`onmessage` PROPERTY assignments are load-bearing (they
// auto-start MessagePorts; addEventListener would need an explicit
// `port.start()` the LsPort seam doesn't carry) — same rule as ls-server.ts.
/* eslint-disable unicorn/prefer-add-event-listener */

import type { LsCall, LsInit, LsPort, LsReply, SchemeLsWorkerOptions } from "../ls-client.js";
import { createTsgoBrowserTransport } from "./browser-transport.js";
import type { TsgoTransport } from "./client.js";
import { createTsgoSchemeService, type TsgoSchemeService } from "./scheme-service.js";

/** The init options the tsgo worker understands — the wire options plus the
 *  wasm location (and an injectable transport for tests/node hosting). */
export interface TsgoLsWorkerOptions extends SchemeLsWorkerOptions {
  /** URL of tsgo.wasm — same-origin asset resolved by the consuming app
   *  (e.g. vite: `import url from "@here.build/arrival-type-lens/tsgo.wasm?url"`). */
  tsgoWasmUrl?: string;
}

export interface ServeTsgoOptions {
  /** Bundled prelude supplier — defaults to the generated browser bundle. */
  preludeFiles?: () => Map<string, string>;
  /** Transport factory override (tests / node hosting); default boots the
   *  browser transport streaming `tsgoWasmUrl`. */
  transport?: (init: TsgoLsWorkerOptions) => Promise<TsgoTransport> | TsgoTransport;
}

interface ScopeState {
  service: Promise<TsgoSchemeService> | null;
  profile: string | null;
}

async function bootService(init: TsgoLsWorkerOptions, options: ServeTsgoOptions): Promise<TsgoSchemeService> {
  let transport: TsgoTransport;
  if (options.transport === undefined) {
    if (init.tsgoWasmUrl === undefined || init.tsgoWasmUrl === "")
      throw new Error(
        'tsgo-ls: no `tsgoWasmUrl` in the connect options — the app must pass the asset URL (vite: import url from "@here.build/arrival-type-lens/tsgo.wasm?url")',
      );
    transport = await createTsgoBrowserTransport({ wasm: fetch(init.tsgoWasmUrl) });
  } else {
    transport = await options.transport(init);
  }
  let prelude: Map<string, string>;
  if (options.preludeFiles === undefined) {
    const bundle = await import("../prelude-bundle.generated.js");
    prelude = new Map(bundle.PRELUDE_BUNDLE);
  } else {
    prelude = options.preludeFiles();
  }
  return createTsgoSchemeService({
    preludeFiles: prelude,
    transport,
    ...(init.host === undefined ? {} : { host: init.host }),
  });
}

/** The profile key: everything in the init options that shapes the service
 *  (the wasm URL and host prelude — compilerOptions are currently fixed by
 *  the tsgo service's own tsconfig). */
const profileOf = (init: TsgoLsWorkerOptions): string =>
  JSON.stringify({ wasm: init.tsgoWasmUrl ?? null, host: init.host ?? null });

/** Host the tsgo scheme service on one port. Shares ONE service per scope. */
export function serveTsgoSchemeLs(port: LsPort, scope: ScopeState, options: ServeTsgoOptions): void {
  port.onmessage = (ev) => {
    const msg = ev.data as LsInit | LsCall | { kind: "files"; id: number; files: Record<string, string> };
    void (async (): Promise<void> => {
      try {
        if (msg.kind === "init") {
          const profile = profileOf(msg.options as TsgoLsWorkerOptions);
          if (scope.service === null) {
            scope.profile = profile;
            scope.service = bootService(msg.options as TsgoLsWorkerOptions, options);
          } else if (scope.profile !== profile) {
            throw new Error("tsgo-ls: this worker scope already hosts a service with a different options profile");
          }
          await scope.service;
          port.postMessage({ kind: "reply", id: msg.id, ok: true, value: null } satisfies LsReply);
          return;
        }
        if (scope.service === null) throw new Error("tsgo-ls: call before init");
        const service = await scope.service;
        if (msg.kind === "files") {
          await service.setProjectFiles(msg.files);
          port.postMessage({ kind: "reply", id: msg.id, ok: true, value: null } satisfies LsReply);
          return;
        }
        const method = service[msg.method as keyof TsgoSchemeService];
        if (typeof method !== "function") throw new Error(`tsgo-ls: unknown method ${msg.method}`);
        const value = await (method as (...a: unknown[]) => Promise<unknown>).apply(service, msg.args);
        port.postMessage({ kind: "reply", id: msg.id, ok: true, value } satisfies LsReply);
      } catch (error) {
        port.postMessage({
          kind: "reply",
          id: msg.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies LsReply);
      }
    })();
  };
}

/**
 * Attach the tsgo scheme-LS server to this worker scope — SharedWorker
 * (every connecting tab shares the ONE wasm instance: 51MB resident once per
 * browser profile) or dedicated Worker alike. The consuming worker file is
 * two lines; the app passes `tsgoWasmUrl` through connect options.
 */
export function installTsgoSchemeLsWorker(options: ServeTsgoOptions = {}): void {
  const scope: ScopeState = { service: null, profile: null };
  const g = globalThis as unknown as Partial<{ onconnect: ((ev: { ports: readonly LsPort[] }) => void) | null }> &
    Partial<LsPort>;
  if ("onconnect" in g) {
    (g as { onconnect: (ev: { ports: readonly LsPort[] }) => void }).onconnect = (ev) => {
      const port = ev.ports[0];
      if (port !== undefined) serveTsgoSchemeLs(port, scope, options);
    };
  } else if (typeof g.postMessage === "function") {
    serveTsgoSchemeLs(g as LsPort, scope, options);
  }
}
