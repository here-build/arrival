// tsgo/client — the wire client for `tsgo --api -async`: JSON-RPC 2.0 in LSP
// base-protocol framing (Content-Length headers) over an injected byte
// transport, plus the server→client VIRTUAL-FS callback service.
//
// WHY OUR OWN CLIENT (and not `@typescript/native-preview`'s `./unstable/*`):
// the official JS API client is explicitly unstable, its wire protocol is
// unversioned (client and binary must be commit-matched), and its shipped
// transports assume a native SUBPROCESS. We pin the tsgo build ourselves
// (.tsgo/COMMIT) and speak the protocol directly — ~150 lines we control vs an
// npm internal that may break daily. The surface this file types is the SUBSET
// the lens consumes; see proto.go in the pinned typescript-go commit.
//
// FS callbacks: `tsgo --api -callbacks readFile,…` delegates file IO to us —
// the same virtual-file world the JS-TS LanguageServiceHost served, now served
// over RPC. `readFile` replies are THREE-STATE: `{content: string}` = served,
// `{content: null}` = does not exist (hermetic — never fall through for our
// virtual paths), bare `null` = fall through to the server's base fs — used
// ONLY for `bundled:///…`, tsgo's embedded lib.d.ts world (go:embed), which
// the callback layer wraps and must not shadow.

/** Byte transport to a running `tsgo --api -async` instance. Node: a spawned
 *  `node wasm_exec_node.js tsgo.wasm` child's stdio; browser (later): the
 *  virtual-stdio shim of a wasm instance in this worker. */
export interface TsgoTransport {
  write(data: Uint8Array): void;
  onData(callback: (chunk: Uint8Array) => void): void;
  /** Liveness: fires once when the server side dies (process exit / wasm trap). */
  onExit(callback: (reason: string) => void): void;
  close(): void;
}

// ── the typed subset of the API protocol (proto.go of the pinned commit) ────
// Handle ids are snapshot-scoped on the server (per-snapshot registries): a
// TypeId/SymbolId/SignatureId is valid only against the snapshot it came from.

/* eslint-disable sonarjs/redundant-type-aliases -- the ids are all wire-numbers, but each alias names a DIFFERENT server-side registry; the names are the documentation of which id goes where */
export type SnapshotId = number;
export type ProjectId = string;
export type TypeId = number;
export type SymbolId = number;
export type SignatureId = number;
/* eslint-enable sonarjs/redundant-type-aliases */

export interface TsgoProject {
  id: ProjectId;
  configFileName: string;
  rootFiles: string[];
}
export interface UpdateSnapshotResult {
  snapshot: SnapshotId;
  projects: TsgoProject[];
}
export interface SymbolRef {
  id: SymbolId;
  name: string;
  flags: number;
}
export interface TypeRef {
  id: TypeId;
  flags: number;
}
export interface SignatureRef {
  id: SignatureId;
  flags: number;
  parameters?: SymbolId[];
}
export interface TsgoDiagnostic {
  fileName?: string;
  pos: number;
  end: number;
  code: number;
  category: number;
  text: string;
}

/** `ts.SymbolFlags.Value` — the meaning mask for value-position name lookup
 *  (variables, functions, properties…). Same bit set in strada and tsgo. */
export const SYMBOL_FLAGS_VALUE = 111_551;
/** `checker.SignatureKindCall` (iota 0 in tsgo, same as strada). */
export const SIGNATURE_KIND_CALL = 0;

interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Frame a JSON-RPC message in the LSP base protocol. */
function frame(message: JsonRpcMessage): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", ...message }));
  const header = new TextEncoder().encode(`Content-Length: ${body.length}\r\n\r\n`);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

/** Incremental Content-Length deframer (byte-accurate across chunk seams). */
function makeDeframer(onMessage: (message: JsonRpcMessage) => void): (chunk: Uint8Array) => void {
  let buffer = new Uint8Array(0);
  const decoder = new TextDecoder();
  const HEADER_END = [13, 10, 13, 10]; // \r\n\r\n
  const headerEndAt = (i: number): boolean => HEADER_END.every((byte, j) => buffer[i + j] === byte);
  const findHeaderEnd = (): number => {
    for (let i = 0; i + 3 < buffer.length; i++) if (headerEndAt(i)) return i;
    return -1;
  };
  return (chunk) => {
    const next = new Uint8Array(buffer.length + chunk.length);
    next.set(buffer, 0);
    next.set(chunk, buffer.length);
    buffer = next;
    for (;;) {
      const headerEnd = findHeaderEnd();
      if (headerEnd === -1) return;
      const header = decoder.decode(buffer.subarray(0, headerEnd));
      const match = /Content-Length: (\d+)/i.exec(header);
      if (match === null) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const body = decoder.decode(buffer.subarray(start, start + length));
      buffer = buffer.subarray(start + length);
      onMessage(JSON.parse(body) as JsonRpcMessage);
    }
  };
}

/** The virtual-file store the FS callbacks serve. Mutate `files` freely — the
 *  server re-reads through callbacks on every `updateSnapshot`. */
export interface TsgoVirtualFs {
  /** Full virtual paths (e.g. `/virtual/__pre.d.ts`) → content. */
  files: Map<string, string>;
  /** Directories considered to exist (the files' ancestors are derived). */
  roots: readonly string[];
}

/** Answer one server→client FS callback from the virtual store. */
function answerFsCallback(vfs: TsgoVirtualFs, method: string, path: string): unknown {
  // tsgo's embedded lib.d.ts world — bare null = fall through to the base fs.
  if (path.startsWith("bundled://")) return null;
  switch (method) {
    case "readFile":
      return { content: vfs.files.get(path) ?? null };
    case "fileExists":
      return vfs.files.has(path);
    case "directoryExists":
      return vfs.roots.includes(path) || [...vfs.files.keys()].some((k) => k.startsWith(`${path}/`));
    case "getAccessibleEntries": {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const files: string[] = [];
      const directories = new Set<string>();
      for (const key of vfs.files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) files.push(rest);
        else directories.add(rest.slice(0, slash));
      }
      return { files, directories: [...directories] };
    }
    case "realpath":
      return path;
    default:
      return null;
  }
}

export interface TsgoClient {
  request<T>(method: string, params?: unknown): Promise<T>;
  /** The virtual store the FS callbacks serve (mutate, then `updateSnapshot`). */
  vfs: TsgoVirtualFs;
  close(): void;
}

/** Connect the JSON-RPC client over a transport and serve FS callbacks from
 *  `vfs`. The transport's server must be `tsgo --api -async -callbacks
 *  readFile,fileExists,directoryExists,getAccessibleEntries,realpath`. */
export function createTsgoClient(transport: TsgoTransport, vfs: TsgoVirtualFs): TsgoClient {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();
  let dead: string | null = null;

  transport.onExit((reason) => {
    dead = reason;
    for (const [, entry] of pending) entry.reject(new Error(`tsgo: server exited: ${reason}`));
    pending.clear();
  });

  transport.onData(
    makeDeframer((message) => {
      // server→client request = an FS callback (has method AND id)
      if (message.method !== undefined && message.id !== undefined) {
        const path = (message.params as { path?: string } | undefined)?.path ?? (message.params as string);
        const result = answerFsCallback(vfs, message.method, path);
        transport.write(frame({ id: message.id, result }));
        return;
      }
      if (message.id === undefined) return; // notification — none expected
      const entry = pending.get(message.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      if (message.error === undefined) entry.resolve(message.result);
      else entry.reject(new Error(`tsgo ${entry.method}: ${message.error.message}`));
    }),
  );

  return {
    vfs,
    request<T>(method: string, params?: unknown): Promise<T> {
      if (dead !== null) return Promise.reject(new Error(`tsgo: server exited: ${dead}`));
      return new Promise<T>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
        transport.write(frame({ id, method, params }));
      });
    },
    close(): void {
      transport.close();
    },
  };
}
