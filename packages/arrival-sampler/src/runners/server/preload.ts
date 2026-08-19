// preload.ts — the PURE budget + selection math for the env-gated roster preloader. Given a roster of sized
// GGUFs and the machine's total RAM, decide which models fit a memory budget and how many resident slots that
// implies. No filesystem, no GPU — model-free testable. The node/GPU side (real-decode/cli) supplies the real
// sizes (statSync) + `os.totalmem()`, then warms the chosen ids via the ModelManager.
//
// CAPACITY — FIRST ITERATION IS MAC-ONLY (Apple unified memory): we treat total system RAM as the model budget.
// TODO(generalize): detect real GPU VRAM on non-Mac platforms; today we assume Mac unified memory == budget.

/** One gibibyte in bytes. */
const GIB = 1024 ** 3;

/** The headroom we always leave free (OS + the server process itself), in bytes. */
const RESERVED_BYTES = 4 * GIB;

/** The usable model-memory budget for a machine with `totalRamBytes` of (unified) RAM: use up to 80% of RAM,
 *  but ALWAYS leave at least {@link RESERVED_BYTES} (4 GiB) free — the tighter of the two bounds wins. On a
 *  large machine the 80% cap binds; on a small machine the 4-GiB floor binds (and can drive the budget to 0,
 *  clamped so it never goes negative). */
export function preloadBudgetBytes(totalRamBytes: number): number {
  return Math.max(0, Math.min(0.8 * totalRamBytes, totalRamBytes - RESERVED_BYTES));
}

/** The result of {@link selectPreloadSet}: the model ids to warm, and the resident-slot count they need. */
export interface PreloadSelection {
  /** The ids to preload (warm into the resident cache at startup), in selection order (smallest-first). */
  readonly ids: string[];
  /** The `maxResident` the ModelManager must allow so every selected model can stay resident at once. */
  readonly maxResident: number;
}

/** Greedily select the roster models that fit the preload budget, SMALLEST-FIRST. Smallest-first maximizes how
 *  many distinct models are instantly available: a small-model-heavy roster preloads fully, while a few large
 *  ones are skipped rather than blocking the rest. `maxResident` is just the count selected — the manager must
 *  hold them all simultaneously. (Sorting is stable on size; ties keep input order.) */
export function selectPreloadSet(
  models: readonly { id: string; sizeBytes: number }[],
  totalRamBytes: number,
): PreloadSelection {
  const budget = preloadBudgetBytes(totalRamBytes);
  const ordered = [...models].sort((a, b) => a.sizeBytes - b.sizeBytes);
  const ids: string[] = [];
  let used = 0;
  for (const m of ordered) {
    if (used + m.sizeBytes > budget) break; // ascending order ⇒ nothing later fits either
    used += m.sizeBytes;
    ids.push(m.id);
  }
  return { ids, maxResident: ids.length };
}
