// tsgo/browser-transport — boot the tsgo wasm INSIDE a (worker) scope and
// expose its stdio as a TsgoTransport, no child process, no SharedArrayBuffer.
//
// Go's js/wasm port routes ALL file IO through a Node-fs-shaped `globalThis.fs`
// object — the host owns the filesystem by construction. We install a VIRTUAL
// STDIO shim before loading Go's runtime glue (`runtime/wasm_exec.js`, which
// only stubs fs/process when they don't already exist — install-then-import
// ordering is load-bearing, hence the dynamic import):
//   • fd 0 (stdin): reads are served from a frame queue; an empty queue PARKS
//     the read callback — Go suspends the reading goroutine and the event loop
//     stays free. `write()` from the client side enqueues bytes and wakes it.
//     This is why no SAB/Atomics dance is needed: callback-deferred reads are
//     the js/wasm port's native blocking model.
//   • fd 1 (stdout): bytes flow to the transport's onData (the JSON-RPC
//     deframer); fd 2 (stderr) decodes to console.error.
//   • everything else: loud ENOSYS — project files arrive via the API's
//     -callbacks channel and the default libs are EMBEDDED in the binary
//     (bundled:///), so a real fs call here is a wiring bug, not a fallback.
//   • `process.cwd` MUST answer (we pass "/" + an explicit `-cwd`): tsgo's
//     `--api` flag default calls os.Getwd() at startup and wasm_exec's stock
//     process stub THROWS from cwd() — boot dies before main without this.
//
// Vendored runtime note: wasm_exec.js is version-coupled to the Go toolchain
// only loosely (stable JS ABI); the tsgo-equivalence suite is the real gate.

import type { TsgoTransport } from "./client.js";

/** Minimal Node-fs error shape wasm_exec's syscalls expect. */
function enosys(): Error & { code: string } {
  return Object.assign(new Error("not implemented"), { code: "ENOSYS" });
}

// The package compiles under the node lib (env-agnostic core); this file is
// browser-worker-targeted, so the wasm/web globals it touches are declared
// MINIMALLY here rather than polluting the whole program with lib.webworker
// (the precedent: worker.ts's SharedScopeLike).
type WasmBytes = ArrayBuffer | ArrayBufferView;
/** Structural stand-in for a fetch `Response` (what instantiateStreaming eats). */
export interface WasmResponseLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}
declare const WebAssembly: {
  instantiate(bytes: WasmBytes, imports: unknown): Promise<{ instance: unknown }>;
  instantiateStreaming(
    source: WasmResponseLike | PromiseLike<WasmResponseLike>,
    imports: unknown,
  ): Promise<{ instance: unknown }>;
};

interface GoRuntime {
  argv: string[];
  env: Record<string, string>;
  importObject: unknown;
  run(instance: unknown): Promise<void>;
}

export interface TsgoBrowserTransportOptions {
  /** The tsgo.wasm bytes: a fetch Response (streamed — preferred), or raw bytes. */
  wasm: WasmResponseLike | PromiseLike<WasmResponseLike> | WasmBytes;
  /** The virtual cwd handed to `-cwd` (default /virtual). */
  cwd?: string;
}

/**
 * Instantiate tsgo (`--api -async`, FS callbacks on) in THIS scope and return
 * the transport plus a ready promise that resolves once the wasm is running.
 * One instance per scope: the shim owns `globalThis.fs`/`process`.
 */
export async function createTsgoBrowserTransport(options: TsgoBrowserTransportOptions): Promise<TsgoTransport> {
  // ── virtual stdio state ─────────────────────────────────────────────────
  const stdinQueue: Uint8Array[] = [];
  let pendingRead: {
    buffer: Uint8Array;
    offset: number;
    length: number;
    callback: (err: Error | null, n?: number) => void;
  } | null = null;
  let dataCallback: ((chunk: Uint8Array) => void) | null = null;
  let exitCallback: ((reason: string) => void) | null = null;
  const stderrDecoder = new TextDecoder();

  const serveRead = (): void => {
    if (pendingRead === null) return;
    const head = stdinQueue[0];
    if (head === undefined) return;
    const { buffer, offset, length, callback } = pendingRead;
    pendingRead = null;
    const n = Math.min(length, head.length);
    buffer.set(head.subarray(0, n), offset);
    if (n < head.length) stdinQueue[0] = head.subarray(n);
    else stdinQueue.shift();
    callback(null, n);
  };

  const writeOut = (fd: number, buf: Uint8Array): number => {
    if (fd === 1) dataCallback?.(new Uint8Array(buf));
    else if (fd === 2) console.error(`[tsgo] ${stderrDecoder.decode(buf)}`);
    else throw enosys();
    return buf.length;
  };

  // ── the fs/process shims (BEFORE the glue import — it stubs only absences) ──
  const scope = globalThis as Record<string, unknown>;
  scope["fs"] = {
    constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1, O_DIRECTORY: -1 },
    writeSync: (fd: number, buf: Uint8Array): number => writeOut(fd, buf),
    write(
      fd: number,
      buf: Uint8Array,
      offset: number,
      length: number,
      position: unknown,
      callback: (err: Error | null, n?: number) => void,
    ): void {
      if (offset !== 0 || length !== buf.length || position !== null) {
        callback(enosys());
        return;
      }
      callback(null, writeOut(fd, buf));
    },
    read(
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: unknown,
      callback: (err: Error | null, n?: number) => void,
    ): void {
      if (fd !== 0 || position !== null) {
        callback(enosys());
        return;
      }
      if (pendingRead !== null) {
        callback(enosys()); // one outstanding stdin read at a time — Go's reader is sequential
        return;
      }
      pendingRead = { buffer, offset, length, callback };
      serveRead();
    },
    // Anything else reaching the real-fs layer is a wiring bug (callbacks own
    // project files; default libs are embedded). Loud, async ENOSYS.
    open: (path: string, _f: unknown, _m: unknown, cb: (e: Error) => void): void => {
      console.error(`[tsgo] unexpected fs.open(${path}) — virtual project files must come via API callbacks`);
      cb(enosys());
    },
    close: (_fd: number, cb: (e: Error | null) => void): void => cb(null),
    fsync: (_fd: number, cb: (e: Error | null) => void): void => cb(null),
    stat: (_p: string, cb: (e: Error) => void): void => cb(enosys()),
    lstat: (_p: string, cb: (e: Error) => void): void => cb(enosys()),
    fstat: (_fd: number, cb: (e: Error) => void): void => cb(enosys()),
    readdir: (_p: string, cb: (e: Error) => void): void => cb(enosys()),
    mkdir: (_p: string, _m: unknown, cb: (e: Error) => void): void => cb(enosys()),
    rmdir: (_p: string, cb: (e: Error) => void): void => cb(enosys()),
    unlink: (_p: string, cb: (e: Error) => void): void => cb(enosys()),
    rename: (_a: string, _b: string, cb: (e: Error) => void): void => cb(enosys()),
    utimes: (_p: string, _a: unknown, _m: unknown, cb: (e: Error) => void): void => cb(enosys()),
    chmod: (_p: string, _m: unknown, cb: (e: Error) => void): void => cb(enosys()),
  };
  // MERGE member-wise, never `??=` the whole object: bundler dev environments
  // (vite/storybook) inject a partial `process` polyfill ({env}) into worker
  // scopes — object-level skip left `cwd` undefined and Go panicked in
  // syscall/js at boot (fs_js.go Value.Call "property cwd is not a function").
  scope["process"] ??= {};
  const proc = scope["process"] as Record<string, unknown>;
  proc["getuid"] ??= () => -1;
  proc["getgid"] ??= () => -1;
  proc["geteuid"] ??= () => -1;
  proc["getegid"] ??= () => -1;
  proc["getgroups"] ??= () => {
    throw enosys();
  };
  proc["pid"] ??= -1;
  proc["ppid"] ??= -1;
  proc["umask"] ??= () => {
    throw enosys();
  };
  proc["cwd"] ??= () => "/"; // load-bearing: os.Getwd() runs at flag-definition time
  proc["chdir"] ??= () => {
    throw enosys();
  };

  // Go's runtime glue — defines globalThis.Go; must see our shims, not stub
  // its own. (`as string` skips tsc module resolution — the .js is copied
  // into dist by the build, not compiled; the literal survives into the
  // emitted JS so bundlers still statically include it in worker chunks.)
  await import("./runtime/wasm_exec.js" as string);
  const GoCtor = (globalThis as unknown as { Go: new () => GoRuntime }).Go;
  const go = new GoCtor();
  go.argv = [
    "tsgo",
    "--api",
    "-async",
    "-callbacks",
    "readFile,fileExists,directoryExists,getAccessibleEntries,realpath",
    "-cwd",
    options.cwd ?? "/virtual",
  ];
  go.env = {};

  const source = options.wasm;
  const { instance } =
    source instanceof ArrayBuffer || ArrayBuffer.isView(source)
      ? await WebAssembly.instantiate(source, go.importObject)
      : await WebAssembly.instantiateStreaming(source, go.importObject);

  // run() resolves when the Go program EXITS — for a server that is an error
  // (or a deliberate close), surfaced through onExit.
  void go.run(instance).then(
    () => exitCallback?.("tsgo exited"),
    (error: unknown) => exitCallback?.(String(error)),
  );

  return {
    write(data: Uint8Array): void {
      stdinQueue.push(data);
      serveRead();
    },
    onData(callback): void {
      dataCallback = callback;
    },
    onExit(callback): void {
      exitCallback = callback;
    },
    close(): void {
      // No process to kill — the hosting worker is the lifetime boundary
      // (callers terminate the worker). Drop the queues so a late read parks.
      stdinQueue.length = 0;
    },
  };
}
