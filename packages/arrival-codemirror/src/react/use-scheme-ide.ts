import { useEffect, useState } from "react";
import type { LsPort } from "@inhuman.tools/arrival-lsp/ls-client";

import type { SchemeIdeBackend } from "../index.js";

/**
 * Shared/lazy scheme LS (worker > main).
 *
 * Ladder (best first):
 * 1. SharedWorker — off-thread, shared across tabs/editors (one prelude).
 * 2. Worker — per-tab off-thread.
 * 3. In-thread.
 * 4. null (plain editor).
 *
 * Every rung is bounded (rejects on error/timeout) → graceful degrade.
 * Self-contained (bundled prelude + libs). noImplicitAny:false — only proven
 * errors; untyped params are expected at current maturity.
 */
const LS_OPTIONS = { compilerOptions: { noImplicitAny: false } };

/** Boot-time audit of what the lens actually armed (DevTools: `window.__INHUMAN_SCHEME_IDE__`). */
export interface SchemeIdeAudit {
  /** When hostConfig was last written by configureSchemeIdeHost. */
  hostConfiguredAt: string | null;
  /** When the LS backend finished connecting. */
  ideReadyAt: string | null;
  /** Which transport won: shared-worker | worker | main-thread | null. */
  transport: "shared-worker" | "worker" | "main-thread" | null;
  /** Host member names (scheme spelling) at configure time. */
  hostMembers: readonly string[];
  /** Host ambient prelude length (chars). */
  hostPreludeChars: number;
  /** Scheme stdlib preamble source length (chars). */
  schemePreludeChars: number;
  /** First 500 chars of schemePrelude (env defines / register-extension). */
  schemePreludeHead: string;
  /**
   * Whether loadIde ran before configureSchemeIdeHost (boot race).
   * If true, worker may have been init'd with empty host — PRE leaves still load,
   * but host rosettas (require, values-of, …) will be missing until hard reload
   * after a rebuild that waits for the roster.
   */
  loadBeforeHostConfig: boolean;
  /** Canary emit + diagnostics after LS ready (probes PRE builtins + host require). */
  canaries: readonly SchemeIdeCanary[];
  /** Project file paths last pushed for require resolution. */
  projectFileCount: number;
  requireTypeCount: number;
}

export interface SchemeIdeCanary {
  label: string;
  scheme: string;
  /** First line of typelevel program (shows __arr vs $plus$ vs bare). */
  emitHead: string;
  diagnostics: readonly { severity?: string; code?: number; message: string }[];
}

const AUDIT: SchemeIdeAudit = {
  hostConfiguredAt: null,
  ideReadyAt: null,
  transport: null,
  hostMembers: [],
  hostPreludeChars: 0,
  schemePreludeChars: 0,
  schemePreludeHead: "",
  loadBeforeHostConfig: false,
  canaries: [],
  projectFileCount: 0,
  requireTypeCount: 0,
};

function publishAudit(): void {
  if (typeof globalThis === "undefined") return;
  const g = globalThis as { __INHUMAN_SCHEME_IDE__?: SchemeIdeAudit };
  g.__INHUMAN_SCHEME_IDE__ = { ...AUDIT, canaries: [...AUDIT.canaries] };
  console.info(
    "[inhuman scheme-ide audit]",
    {
      transport: AUDIT.transport,
      hostMembers: AUDIT.hostMembers.length,
      hostSample: AUDIT.hostMembers.slice(0, 30),
      schemePreludeChars: AUDIT.schemePreludeChars,
      loadBeforeHostConfig: AUDIT.loadBeforeHostConfig,
      hostConfiguredAt: AUDIT.hostConfiguredAt,
      ideReadyAt: AUDIT.ideReadyAt,
      projectFileCount: AUDIT.projectFileCount,
      requireTypeCount: AUDIT.requireTypeCount,
      canaries: AUDIT.canaries.map((c) => ({
        label: c.label,
        emitHead: c.emitHead,
        diags: c.diagnostics.map((d) => d.message),
      })),
    },
  );
}

/** Read-only snapshot of the last arming (also on `window.__INHUMAN_SCHEME_IDE__`). */
export function getSchemeIdeAudit(): Readonly<SchemeIdeAudit> {
  return { ...AUDIT, canaries: [...AUDIT.canaries] };
}

// ── env name roster (host rosettas + scheme preamble) ────────────────────────
// Lens only knows hand-written builtins. Host + prelude names come from the
// single source of truth in the env; plain data crosses worker boundary.
let hostConfig: {
  host?: { prelude: string; members: readonly string[]; kwargsMembers?: readonly string[] };
  schemePrelude?: string;
} = {};

/** Resolves when configureSchemeIdeHost has run at least once (or timeout). */
let hostConfigSeen = false;
let hostConfigWaiters: Array<() => void> = [];

function notifyHostConfig(): void {
  hostConfigSeen = true;
  const waiters = hostConfigWaiters;
  hostConfigWaiters = [];
  for (const w of waiters) w();
}

/** Wait until host roster is published, or `ms` elapses (boot race barrier). */
function waitForHostConfig(ms: number): Promise<void> {
  if (hostConfigSeen) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      hostConfigWaiters = hostConfigWaiters.filter((w) => w !== done);
      resolve();
    }, ms);
    const done = (): void => {
      clearTimeout(t);
      resolve();
    };
    hostConfigWaiters.push(done);
  });
}

/** Supply the env-derived name roster (host rosettas + scheme stdlib preamble)
 *  to the scheme IDE. Call once at app boot, before {@link preloadSchemeIde}. */
export function configureSchemeIdeHost(config: {
  host?: { prelude: string; members: readonly string[]; kwargsMembers?: readonly string[] };
  schemePrelude?: string;
}): void {
  hostConfig = config;
  AUDIT.hostConfiguredAt = new Date().toISOString();
  AUDIT.hostMembers = [...(config.host?.members ?? [])];
  AUDIT.hostPreludeChars = config.host?.prelude?.length ?? 0;
  AUDIT.schemePreludeChars = config.schemePrelude?.length ?? 0;
  AUDIT.schemePreludeHead = (config.schemePrelude ?? "").slice(0, 500);
  notifyHostConfig();
  console.info(
    "[inhuman scheme-ide] configureSchemeIdeHost",
    {
      members: AUDIT.hostMembers.length,
      sample: AUDIT.hostMembers.slice(0, 40),
      kwargsMembers: config.host?.kwargsMembers?.length ?? 0,
      schemePreludeChars: AUDIT.schemePreludeChars,
      hostPreludeChars: AUDIT.hostPreludeChars,
      // Spot-check names that _util.scm / custdev need
      has: {
        require: AUDIT.hostMembers.includes("require"),
        "values-of": AUDIT.hostMembers.includes("values-of"),
        append: AUDIT.hostMembers.includes("append"),
        "+": AUDIT.hostMembers.includes("+"),
        "number->string": AUDIT.hostMembers.includes("number->string"),
        join: AUDIT.hostMembers.includes("join"),
      },
    },
  );
  publishAudit();
}

let idePromise: Promise<SchemeIdeBackend | null> | null = null;

async function workerBackend(shared: boolean): Promise<SchemeIdeBackend> {
  const { connectSchemeLs } = await import("@inhuman.tools/arrival-lsp/ls-client");
  const connectOptions = { ...LS_OPTIONS, ...hostConfig };
  // Inline new URL(...) — bundlers only recognize this exact pattern for
  // worker bundling. Hoisting the URL breaks it.
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
    // Worker load failure never answers; error event is the early exit
    // (connect timeout is the backstop).
    (target as Worker).addEventListener("error", (e) => {
      reject(new Error(`scheme-ls worker error: ${(e as ErrorEvent).message ?? "load failed"}`));
    });
    connectSchemeLs(port, connectOptions).then(resolve, reject);
  });
}

// ── `(require …)` plumbing ───────────────────────────────────────────────────
// Lens is FS-blind. Host pushes files + require types. Worker rungs get push
// callbacks; in-thread reads the table directly.
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
  AUDIT.projectFileCount = Object.keys(files).length;
  pushFiles?.(files);
}

/** Publish data-file require TYPES (`{ path → TS type string }`) so a
 *  `(require "data.json")` resolves to its precise shape. Synthesize host-side
 *  via the loader registry's `resolveRequireType`. Replace-wholesale; pairs with
 *  `setSchemeIdeFiles`. */
export function setSchemeIdeRequireTypes(types: Record<string, string>): void {
  requireTypes = types;
  AUDIT.requireTypeCount = Object.keys(types).length;
  pushRequireTypes?.(types);
}

/** Canary probes — PRE builtins (should resolve without host) + value-position ops. */
const CANARY_PROBES: readonly { label: string; scheme: string }[] = [
  { label: "call:+", scheme: "(define x (+ 1 2))" },
  { label: "value:+", scheme: "(define x +)" },
  { label: "call:append", scheme: "(define x (append (list 1) (list 2)))" },
  { label: "value:append", scheme: "(define x append)" },
  { label: "call:number->string", scheme: "(define x (number->string 42))" },
  { label: "value:number->string", scheme: "(define x number->string)" },
  { label: "call:join", scheme: '(define x (join "," (list "a" "b")))' },
  { label: "call:require", scheme: '(define x (require "people.json"))' },
];

async function runCanaries(backend: SchemeIdeBackend): Promise<void> {
  const out: SchemeIdeCanary[] = [];
  for (const p of CANARY_PROBES) {
    try {
      const anyBackend = backend as unknown as {
        getTypelevelProgram?: (s: string) => Promise<string> | string;
      };
      const emit =
        typeof anyBackend.getTypelevelProgram === "function"
          ? await anyBackend.getTypelevelProgram(p.scheme)
          : "(no getTypelevelProgram)";
      const diags = await backend.getSemanticDiagnostics(p.scheme);
      out.push({
        label: p.label,
        scheme: p.scheme,
        emitHead: String(emit).split("\n")[0] ?? "",
        diagnostics: diags.map((d) => ({
          severity: d.severity,
          code: d.code,
          message: d.messageText ?? (d as { message?: string }).message ?? String(d),
        })),
      });
    } catch (e) {
      out.push({
        label: p.label,
        scheme: p.scheme,
        emitHead: `(canary error: ${e instanceof Error ? e.message : String(e)})`,
        diagnostics: [],
      });
    }
  }
  AUDIT.canaries = out;
}

function loadIde(): Promise<SchemeIdeBackend | null> {
  idePromise ??= (async () => {
    // Boot race: Studio fire-and-forgets ensureSchemeIdeRoster(); editors may
    // call loadIde first. Wait a short window for configureSchemeIdeHost so the
    // worker init snapshot includes host members + schemePrelude.
    if (!hostConfigSeen) {
      AUDIT.loadBeforeHostConfig = true;
      console.warn(
        "[inhuman scheme-ide] loadIde before configureSchemeIdeHost — waiting up to 3s for roster",
      );
      await waitForHostConfig(3_000);
      if (!hostConfigSeen) {
        console.warn(
          "[inhuman scheme-ide] roster still missing after wait — LS will start with empty host (PRE leaves only)",
        );
      }
    }

    const connectWith = { ...LS_OPTIONS, ...hostConfig };
    console.info("[inhuman scheme-ide] loadIde connecting", {
      hostMembers: connectWith.host?.members?.length ?? 0,
      schemePreludeChars: connectWith.schemePrelude?.length ?? 0,
      loadBeforeHostConfig: AUDIT.loadBeforeHostConfig,
    });

    if (typeof SharedWorker === "function") {
      try {
        const backend = await workerBackend(true);
        AUDIT.transport = "shared-worker";
        wireFilesPush(backend);
        wireRequireTypesPush(backend);
        await finishIdeReady(backend);
        return backend;
      } catch (error) {
        console.warn("scheme LS: SharedWorker unavailable — trying a dedicated worker", error);
      }
    }
    if (typeof Worker === "function") {
      try {
        const backend = await workerBackend(false);
        AUDIT.transport = "worker";
        wireFilesPush(backend);
        wireRequireTypesPush(backend);
        await finishIdeReady(backend);
        return backend;
      } catch (error) {
        console.warn("scheme LS: worker unavailable — falling back to the main thread", error);
      }
    }
    try {
      const m = await import("@inhuman.tools/arrival-lsp/browser");
      // In-thread rung: resolve straight off the live table.
      const backend = m.createBrowserSchemeLanguageService({
        ...LS_OPTIONS,
        ...hostConfig,
        resolveModule: (path) => projectFiles[path] ?? projectFiles[path.replace(/^\.\//, "")] ?? null,
        resolveRequireType: (path) => requireTypes[path] ?? requireTypes[path.replace(/^\.\//, "")] ?? null,
      });
      AUDIT.transport = "main-thread";
      await finishIdeReady(backend);
      return backend;
    } catch (error) {
      console.warn("scheme IDE backend failed to load — editing without type intel", error);
      AUDIT.transport = null;
      publishAudit();
      return null;
    }
  })();
  return idePromise;
}

async function finishIdeReady(backend: SchemeIdeBackend): Promise<void> {
  AUDIT.ideReadyAt = new Date().toISOString();
  await runCanaries(backend);
  publishAudit();
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

/** The shared IDE backend as a PROMISE — the non-hook seam for imperative
 *  consumers (a ProseMirror node view, a plain CodeMirror host) that can't call
 *  `useSchemeIde`. Same memoized singleton `useSchemeIde`/`preloadSchemeIde` wrap
 *  (`configureSchemeIdeHost`'s roster + `setSchemeIdeFiles`/`RequireTypes` apply the
 *  same way); resolves `null` when the backend is unavailable. */
export function loadSchemeIde(): Promise<SchemeIdeBackend | null> {
  return loadIde();
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
