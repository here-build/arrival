// daemon.ts — thin-custom background-daemon control for `arrival-openai-server`. The supervised process loads
// multi-GB GGUF weights into Mac UNIFIED memory, so we deliberately add ZERO always-on supervisor: a pm2- or
// Oxmgr-class daemon would sit resident next to the model, competing for the one resource (RAM / memory
// bandwidth) inference is already starved for. Instead we re-exec the server DETACHED, track it by a per-port
// pidfile, and stop it with SIGTERM straight into the server's EXISTING graceful shutdown (cli.ts `shutdown`:
// server.close → dispose every resident handle → exit 0). Zero extra process, zero deps, ~zero overhead.
//
// ===============================================================================================================
// HOW TO MIGRATE THIS TO launchd
// ===============================================================================================================
// This thin path gives up exactly two things vs a real supervisor: auto-restart-on-crash and relaunch-at-login.
// The day those matter, graduate to a macOS LaunchAgent — launchd is ALREADY running as the system supervisor,
// so this is STILL zero extra resident process, just delegated to the OS:
//
//   1. Emit  ~/Library/LaunchAgents/build.here.arrival-serve.<port>.plist  with:
//        Label             build.here.arrival-serve.<port>
//        ProgramArguments  [ <process.execPath>, <cliPath>, "serve", "--port", "<port>", ...serveArgs ]
//                          (the FOREGROUND `serve` form — NOT a `--daemon`; launchd owns the lifecycle now)
//        RunAtLoad         true                        ← start at login
//        KeepAlive         { SuccessfulExit: false }   ← restart on crash, but a clean `stop` stays stopped
//        StandardOutPath / StandardErrorPath  <logFilePath(port)>   ← reuse the SAME per-port logfile this module
//                                                                     already writes
//   2. start:   launchctl bootstrap gui/$(id -u) <plist>     (modern API — NOT the deprecated `launchctl load`)
//      stop:    launchctl bootout   gui/$(id -u)/<label>
//      status:  launchctl print     gui/$(id -u)/<label>
//   3. Swap startDaemon / stopDaemon / daemonStatus below for those three launchctl calls. The pidfile + log
//      PATHS and the graceful-SIGTERM contract carry over unchanged. Keep this thin path as the DEFAULT and make
//      launchd opt-in (e.g. `serve --supervised`). A LaunchDaemon (system domain, needs root) is ONLY for true
//      cross-logout persistence — overkill for a single-user dev PoC.
// ===============================================================================================================

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Root for per-port pidfiles + logs. Default `~/.arrival-serve`; override (tests) via the argument. */
export function daemonDir(baseDir: string = path.join(os.homedir(), ".arrival-serve")): string {
  return baseDir;
}

/** `<dir>/<port>.pid` — records the detached server's pid. */
export function pidFilePath(port: number, baseDir?: string): string {
  return path.join(daemonDir(baseDir), `${port}.pid`);
}

/** `<dir>/<port>.log` — the detached server's combined stdout+stderr (append across runs). */
export function logFilePath(port: number, baseDir?: string): string {
  return path.join(daemonDir(baseDir), `${port}.log`);
}

/** The pid recorded for a port, or null when there is no readable / valid pidfile. */
export function readPidFile(port: number, baseDir?: string): number | null {
  const p = pidFilePath(port, baseDir);
  if (!existsSync(p)) return null;
  const pid = Number.parseInt(readFileSync(p, "utf8").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Is `pid` a live process? `kill(pid, 0)` sends NO signal — it only probes existence (ESRCH ⇒ dead) and
 *  permission (EPERM ⇒ alive but owned by another user, which still counts as running). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM ⇒ the process exists but we may not signal it (still "running"). Narrow without a cast.
    return typeof e === "object" && e !== null && "code" in e && e.code === "EPERM";
  }
}

export type DaemonState = "running" | "stale" | "not-started";

/** A port's daemon state: `running` (pidfile + live pid), `stale` (pidfile but the pid is dead — crashed without
 *  cleanup), `not-started` (no pidfile). */
export function daemonStatus(port: number, baseDir?: string): { state: DaemonState; pid: number | null } {
  const pid = readPidFile(port, baseDir);
  if (pid === null) return { state: "not-started", pid: null };
  return { state: isProcessAlive(pid) ? "running" : "stale", pid };
}

/** Every port that has a pidfile (for `ps` / `list`), with its live state. Sorted by port; stale entries kept so
 *  the operator can see — and clean — a crash. */
export function listDaemons(baseDir?: string): { port: number; pid: number; state: DaemonState; logPath: string }[] {
  const dir = daemonDir(baseDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".pid"))
    .map((f) => Number.parseInt(f.slice(0, -".pid".length), 10))
    .filter((port) => Number.isInteger(port))
    .sort((a, b) => a - b)
    .flatMap((port) => {
      const { state, pid } = daemonStatus(port, baseDir);
      return pid === null ? [] : [{ port, pid, state, logPath: logFilePath(port, baseDir) }];
    });
}

/** Spawn the server DETACHED on `port`: re-exec `node <cliPath> serve <serveArgs>`, redirect its combined output
 *  to the per-port logfile, record its pid, and unref so the child outlives THIS process. Refuses if a live
 *  daemon already owns the port. Returns the child pid + the logfile path. */
export function startDaemon(args: {
  port: number;
  cliPath: string;
  serveArgs: readonly string[];
  baseDir?: string;
}): { pid: number; logPath: string } {
  const { port, cliPath, serveArgs, baseDir } = args;
  const existing = daemonStatus(port, baseDir);
  if (existing.state === "running") {
    throw new Error(`arrival-openai-server already running on port ${port} (pid ${existing.pid}); stop it first`);
  }
  mkdirSync(daemonDir(baseDir), { recursive: true });
  const logPath = logFilePath(port, baseDir);
  const logFd = openSync(logPath, "a"); // append: keep prior runs' logs around for post-mortem
  let child;
  try {
    // Re-exec the CURRENT runtime faithfully: process.execArgv carries the node flags this process was launched
    // with. Empty under `node dist/cli.js` (the child is `node dist/cli.js serve …`, unchanged — and the launchd
    // ProgramArguments above are this same shape). Under tsx it carries the --require/--import loader flags, so a
    // `.ts` source (dev / `pnpm smoke`) daemonizes correctly instead of handing a .ts to bare node.
    child = spawn(process.execPath, [...process.execArgv, cliPath, "serve", ...serveArgs], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    // spawn dup'd the fd into the child; release the parent's copy so we never leak it (else a long-lived
    // parent — or a test runner's worker — keeps an unclosed handle open and can't terminate cleanly).
    closeSync(logFd);
  }
  if (child.pid === undefined) throw new Error("failed to spawn arrival-openai-server daemon (no pid)");
  writeFileSync(pidFilePath(port, baseDir), String(child.pid));
  child.unref();
  return { pid: child.pid, logPath };
}

/** Outcome of {@link stopDaemon}: `stopped` (was live, SIGTERM'd to exit), `stale-cleared` (only a dead pidfile
 *  remained — removed), `not-started` (nothing to stop). */
export type StopResult = "stopped" | "stale-cleared" | "not-started";

/** Stop the daemon on `port`: SIGTERM into the server's graceful shutdown, poll up to `timeoutMs` for exit (then
 *  SIGKILL as a backstop), and remove the pidfile. Idempotent — a not-started/stale port just clears any stale
 *  file and reports what it found. */
export async function stopDaemon(args: {
  port: number;
  baseDir?: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<StopResult> {
  const { port, baseDir, timeoutMs = 10_000, pollMs = 100 } = args;
  const { state, pid } = daemonStatus(port, baseDir);
  if (pid === null) return "not-started";
  if (state === "stale") {
    rmSync(pidFilePath(port, baseDir), { force: true });
    return "stale-cleared";
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone between status and kill — fall through to cleanup.
  }
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL"); // backstop: the graceful path overran timeoutMs
    } catch {
      // Raced to exit between the check and the kill.
    }
  }
  rmSync(pidFilePath(port, baseDir), { force: true });
  return "stopped";
}
