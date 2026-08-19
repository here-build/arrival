#!/usr/bin/env node
// smoke.mjs — out-of-process LAUNCH smoke: does the real `cli.ts` boot and serve? This is the one check the
// in-process server.test.ts cannot make — it constructs createOpenAIServer directly, bypassing cli.ts (the
// subcommand dispatch + real-decode wiring + listen). Here we spawn the ACTUAL cli entry, so a regression in it
// (bad import, broken dispatch, real-decode construction throwing) is caught.
//
// NOT a vitest test on purpose: it spawns/binds a real process+port, which trips vitest's worker pool. Run it
// via `pnpm smoke` (= `tsx smoke.mjs`, no build step) — this harness runs under tsx, and re-launches the cli
// SOURCE under that same tsx runtime (process.execArgv carries the loader), so no dist build is needed. Exit 0 =
// launches + serves; non-zero = a launch regression.
//
// Model-free: --no-preload-all + roster-only (no LM Studio / Ollama scan) means no GGUF is ever loaded — we hit
// GET /v1/models, which lists ids without decoding. So this runs anywhere node does, no GPU / native addon.
// Every fetch sends `Connection: close` so no keep-alive socket lingers to stall the server's graceful shutdown.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const ROSTER_ONLY = ["--no-preload-all", "--no-scan-lmstudio", "--no-scan-ollama"];

// Launch the cli SOURCE under the CURRENT runtime (tsx when run via `pnpm smoke`): process.execArgv carries the
// tsx loader flags, so `node <…loader…> src/cli.ts …` runs the .ts — mirrors daemon.ts's own re-exec. Returns
// the argv array for spawn(process.execPath, …).
const cliArgv = (...args) => [...process.execArgv, CLI, ...args];

const log = (m) => console.log(`[smoke] ${m}`);
function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

/** An OS-assigned free port (bind :0, read it, release). */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Poll GET <url> (Connection: close) until it answers 200, or throw after timeoutMs. */
async function waitForServer(url, timeoutMs = 15000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { headers: { connection: "close" } });
      if (res.status === 200) return res;
      await res.body?.cancel();
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`server did not answer ${url} within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Hit GET /v1/models and assert the OpenAI list shape (proves the server is actually serving). */
async function assertModelsShape(baseUrl) {
  const res = await waitForServer(`${baseUrl}/v1/models`);
  const body = await res.json();
  if (body.object !== "list" || !Array.isArray(body.data) || body.data.length === 0) {
    fail(`/v1/models bad shape: ${JSON.stringify(body).slice(0, 200)}`);
  }
  if (body.data[0].object !== "model") fail("/v1/models entry is not object:model");
  log(`/v1/models OK (${body.data.length} models advertised)`);
}

// 1) FOREGROUND launch: spawn the binary, confirm it serves, SIGTERM it, confirm it exits cleanly (the server's
//    graceful shutdown). With Connection: close above, no pooled socket stalls server.close().
async function smokeForeground() {
  const port = await freePort();
  log(`foreground: serve --port ${port}`);
  const child = spawn(process.execPath, cliArgv("serve", "--port", String(port), ...ROSTER_ONLY), {
    stdio: "inherit",
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    await assertModelsShape(`http://127.0.0.1:${port}`);
  } catch (e) {
    child.kill("SIGKILL");
    fail(`foreground: ${e.message}`);
  }
  child.kill("SIGTERM");
  const { code, signal } = await exited;
  if (code !== 0) fail(`foreground server did not exit 0 on SIGTERM (code=${code}, signal=${signal})`);
  log("foreground OK (served, then SIGTERM → exit 0)");
}

// 2) DAEMON lifecycle: serve --daemon → ps lists it → serves → stop → ps empty.
async function smokeDaemon() {
  const port = await freePort();
  log(`daemon: serve --daemon --port ${port}`);
  const start = spawnSync(process.execPath, cliArgv("serve", "--daemon", "--port", String(port), ...ROSTER_ONLY), {
    encoding: "utf8",
  });
  if (start.status !== 0) fail(`serve --daemon exited ${start.status}: ${start.stderr}`);
  try {
    await assertModelsShape(`http://127.0.0.1:${port}`);
    const ps = spawnSync(process.execPath, cliArgv("ps"), { encoding: "utf8" });
    if (!ps.stdout.includes(`port ${port}`)) fail(`ps did not list the daemon on ${port}:\n${ps.stdout}`);
    log("ps lists the running daemon OK");
  } finally {
    const stop = spawnSync(process.execPath, cliArgv("stop", "--port", String(port)), { encoding: "utf8" });
    if (!/stopped daemon/.test(stop.stdout)) fail(`stop did not report stopped:\n${stop.stdout}`);
  }
  const ps2 = spawnSync(process.execPath, cliArgv("ps"), { encoding: "utf8" });
  if (ps2.stdout.includes(`port ${port}`)) fail(`daemon still listed after stop:\n${ps2.stdout}`);
  log("daemon lifecycle OK (started → served → stopped → cleared)");
}

log("launch smoke starting…");
await smokeForeground();
await smokeDaemon();
log("ALL GOOD — the server binary launches and serves.");
process.exit(0);
