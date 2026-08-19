// model-manager.ts — on-demand resident GGUF manager for the LLM wiring.
//
// JIT load/reuse/idle/LRU. Generic over handle for testability. 
//
// LIFECYCLE per model (id is the cache key, like an LM Studio served id):
//   absent ──acquire──▶ LOADING ──load resolves──▶ RESIDENT(in use) ──release──▶ RESIDENT(idle, timer armed)
//      ▲                                                                              │ idle timer fires
//      └────────────────────────── disposed ◀── LRU evict / idle offload ◀───────────┘
//
// CONCURRENCY MODEL (single-threaded JS, so the only races are across `await` points):
//   • A per-manager async MUTEX serializes every MEMBERSHIP change (decide load-vs-reuse, evict, dispose).
//     The actual `await load(...)` happens OUTSIDE the mutex (so a slow load doesn't block reuse of other
//     models), but the load PROMISE is created inside it and stored on the entry — so concurrent acquires of
//     the SAME model share one promise and never double-load.
//   • A per-entry REFCOUNT (leases) makes "dispose can't race a decode" structural: an entry is evictable
//     ONLY at refCount 0, and the idle timer is armed ONLY at refCount 0. A decode in flight holds a lease
//     (refCount ≥ 1), so neither idle-offload nor LRU-eviction can free its handle mid-decode.
//   • Eviction AWAITS the old handle's dispose INSIDE the mutex before the new load starts — so on a
//     one-model-capacity device two handles never coexist ("dispose before load").

/** A scheduler seam for the idle timer — injectable so tests drive a virtual clock with no real timers (and
 *  the production default `unref()`s so an idle timer never keeps the process alive on its own). The callback
 *  may be async (idle offload disposes a handle); a test scheduler awaits it, the default voids it. */
export interface TimerScheduler {
  set(fn: () => void | Promise<void>, ms: number): unknown;
  clear(token: unknown): void;
}

/** The default scheduler: real `setTimeout`, unref'd, with the async callback voided + error-swallowed. */
const defaultScheduler: TimerScheduler = {
  set(fn, ms) {
    const token = setTimeout(() => {
      void Promise.resolve(fn()).catch(() => {});
    }, ms);
    token.unref?.();
    return token;
  },
  clear(token) {
    clearTimeout(token as ReturnType<typeof setTimeout>);
  },
};

/** Options to construct a {@link ModelManager}. `load`/`dispose` are the only required (injected) pieces.
 *  Generic over the handle type `H` (e.g. the real server's `LlamaModelHandle`); defaults to `unknown` for
 *  the model-free tests, which load opaque handle objects. */
export interface ModelManagerOptions<H = unknown> {
  /** Load the handle for a model id (JIT). Called at most once per resident lifetime; concurrent same-id
   *  acquires share the one promise. May reject — the entry is then removed and the rejection surfaces. */
  readonly load: (modelId: string) => Promise<H>;
  /** Free a handle (called on idle offload, LRU eviction, and shutdown). Should be idempotent-safe. */
  readonly dispose: (handle: H) => Promise<void>;
  /** Idle period (ms) of no requests for a model before its handle is offloaded. Default 5 min. `≤ 0`
   *  DISABLES idle offload (handles stay resident until evicted or shutdown). */
  readonly idleTimeoutMs?: number;
  /** Max simultaneously-resident models. Default 1 (Metal realistically holds one). A new model at capacity
   *  LRU-evicts the least-recently-used IDLE model first. */
  readonly maxResident?: number;
  /** Timer seam (tests inject a virtual scheduler). Default: real `setTimeout`. */
  readonly scheduler?: TimerScheduler;
}

/** A held reference to a resident model handle. The decode holds it for the duration of one generation; while
 *  held (refCount ≥ 1) the handle cannot be offloaded or evicted. MUST be released exactly once — `release()`
 *  is idempotent, and the lease is also an `AsyncDisposable` (`await using lease = await mgr.acquire(id)`). */
export interface ModelLease<H = unknown> {
  /** The loaded handle (typed `H`; passed straight back to `generateWithExplain`). */
  readonly handle: H;
  /** Release the lease (decrement refCount; arm the idle timer when it reaches 0). Idempotent. */
  release(): void;
  /** AsyncDisposable: same as {@link release}. */
  [Symbol.asyncDispose](): Promise<void>;
}

/** Internal per-model resident entry. */
interface Entry<H> {
  readonly id: string;
  /** The loaded handle, or undefined while still LOADING. */
  handle: H | undefined;
  /** The in-flight load promise while LOADING; undefined once resolved. */
  loadPromise: Promise<H> | undefined;
  /** Active leases. Evictable + idle-armable only at 0. */
  refCount: number;
  /** Monotonic "last touched" stamp for LRU (bumped on acquire + release). */
  lastUsedSeq: number;
  /** The armed idle-offload timer token, or undefined. */
  idleTimer: unknown;
  /** True once disposal has begun — guards a late lease release / idle fire. */
  disposed: boolean;
}

/** A minimal async mutex: chains exclusive sections so membership changes never interleave across awaits. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    return prev.then(fn).finally(release);
  }
}

/**
 * A resident-model manager. Construct once per server, call {@link acquire} per request (releasing the lease
 * when the decode finishes), and {@link dispose} on shutdown. See the file header for the concurrency model.
 */
export class ModelManager<H = unknown> {
  private readonly opts: Required<Omit<ModelManagerOptions<H>, "load" | "dispose" | "scheduler">> &
    Pick<ModelManagerOptions<H>, "load" | "dispose">;
  private readonly scheduler: TimerScheduler;
  private readonly entries = new Map<string, Entry<H>>();
  private readonly mutex = new Mutex();
  private useCounter = 0;
  /** A one-shot signal resolved when a slot MIGHT have freed (release-to-0, eviction, load failure). Waiters
   *  for capacity await it then retry. Lazily (re)created. */
  private capacitySignal: { promise: Promise<void>; resolve: () => void } | null = null;

  constructor(options: ModelManagerOptions<H>) {
    this.opts = {
      load: options.load,
      dispose: options.dispose,
      idleTimeoutMs: options.idleTimeoutMs ?? 5 * 60 * 1000,
      maxResident: Math.max(1, options.maxResident ?? 1),
    };
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  /** Acquire a lease on `modelId`, loading it JIT if not resident (evicting the LRU idle model first when at
   *  capacity). Reuses a resident handle without reloading. Resolves once the handle is ready; rejects if the
   *  load fails. The returned lease MUST be released when the caller is done. */
  async acquire(modelId: string): Promise<ModelLease<H>> {
    const entry = await this.acquireSlot(modelId);
    if (entry.loadPromise) {
      // Await the (possibly shared) load. On failure the loadPromise body has already removed the entry; our
      // refCount is moot since the entry is gone. Surface the error to the caller (→ a 500 upstream).
      await entry.loadPromise;
    }
    if (entry.handle === undefined) {
      throw new Error(`model-manager: handle missing for ${JSON.stringify(modelId)} after load`);
    }
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      this.release(entry);
    };
    return {
      handle: entry.handle,
      release: releaseOnce,
      [Symbol.asyncDispose]: () => {
        releaseOnce();
        return Promise.resolve();
      },
    };
  }

  /** The ids of every FULLY-RESIDENT (loaded) model, most-recently-used last. Loading entries are excluded. */
  residentIds(): string[] {
    return [...this.entries.values()]
      .filter((e) => e.handle !== undefined && !e.disposed)
      .sort((a, b) => a.lastUsedSeq - b.lastUsedSeq)
      .map((e) => e.id);
  }

  /** Tear down every resident handle (server shutdown). Cancels idle timers; awaits each dispose. */
  async dispose(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const all = [...this.entries.values()];
      this.entries.clear();
      for (const e of all) {
        e.disposed = true;
        this.cancelIdle(e);
        if (e.handle !== undefined) {
          try {
            await this.opts.dispose(e.handle);
          } catch {
            // Best-effort teardown — a failing dispose must not block the rest.
          }
        }
      }
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────────

  /** Membership: return the entry for `modelId` (reused or freshly LOADING), making room (LRU evict) when a
   *  new entry is needed at capacity. Loops, awaiting a capacity signal, if every slot is currently in use. */
  private async acquireSlot(modelId: string): Promise<Entry<H>> {
    for (;;) {
      const result = await this.mutex.runExclusive<{ entry: Entry<H> } | { wait: Promise<void> }>(async () => {
        const existing = this.entries.get(modelId);
        if (existing && !existing.disposed) {
          existing.refCount++;
          existing.lastUsedSeq = ++this.useCounter;
          this.cancelIdle(existing);
          return { entry: existing };
        }
        // Need a brand-new entry. Ensure a free slot (await any eviction's dispose BEFORE we start loading).
        const room = await this.makeRoomFor(modelId);
        if (!room) return { wait: this.waitCapacity() };

        const entry: Entry<H> = {
          id: modelId,
          handle: undefined,
          loadPromise: undefined,
          refCount: 1,
          lastUsedSeq: ++this.useCounter,
          idleTimer: undefined,
          disposed: false,
        };
        // Start the load (runs synchronously up to its first await — i.e. `load()` is invoked here, then
        // suspends — so no nested mutex use and no double-load: concurrent same-id acquires reuse this promise).
        entry.loadPromise = (async () => {
          try {
            const handle = await this.opts.load(modelId);
            entry.handle = handle;
            entry.loadPromise = undefined;
            return handle;
          } catch (e) {
            await this.mutex.runExclusive(async () => {
              if (this.entries.get(modelId) === entry) this.entries.delete(modelId);
            });
            this.notifyCapacity();
            throw e;
          }
        })();
        this.entries.set(modelId, entry);
        return { entry };
      });

      if ("entry" in result) return result.entry;
      await result.wait; // a slot may have freed — retry the membership decision.
    }
  }

  /** Evict LRU IDLE entries until there is room for one more (or return false if every slot is in use). Awaits
   *  each eviction's dispose inside the caller's mutex section, so a new load never overlaps an old handle. */
  private async makeRoomFor(modelId: string): Promise<boolean> {
    while (this.entries.size >= this.opts.maxResident && !this.entries.has(modelId)) {
      const lru = [...this.entries.values()]
        .filter((e) => e.refCount === 0 && !e.disposed && e.handle !== undefined)
        .sort((a, b) => a.lastUsedSeq - b.lastUsedSeq)[0];
      if (!lru) return false; // all resident models are in use — caller must wait.
      await this.disposeEntry(lru);
    }
    return true;
  }

  /** Remove + free one entry (idle offload or LRU eviction). Cancels its idle timer, drops it from the map,
   *  awaits the handle dispose, then signals capacity. */
  private async disposeEntry(entry: Entry<H>): Promise<void> {
    entry.disposed = true;
    this.cancelIdle(entry);
    this.entries.delete(entry.id);
    if (entry.handle !== undefined) {
      await this.opts.dispose(entry.handle);
    }
    this.notifyCapacity();
  }

  /** Lease release: decrement refCount; at 0, arm the idle timer + signal capacity (the entry is now evictable). */
  private release(entry: Entry<H>): void {
    if (entry.disposed) return;
    if (entry.refCount > 0) entry.refCount--;
    entry.lastUsedSeq = ++this.useCounter;
    if (entry.refCount === 0) {
      this.armIdle(entry);
      this.notifyCapacity();
    }
  }

  /** Arm the idle-offload timer for an idle entry (no-op when idle offload is disabled). */
  private armIdle(entry: Entry<H>): void {
    if (this.opts.idleTimeoutMs <= 0) return;
    this.cancelIdle(entry);
    entry.idleTimer = this.scheduler.set(() => this.onIdle(entry), this.opts.idleTimeoutMs);
  }

  /** Cancel a pending idle timer. */
  private cancelIdle(entry: Entry<H>): void {
    if (entry.idleTimer !== undefined) {
      this.scheduler.clear(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }

  /** Idle-timer callback: re-check under the mutex that the entry is still idle + resident, then offload it. */
  private onIdle(entry: Entry<H>): Promise<void> {
    return this.mutex.runExclusive(async () => {
      if (entry.disposed || entry.refCount !== 0) return; // re-acquired since the timer was armed.
      if (this.entries.get(entry.id) !== entry) return; // already replaced/evicted.
      entry.idleTimer = undefined;
      try {
        await this.disposeEntry(entry);
      } catch {
        // An offload dispose failure is logged-and-ignored; the entry is already out of the map.
      }
    });
  }

  /** A promise that resolves the next time a slot might free. */
  private waitCapacity(): Promise<void> {
    if (!this.capacitySignal) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      this.capacitySignal = { promise, resolve };
    }
    return this.capacitySignal.promise;
  }

  /** Wake any capacity waiters (they re-evaluate membership under the mutex). */
  private notifyCapacity(): void {
    const sig = this.capacitySignal;
    if (sig) {
      this.capacitySignal = null;
      sig.resolve();
    }
  }
}
