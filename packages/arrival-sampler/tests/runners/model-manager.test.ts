// model-manager.test.ts — the resident-model lifecycle, MODEL-FREE. A counting fake loader stands in for the
// GPU (no gguf, no Metal); a virtual scheduler drives the idle timer deterministically (no real setTimeout).
// Asserts: JIT-load on first request, reuse on repeat (load count stays 1), idle-offload after the timeout,
// LRU-eviction at capacity, no double-load under concurrent same-model acquires, and capacity back-pressure
// when every resident model is in use.

import { describe, it, expect } from "vitest";

import { ModelManager, type TimerScheduler } from "../../src/runners/server/model-manager.js";

/** Flush pending microtasks (and the macrotask queue once) so we can assert that a pending acquire has NOT
 *  yet resolved. */
function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/** A virtual scheduler: timers fire only when the test advances the clock. The idle callback is async (it
 *  disposes a handle) — `advance` awaits it, so a test sees the dispose complete synchronously after advancing. */
class FakeScheduler implements TimerScheduler {
  private timers = new Map<number, { fn: () => void | Promise<void>; due: number }>();
  private seq = 0;
  private now = 0;
  set(fn: () => void | Promise<void>, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { fn, due: this.now + ms });
    return id;
  }
  clear(token: unknown): void {
    this.timers.delete(token as number);
  }
  /** Advance the virtual clock by `ms`, firing (and awaiting) every now-due timer in due order. */
  async advance(ms: number): Promise<void> {
    this.now += ms;
    const due = [...this.timers.entries()].filter(([, t]) => t.due <= this.now).sort((a, b) => a[1].due - b[1].due);
    for (const [id, t] of due) {
      this.timers.delete(id);
      await t.fn();
    }
  }
  /** Number of armed (un-fired, un-cleared) timers — for asserting an idle timer was/ wasn't armed. */
  get armedCount(): number {
    return this.timers.size;
  }
}

/** A counting fake loader: records how many times each id was loaded + the dispose order. `gate` (when set)
 *  makes loads block until released — to overlap concurrent acquires for the double-load test. */
function countingLoader(opts: { gate?: Promise<void> } = {}) {
  const loadCount = new Map<string, number>();
  const disposed: string[] = [];
  /** A distinct handle object per LOAD (so reuse vs reload is observable by identity). */
  const handleByLoad: Record<string, { id: string; n: number }> = {};
  const load = async (id: string): Promise<unknown> => {
    const n = (loadCount.get(id) ?? 0) + 1;
    loadCount.set(id, n);
    if (opts.gate) await opts.gate;
    const handle = { id, n };
    handleByLoad[`${id}#${n}`] = handle;
    return handle;
  };
  const dispose = async (handle: unknown): Promise<void> => {
    disposed.push((handle as { id: string }).id);
  };
  return { load, dispose, loadCount, disposed };
}

describe("ModelManager — JIT load + reuse", () => {
  it("JIT-loads on the first request for a model", async () => {
    const scheduler = new FakeScheduler();
    const { load, dispose, loadCount } = countingLoader();
    const mgr = new ModelManager({ load, dispose, scheduler });

    const lease = await mgr.acquire("A");
    expect(loadCount.get("A")).toBe(1);
    expect((lease.handle as { id: string }).id).toBe("A");
    expect(mgr.residentIds()).toEqual(["A"]);
    lease.release();
  });

  it("reuses a resident handle on repeat requests (load count stays 1, same handle)", async () => {
    const scheduler = new FakeScheduler();
    const { load, dispose, loadCount } = countingLoader();
    const mgr = new ModelManager({ load, dispose, scheduler });

    const l1 = await mgr.acquire("A");
    const h1 = l1.handle;
    l1.release();
    const l2 = await mgr.acquire("A");
    const l3 = await mgr.acquire("A");

    expect(loadCount.get("A")).toBe(1);
    expect(l2.handle).toBe(h1); // identical cached handle — no reload
    expect(l3.handle).toBe(h1);
    l2.release();
    l3.release();
  });
});

describe("ModelManager — idle offload", () => {
  it("disposes a model's handle after idleTimeoutMs of no requests", async () => {
    const scheduler = new FakeScheduler();
    const { load, dispose, loadCount, disposed } = countingLoader();
    const mgr = new ModelManager({ load, dispose, scheduler, idleTimeoutMs: 1000 });

    const lease = await mgr.acquire("A");
    lease.release();
    expect(disposed).toEqual([]); // not yet — still within the idle window
    expect(scheduler.armedCount).toBe(1); // idle timer armed on release

    await scheduler.advance(999);
    expect(disposed).toEqual([]); // not yet due

    await scheduler.advance(1);
    expect(disposed).toEqual(["A"]); // idle timer fired → offloaded
    expect(mgr.residentIds()).toEqual([]);

    // A subsequent request reloads it (the handle was freed).
    const l2 = await mgr.acquire("A");
    expect(loadCount.get("A")).toBe(2);
    l2.release();
  });

  it("does NOT offload while a lease is held, and resets the idle timer on reuse", async () => {
    const scheduler = new FakeScheduler();
    const { load, dispose, disposed } = countingLoader();
    const mgr = new ModelManager({ load, dispose, scheduler, idleTimeoutMs: 1000 });

    const held = await mgr.acquire("A"); // still in use — no idle timer while refCount > 0
    expect(scheduler.armedCount).toBe(0);
    await scheduler.advance(5000);
    expect(disposed).toEqual([]); // an in-use model is never offloaded

    held.release(); // now idle — timer armed
    await scheduler.advance(500);
    const reuse = await mgr.acquire("A"); // reuse cancels the timer, resets idle
    expect(scheduler.armedCount).toBe(0);
    await scheduler.advance(1000);
    expect(disposed).toEqual([]); // the reset prevented the original timer from firing
    reuse.release();
  });

  it("never offloads when idle offload is disabled (idleTimeoutMs ≤ 0)", async () => {
    const scheduler = new FakeScheduler();
    const { load, dispose, disposed } = countingLoader();
    const mgr = new ModelManager({ load, dispose, scheduler, idleTimeoutMs: 0 });
    const lease = await mgr.acquire("A");
    lease.release();
    expect(scheduler.armedCount).toBe(0); // no timer armed
    await scheduler.advance(1_000_000);
    expect(disposed).toEqual([]);
  });
});

describe("ModelManager — LRU eviction at capacity", () => {
  it("evicts the LRU idle model when a different model is requested at capacity (default maxResident 1)", async () => {
    const scheduler = new FakeScheduler();
    const { load, dispose, loadCount, disposed } = countingLoader();
    const mgr = new ModelManager({ load, dispose, scheduler, maxResident: 1, idleTimeoutMs: 10 ** 9 });

    const a = await mgr.acquire("A");
    a.release();
    expect(mgr.residentIds()).toEqual(["A"]);

    const b = await mgr.acquire("B"); // at capacity → evict A first, then load B
    expect(disposed).toEqual(["A"]); // A's handle freed before B loaded
    expect(loadCount.get("B")).toBe(1);
    expect(mgr.residentIds()).toEqual(["B"]);
    b.release();
  });

  it("evicts the LEAST-recently-used of several idle models (maxResident 2)", async () => {
    const scheduler = new FakeScheduler();
    const { load, dispose, disposed } = countingLoader();
    const mgr = new ModelManager({ load, dispose, scheduler, maxResident: 2, idleTimeoutMs: 10 ** 9 });

    (await mgr.acquire("A")).release(); // A used first (oldest)
    (await mgr.acquire("B")).release(); // B used second
    (await mgr.acquire("A")).release(); // touch A again → B is now the LRU
    expect(new Set(mgr.residentIds())).toEqual(new Set(["A", "B"]));

    const c = await mgr.acquire("C"); // at capacity 2 → evict the LRU (B), keep A
    expect(disposed).toEqual(["B"]);
    expect(new Set(mgr.residentIds())).toEqual(new Set(["A", "C"]));
    c.release();
  });
});

describe("ModelManager — concurrency safety", () => {
  it("never double-loads under concurrent acquires of the SAME model", async () => {
    const scheduler = new FakeScheduler();
    let openGate!: () => void;
    const gate = new Promise<void>((r) => (openGate = r));
    const { load, dispose, loadCount } = countingLoader({ gate });
    const mgr = new ModelManager({ load, dispose, scheduler });

    // Fire two acquires that overlap during the (gated) load.
    const p1 = mgr.acquire("A");
    const p2 = mgr.acquire("A");
    await flush(); // both have entered acquire; the load is in flight, gated
    expect(loadCount.get("A")).toBe(1); // load invoked exactly once already

    openGate(); // let the single load resolve
    const [l1, l2] = await Promise.all([p1, p2]);
    expect(loadCount.get("A")).toBe(1); // still one — no double-load
    expect(l1.handle).toBe(l2.handle); // both leases share the one handle
    l1.release();
    l2.release();
  });

  it("applies back-pressure at capacity when every resident model is in use, then proceeds on release", async () => {
    const scheduler = new FakeScheduler();
    const { load, dispose, loadCount, disposed } = countingLoader();
    const mgr = new ModelManager({ load, dispose, scheduler, maxResident: 1, idleTimeoutMs: 10 ** 9 });

    const a = await mgr.acquire("A"); // held — refCount 1, NOT evictable

    let bResolved = false;
    const pB = mgr.acquire("B").then((lease) => {
      bResolved = true;
      return lease;
    });
    await flush();
    expect(bResolved).toBe(false); // B waits — A is in use, no slot
    expect(loadCount.has("B")).toBe(false); // B not loaded while waiting

    a.release(); // frees the slot → A becomes evictable
    const b = await pB; // B proceeds: evict A, load B
    expect(disposed).toEqual(["A"]);
    expect(loadCount.get("B")).toBe(1);
    expect(mgr.residentIds()).toEqual(["B"]);
    b.release();
  });
});

describe("ModelManager — load failure + shutdown", () => {
  it("removes a failed entry and surfaces the error; a later request retries", async () => {
    const scheduler = new FakeScheduler();
    let calls = 0;
    const disposed: string[] = [];
    const load = async (): Promise<unknown> => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return { id: "A" };
    };
    const dispose = async (h: unknown): Promise<void> => {
      disposed.push((h as { id: string }).id);
    };
    const mgr = new ModelManager({ load, dispose, scheduler });

    await expect(mgr.acquire("A")).rejects.toThrow("boom");
    expect(mgr.residentIds()).toEqual([]); // failed entry removed
    const lease = await mgr.acquire("A"); // retry succeeds
    expect(calls).toBe(2);
    lease.release();
  });

  it("disposes every resident handle on shutdown", async () => {
    const scheduler = new FakeScheduler();
    const { load, dispose, disposed } = countingLoader();
    const mgr = new ModelManager({ load, dispose, scheduler, maxResident: 3, idleTimeoutMs: 10 ** 9 });
    (await mgr.acquire("A")).release();
    (await mgr.acquire("B")).release();
    await mgr.dispose();
    expect(new Set(disposed)).toEqual(new Set(["A", "B"]));
    expect(mgr.residentIds()).toEqual([]);
  });
});
