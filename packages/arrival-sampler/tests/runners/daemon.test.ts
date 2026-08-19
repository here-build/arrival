// daemon.test.ts — the thin-custom daemon control: pidfile paths, liveness probing, status + listing, the
// refuse-if-running guard, and the stop-on-stale / stop-on-absent paths. MODEL-FREE and SPAWN-FREE.
//
// Why spawn-free: a real child process inside vitest's worker pool trips its teardown (forks: "Timeout
// terminating forks worker"; threads: hang). So the branching LOGIC is covered here against two real,
// deterministic pids — `process.pid` (guaranteed live) and `2 ** 30` (above macOS PID_MAX 99999, guaranteed
// ESRCH/dead) — with NO spawn. The two genuinely-OS paths (a real detached spawn, and SIGTERM-ing a real live
// process to "stopped") are integration-level — exercised live by `serve --daemon` then `stop`.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  daemonStatus,
  isProcessAlive,
  listDaemons,
  logFilePath,
  pidFilePath,
  readPidFile,
  startDaemon,
  stopDaemon,
} from "../../src/runners/server/daemon.js";

/** Above macOS PID_MAX (99999) → `process.kill(DEAD_PID, 0)` always throws ESRCH → reads as not-running. */
const DEAD_PID = 2 ** 30;

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(path.join(os.tmpdir(), "arrival-daemon-test-"));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("daemon paths", () => {
  it("pidFilePath / logFilePath are per-port under the base dir", () => {
    expect(pidFilePath(1234, baseDir)).toBe(path.join(baseDir, "1234.pid"));
    expect(logFilePath(1234, baseDir)).toBe(path.join(baseDir, "1234.log"));
  });
});

describe("readPidFile", () => {
  it("null for missing / garbage / non-positive; the number otherwise (whitespace-trimmed)", () => {
    expect(readPidFile(20000, baseDir)).toBeNull();
    writeFileSync(pidFilePath(20001, baseDir), "not-a-number");
    expect(readPidFile(20001, baseDir)).toBeNull();
    writeFileSync(pidFilePath(20002, baseDir), "0");
    expect(readPidFile(20002, baseDir)).toBeNull();
    writeFileSync(pidFilePath(20003, baseDir), "  4242  \n");
    expect(readPidFile(20003, baseDir)).toBe(4242);
  });
});

describe("isProcessAlive", () => {
  it("true for self, false for an out-of-range (guaranteed-dead) pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(DEAD_PID)).toBe(false);
  });
});

describe("daemonStatus", () => {
  it("not-started with no pidfile, running for a live pid, stale for a dead pid", () => {
    expect(daemonStatus(21000, baseDir)).toEqual({ state: "not-started", pid: null });

    writeFileSync(pidFilePath(21001, baseDir), String(process.pid));
    expect(daemonStatus(21001, baseDir)).toEqual({ state: "running", pid: process.pid });

    writeFileSync(pidFilePath(21002, baseDir), String(DEAD_PID));
    expect(daemonStatus(21002, baseDir)).toEqual({ state: "stale", pid: DEAD_PID });
  });
});

describe("listDaemons", () => {
  it("empty for a missing dir; sorted by port; drops files with no readable pid", () => {
    expect(listDaemons(path.join(baseDir, "does-not-exist"))).toEqual([]);

    writeFileSync(pidFilePath(22002, baseDir), String(process.pid));
    writeFileSync(pidFilePath(22001, baseDir), String(process.pid));
    writeFileSync(pidFilePath(22003, baseDir), "garbage"); // unreadable pid → dropped
    const listed = listDaemons(baseDir);
    expect(listed.map((d) => d.port)).toEqual([22001, 22002]);
    expect(listed.map((d) => d.state)).toEqual(["running", "running"]);
    expect(listed[0]?.logPath).toBe(logFilePath(22001, baseDir));
  });
});

describe("startDaemon guard", () => {
  it("refuses when a live daemon already owns the port (no spawn reached)", () => {
    // process.pid is alive → daemonStatus reads "running" → startDaemon must refuse BEFORE spawning anything.
    writeFileSync(pidFilePath(18400, baseDir), String(process.pid));
    expect(() => startDaemon({ port: 18400, cliPath: "/unused", serveArgs: [], baseDir })).toThrow(/already running/);
  });
});

describe("stopDaemon (non-live paths)", () => {
  it("not-started when nothing is there; stale-cleared when only a dead pidfile remains", async () => {
    expect(await stopDaemon({ port: 19000, baseDir })).toBe("not-started");

    writeFileSync(pidFilePath(19001, baseDir), String(DEAD_PID));
    expect(daemonStatus(19001, baseDir).state).toBe("stale");
    expect(await stopDaemon({ port: 19001, baseDir })).toBe("stale-cleared");
    expect(existsSync(pidFilePath(19001, baseDir))).toBe(false);
  });
});
