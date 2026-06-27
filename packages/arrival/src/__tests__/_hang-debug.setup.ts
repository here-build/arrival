/**
 * TEMPORARY exit-hang diagnostic. Env-guarded (`HANG_DEBUG=1`) so it is a no-op on
 * normal/CI runs — registering nothing unless the flag is set.
 *
 * Why it exists: `pnpm exec vitest run --no-file-parallelism` (one shared realm,
 * 98 files sequential) intermittently HANGS on exit after all 1554 tests pass — the
 * worker won't terminate. Parallel mode (separate realms) exits clean. So something
 * accumulated across the single realm keeps the event loop alive. This dumps the
 * active-handle census after each file; the file at which an unexpected handle type
 * first appears (and persists) is the leak site, and the last census before the hang
 * names what is blocking exit.
 *
 * Revert once the handle is identified + fixed. Session 014UnK16.
 */
import { afterAll } from "vitest";

if (process.env.HANG_DEBUG) {
  const census = (): string => {
    const handles =
      (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
    const counts = new Map<string, number>();
    for (const h of handles) {
      const name = (h as { constructor?: { name?: string } })?.constructor?.name ?? "unknown";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const handleSummary = [...counts].map(([k, v]) => `${k}×${v}`).join(", ") || "none";
    return `resources=[${process.getActiveResourcesInfo().join(",")}] handles=[${handleSummary}]`;
  };

  afterAll(() => {
    // stderr so it survives even if vitest is mid-teardown
    process.stderr.write(`[HANG_DEBUG] after-file: ${census()}\n`);
  });

  process.on("exit", (code) => {
    process.stderr.write(`[HANG_DEBUG] process exit(${code}): ${census()}\n`);
  });
}
