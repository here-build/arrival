#!/usr/bin/env node
// cli.ts — the runnable entry. Dispatches a leading SUBCOMMAND (serve / list / ps / stop / help); with no verb
// it defaults to `serve` so the historical flat invocation keeps working. `serve` wires the REAL decode (GPU)
// into the HTTP server and listens — the only place the real, model-loading decode is constructed, so importing
// the rest of the package (handler/translation/types) never pulls in node-llama-cpp. `serve --daemon` detaches
// the same server into the background (see daemon.ts); `ps`/`stop` manage those daemons; `list` prints the
// resolvable models. Run `help` for the full surface.
//
// USAGE (after `pnpm build` in the package, or via tsx):
//   node dist/cli.js --port 1234 --model Arch-Agent-1.5B            # foreground (implicit `serve`)
//   node dist/cli.js serve --port 1234 --daemon                    # background; stop with `stop --port 1234`
//   node dist/cli.js list                                          # every resolvable model (roster + scans)
//   node dist/cli.js ps                                            # running daemons
//   node dist/cli.js stop --port 1234                              # stop a daemon
//   node dist/cli.js --port 1234 --model /abs/path/to/model.gguf
//   node dist/cli.js --port 1234 --idle-timeout 300 --max-resident 1
//   node dist/cli.js --port 1234 --preload-all / --no-preload-all  # warm the whole roster (default ON in dev)
//   node dist/cli.js --port 1234 --models-dir /path/to/ggufs       # scan an extra gguf tree (repeatable)
//   node dist/cli.js --port 1234 --no-scan-lmstudio --no-scan-ollama   # roster only
//
// Besides the sampler's own roster, the server auto-discovers GGUFs already on disk from LM Studio
// (~/.lmstudio/models) and Ollama (~/.ollama/models) when those stores exist — so any model you've pulled there
// is served by its id with no extra setup. `--lmstudio-dir` / `--ollama-dir` (or env LMSTUDIO_MODELS_DIR /
// OLLAMA_MODELS) relocate the stores; `--no-scan-lmstudio` / `--no-scan-ollama` turn a store off.
//
// Point a harness at  http://localhost:1234/v1  as its base_url (OPENAI_BASE_URL). See README.md.
//
// The server is a drop-in LM-Studio-like endpoint: models are JIT-loaded on first request, reused across
// requests, offloaded after `--idle-timeout` seconds idle, and LRU-evicted at `--max-resident` capacity. With
// `--preload-all` it ALSO warms every resolvable roster model at startup, up to a RAM budget (Mac unified
// memory), raising `--max-resident` to hold the warmed set.

import { existsSync } from "node:fs";
import os from "node:os";
import { parseArgs } from "node:util";

import { listDaemons, startDaemon, stopDaemon, type StopResult } from "./daemon.js";
import {
  resolvableRosterModels,
  resolveEnv,
  ROSTER_DIR,
  DEFAULT_LMSTUDIO_DIR,
  DEFAULT_OLLAMA_DIR,
  type Source,
} from "./model-resolve.js";
import { preloadBudgetBytes, selectPreloadSet } from "./preload.js";
import { makeRealDecode, type RealDecodeOptions } from "./real-decode.js";
import { createOpenAIServer, type ServerOptions } from "./server.js";

interface CliArgs {
  readonly port: number;
  readonly model?: string;
  readonly host: string;
  /** Idle seconds before a model is offloaded (≤ 0 disables). Env: OPENAI_SERVER_IDLE_TIMEOUT_SEC. */
  readonly idleTimeoutSec?: number;
  /** Max simultaneously-resident models. Env: OPENAI_SERVER_MAX_RESIDENT. */
  readonly maxResident?: number;
  /** Warm every resolvable roster model at startup (up to the RAM budget). Default: ON in dev, OFF in prod.
   *  Env: OPENAI_SERVER_PRELOAD_ALL. */
  readonly preloadAll: boolean;
  /** Extra arbitrary gguf trees to scan (repeatable `--models-dir`). */
  readonly modelsDirs: readonly string[];
  /** The LM Studio store dir (env LMSTUDIO_MODELS_DIR, default ~/.lmstudio/models). */
  readonly lmstudioDir: string;
  /** The Ollama store dir (env OLLAMA_MODELS, default ~/.ollama/models). */
  readonly ollamaDir: string;
  /** Scan the LM Studio store. Default: ON iff its dir exists; `--no-scan-lmstudio` forces off. */
  readonly scanLmstudio: boolean;
  /** Scan the Ollama store. Default: ON iff its dir exists; `--no-scan-ollama` forces off. */
  readonly scanOllama: boolean;
  /** `serve --daemon`: detach into the background (pidfile under ~/.arrival-serve) instead of running in the
   *  foreground. Stop it later with `stop --port <N>`. */
  readonly daemon: boolean;
}

/** Read a numeric env var, or undefined when unset/blank/non-numeric. */
function envNum(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Read a boolean env var (`1`/`true`/`yes`/`on` ⇒ true, `0`/`false`/`no`/`off` ⇒ false), or undefined when
 *  unset/blank/unrecognized (so the caller can apply its own default). */
function envBool(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

/** Resolve flags + env + built-in defaults into CliArgs. `node:util` parseArgs does the tokenizing (declarative
 *  options table below — `-p`/`-m`/`-h` shorts, `--flag value` / `--flag=value`, the repeatable `--models-dir`,
 *  and — with `strict` — REJECTING an unknown/typo'd flag instead of silently dropping it). This function only
 *  maps the parsed values onto our domain shape + applies precedence: per field, CLI flag > env > default
 *  (5 min idle / 1 resident from the ModelManager; preload-all dev⇒on / prod⇒off; store paths from env then the
 *  home default; a store auto-scans iff its dir exists unless `--no-scan-*`). The `no-*` negations are explicit
 *  options — parseArgs does not synthesize them. */
function parseCliArgs(argv: readonly string[]): CliArgs {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      port: { type: "string", short: "p" },
      model: { type: "string", short: "m" },
      host: { type: "string", short: "h" },
      "idle-timeout": { type: "string" },
      "max-resident": { type: "string" },
      "preload-all": { type: "boolean" },
      "no-preload-all": { type: "boolean" },
      daemon: { type: "boolean" },
      "models-dir": { type: "string", multiple: true },
      "lmstudio-dir": { type: "string" },
      "ollama-dir": { type: "string" },
      "no-scan-lmstudio": { type: "boolean" },
      "no-scan-ollama": { type: "boolean" },
    },
  });

  // Numbers: CLI flag wins, else env, else the built-in default. parseArgs yields strings; we coerce.
  const port = values.port !== undefined ? Number(values.port) : 1234;
  if (!Number.isFinite(port)) throw new Error(`--port must be a number (got ${JSON.stringify(values.port)})`);
  const idleTimeoutSec =
    values["idle-timeout"] !== undefined ? Number(values["idle-timeout"]) : envNum("OPENAI_SERVER_IDLE_TIMEOUT_SEC");
  const maxResident =
    values["max-resident"] !== undefined ? Number(values["max-resident"]) : envNum("OPENAI_SERVER_MAX_RESIDENT");

  // preload-all: `--no-preload-all` wins over `--preload-all` wins over env wins over the env-derived default.
  const preloadAll = values["no-preload-all"]
    ? false
    : values["preload-all"]
      ? true
      : (envBool("OPENAI_SERVER_PRELOAD_ALL") ?? resolveEnv() === "dev");

  // Store dirs: CLI flag wins over env wins over the home default.
  const lmstudioDir = values["lmstudio-dir"] ?? (process.env.LMSTUDIO_MODELS_DIR?.trim() || DEFAULT_LMSTUDIO_DIR);
  const ollamaDir = values["ollama-dir"] ?? (process.env.OLLAMA_MODELS?.trim() || DEFAULT_OLLAMA_DIR);

  return {
    port,
    host: values.host ?? "127.0.0.1",
    preloadAll,
    modelsDirs: values["models-dir"] ?? [],
    lmstudioDir,
    ollamaDir,
    daemon: values.daemon ?? false,
    scanLmstudio: values["no-scan-lmstudio"] !== true && existsSync(lmstudioDir),
    scanOllama: values["no-scan-ollama"] !== true && existsSync(ollamaDir),
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(idleTimeoutSec === undefined || !Number.isFinite(idleTimeoutSec) ? {} : { idleTimeoutSec }),
    ...(maxResident === undefined || !Number.isFinite(maxResident) ? {} : { maxResident }),
  };
}

/** Build the ordered source list from parsed args, in PRECEDENCE order: the sampler roster, any `--models-dir`
 *  trees, then the LM Studio / Ollama stores (each included only when its scan is on). */
function buildSources(args: CliArgs): Source[] {
  const sources: Source[] = [{ kind: "roster", dir: ROSTER_DIR }];
  for (const dir of args.modelsDirs) sources.push({ kind: "models-dir", dir });
  if (args.scanLmstudio) sources.push({ kind: "lmstudio", dir: args.lmstudioDir });
  if (args.scanOllama) sources.push({ kind: "ollama", dir: args.ollamaDir });
  return sources;
}

/** Format a byte count as a 1-decimal GiB string, for the startup log. */
function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** `serve` (foreground): wire the REAL decode into the HTTP server and listen until SIGINT/SIGTERM. This is the
 *  body a `serve --daemon` child re-execs (with `--daemon` stripped) — the detached process IS the server. */
function runServerForeground(args: CliArgs): void {
  // The ordered source list (roster + any --models-dir + the auto-detected stores) — shared by resolution
  // (real-decode), advertising (/v1/models) and the preload set, so all three agree on what's loadable.
  const sources = buildSources(args);

  // Preload planning (pure): if --preload-all, enumerate the resolvable models ACROSS sources and greedily pick
  // the set that fits the RAM budget. `maxResident` is RAISED to hold the warmed set (so warming never
  // self-evicts). The budget's smallest-first / 80%-of-RAM cap guards against a huge on-disk store.
  let preloadIds: readonly string[] = [];
  let maxResident = args.maxResident;
  if (args.preloadAll) {
    const models = resolvableRosterModels(sources);
    const selection = selectPreloadSet(models, os.totalmem());
    preloadIds = selection.ids;
    if (selection.maxResident > 0) maxResident = Math.max(args.maxResident ?? 1, selection.maxResident);
  }

  // Resident-model manager knobs (CLI seconds → ms; undefined ⇒ ModelManager defaults: 5 min / 1 resident).
  const decodeOpts: RealDecodeOptions = {
    sources,
    ...(args.idleTimeoutSec === undefined ? {} : { idleTimeoutMs: args.idleTimeoutSec * 1000 }),
    ...(maxResident === undefined ? {} : { maxResident }),
  };
  const { decode, dispose, residentIds, preload } = makeRealDecode(decodeOpts);

  const serverOpts: ServerOptions = {
    decode,
    residentIds,
    sources,
    ...(args.model === undefined ? {} : { defaultModel: args.model }),
  };
  const server = createOpenAIServer(serverOpts);

  server.listen(args.port, args.host, () => {
    const idle = args.idleTimeoutSec ?? 300;
    const maxR = maxResident ?? 1;
    // eslint-disable-next-line no-console
    console.log(
      `[openai-server] listening on http://${args.host}:${args.port}/v1` +
        (args.model ? `  (default model: ${args.model})` : "  (no default model — request must set `model`)"),
    );
    // eslint-disable-next-line no-console
    console.log(
      `[openai-server] resident-model manager: idle-offload ${idle <= 0 ? "DISABLED" : `${idle}s`}, max-resident ${maxR}`,
    );
    // eslint-disable-next-line no-console
    console.log(`[openai-server] model sources: ${sources.map((s) => `${s.kind}(${s.dir})`).join("  ·  ")}`);
    // eslint-disable-next-line no-console
    console.log("[openai-server] POST /v1/chat/completions  ·  GET /v1/models");

    // Kick off the warm in the background — the server is already accepting requests; preload only makes the
    // FIRST hit on each model instant. Skipped silently when nothing resolved (e.g. no GGUFs downloaded yet).
    if (args.preloadAll && preloadIds.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[openai-server] preload-all: warming ${preloadIds.length} model(s) ` +
          `(budget ${gib(preloadBudgetBytes(os.totalmem()))} of ${gib(os.totalmem())} RAM, Mac unified memory)`,
      );
      void preload(preloadIds).then((warmed) => {
        // eslint-disable-next-line no-console
        console.log(`[openai-server] preload-all: ${warmed.length}/${preloadIds.length} resident — ${warmed.join(", ")}`);
      });
    }
  });

  const shutdown = (): void => {
    // eslint-disable-next-line no-console
    console.log("\n[openai-server] shutting down…");
    server.close(() => {
      void dispose().finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** `serve --daemon`: detach the foreground server into the background, recording its pid under ~/.arrival-serve.
 *  We re-exec THIS cli with `--daemon` stripped (so the child runs the foreground server), keyed by port. */
function cmdServeDaemon(args: CliArgs, rawServeArgs: readonly string[]): void {
  const cliPath = process.argv[1];
  if (cliPath === undefined) {
    throw new Error("cannot locate this CLI to re-exec as a daemon (process.argv[1] is unset)");
  }
  const serveArgs = rawServeArgs.filter((a) => a !== "--daemon");
  const { pid, logPath } = startDaemon({ port: args.port, cliPath, serveArgs });
  // eslint-disable-next-line no-console
  console.log(`[openai-server] daemon listening on port ${args.port} (pid ${pid})`);
  // eslint-disable-next-line no-console
  console.log(`[openai-server]   logs: ${logPath}`);
  // eslint-disable-next-line no-console
  console.log(`[openai-server]   ps:   arrival-openai-server ps`);
  // eslint-disable-next-line no-console
  console.log(`[openai-server]   stop: arrival-openai-server stop --port ${args.port}`);
}

/** `list`: print every model resolvable across the configured sources (roster + scans) — the ids `/v1/models`
 *  advertises and a request `model` resolves, with their source + on-disk size. */
function cmdList(args: CliArgs): void {
  const sources = buildSources(args);
  const models = resolvableRosterModels(sources);
  if (models.length === 0) {
    // eslint-disable-next-line no-console
    console.log("No models resolvable. Sources scanned:");
    for (const s of sources) {
      // eslint-disable-next-line no-console
      console.log(`  ${s.kind.padEnd(11)} ${s.dir}`);
    }
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`${models.length} model(s) resolvable across ${sources.length} source(s):`);
  for (const m of models) {
    // eslint-disable-next-line no-console
    console.log(`  ${m.id.padEnd(40)} ${m.source.padEnd(11)} ${gib(m.sizeBytes).padStart(9)}`);
  }
}

/** `ps`: print every running (or stale) server daemon, by port — pid, state, and its logfile. */
function cmdPs(): void {
  const daemons = listDaemons();
  if (daemons.length === 0) {
    // eslint-disable-next-line no-console
    console.log("No arrival-openai-server daemons. Start one with `serve --daemon --port <N>`.");
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`${daemons.length} daemon(s):`);
  for (const d of daemons) {
    // eslint-disable-next-line no-console
    console.log(
      `  port ${String(d.port).padEnd(6)} pid ${String(d.pid).padEnd(8)} ${d.state.padEnd(12)} ${d.logPath}`,
    );
  }
}

/** `stop --port <N>`: SIGTERM the daemon on that port into its graceful shutdown (or clear a stale pidfile). */
async function cmdStop(args: CliArgs): Promise<void> {
  const result: StopResult = await stopDaemon({ port: args.port });
  const message: Record<StopResult, string> = {
    stopped: `stopped daemon on port ${args.port}`,
    "stale-cleared": `cleared a stale pidfile on port ${args.port} (process was already gone)`,
    "not-started": `no daemon on port ${args.port}`,
  };
  // eslint-disable-next-line no-console
  console.log(`[openai-server] ${message[result]}`);
}

/** `help`: the subcommands + the flags they share. */
function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      "arrival-openai-server — OpenAI-compatible local server for the constrained-Scheme sampler",
      "",
      "USAGE:",
      "  arrival-openai-server [serve] [flags]      start the server in the FOREGROUND (default)",
      "  arrival-openai-server serve --daemon [flags]   start it in the BACKGROUND (pidfile ~/.arrival-serve)",
      "  arrival-openai-server list [scan-flags]    list every resolvable model (roster + LM Studio + Ollama)",
      "  arrival-openai-server ps                   list running daemons (port, pid, state, log)",
      "  arrival-openai-server stop --port <N>      stop the daemon on a port (graceful SIGTERM)",
      "  arrival-openai-server help                 this message",
      "",
      "SERVE FLAGS:",
      "  -p, --port <N>            listen port (default 1234)",
      "  -m, --model <id|path>     default model when a request omits `model`",
      "  -h, --host <addr>         bind address (default 127.0.0.1)",
      "  --idle-timeout <sec>      offload a model after this idle period (≤0 disables)",
      "  --max-resident <N>        max simultaneously-resident models (LRU-evict above)",
      "  --preload-all | --no-preload-all   warm the whole roster at startup (default ON in dev)",
      "  --daemon                  detach into the background (serve only)",
      "",
      "SCAN FLAGS (serve + list):",
      "  --models-dir <dir>        scan an extra gguf tree (repeatable)",
      "  --lmstudio-dir <dir>      LM Studio store (env LMSTUDIO_MODELS_DIR, default ~/.lmstudio/models)",
      "  --ollama-dir <dir>        Ollama store (env OLLAMA_MODELS, default ~/.ollama/models)",
      "  --no-scan-lmstudio | --no-scan-ollama   skip a store (else auto-scanned when it exists)",
      "",
      "Point a harness at  http://<host>:<port>/v1  as its OPENAI_BASE_URL.",
    ].join("\n"),
  );
}

/** The set of leading verbs that select a subcommand. Anything else (a flag, or nothing) defaults to `serve`,
 *  so the historical `node cli.js --port 1234` invocation keeps working unchanged. */
const SUBCOMMANDS = new Set(["serve", "list", "ps", "stop", "help"]);

function main(): void {
  const argv = process.argv.slice(2);
  const first = argv[0];
  const hasVerb = first !== undefined && SUBCOMMANDS.has(first);
  const cmd = hasVerb ? first : "serve";
  const rest = hasVerb ? argv.slice(1) : argv;

  switch (cmd) {
    case "help":
      printHelp();
      return;
    case "ps":
      cmdPs();
      return;
    case "list":
      cmdList(parseCliArgs(rest));
      return;
    case "stop":
      void cmdStop(parseCliArgs(rest));
      return;
    case "serve":
    default: {
      const args = parseCliArgs(rest);
      if (args.daemon) cmdServeDaemon(args, rest);
      else runServerForeground(args);
      return;
    }
  }
}

try {
  main();
} catch (e) {
  // Surface a usage error cleanly: parseArgs throws on an unknown/typo'd flag or a missing value, and parseCliArgs
  // throws on a bad number — all with good messages. Print the message (not a stack trace) and exit non-zero.
  // (`serve` then runs the server on the event loop, OUTSIDE this try, so a live server is unaffected.)
  // eslint-disable-next-line no-console
  console.error(`[openai-server] ${e instanceof Error ? e.message : String(e)}`);
  // eslint-disable-next-line no-console
  console.error("Run `arrival-openai-server help` for usage.");
  process.exit(1);
}
