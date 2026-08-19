// lmstudio.ts — the SHARED LM Studio model resolver (node-only). ONE source, imported by every consumer:
// arrival-sampler's own eval harness (materialize / benchmarks / misprediction) AND any sibling package (the
// BFCL bench) via the `./lmstudio` subpath export — so there is NO second copy to drift. It used to live in
// the uncompiled `__harness__/gguf-models.ts`; because that was unexported, the BFCL bench had to COPY it
// (the duplication that read as a divergence). Lifting it to an exported module removes the forcing function.
//
// V's model source of truth is LM STUDIO (V downloads/tracks/experiments there), NOT an in-repo models/ dir.
// `resolveGguf` maps a roster owner/repo KEY to a local `.gguf` path by a NORMALIZED repo-name match across
// every publisher (LM Studio's on-disk publisher often differs from the roster's org — `zai-org/glm-4.7-flash`
// is stored under `lmstudio-community/GLM-4.7-Flash-GGUF`). Where the fuzzy match is ambiguous (a model under
// several publishers at different quants, or its q4 and f16 split across publishers) the explicit
// `roster-resolution.json` map pins the exact repo(s). Not downloaded yet ⇒ null (the caller decides: a CLI
// errors, the eval loud-skips). Quant target: q4 (the WORKHORSE, default) / fp16 (best-effort REFERENCE) —
// Q8 is DROPPED (f16→q8 ~3-5pp but ~2× size, a bad compromise); see {@link Quant}.

import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const LMSTUDIO_MODELS = path.join(process.env.LMSTUDIO_HOME ?? path.join(homedir(), ".lmstudio"), "models");

/** The quant target for a resolve. `q4` = the WORKHORSE (V's default — what the fast roster + the server run);
 *  `fp16` = the best-effort REFERENCE (the full roster), laddering down when no f16 is downloaded locally.
 *  (Q8 was the previous "all-Q8" compromise — dropped, since f16→q8 is only ~3-5pp but q8 ~doubles the size.) */
export type Quant = "q4" | "fp16";

/** EXPLICIT canonical-key → on-disk repo(s) map (roster-resolution.json at the package root). Overrides the
 *  fuzzy normalized-name match for rostered models whose LM Studio publisher/quant is ambiguous, or whose q4
 *  and f16 live under DIFFERENT publishers (so a key can list >1 repo). The `_comment` key is dropped; an
 *  unmapped key falls back to the fuzzy match. */
const RESOLUTION_MAP: Readonly<Record<string, readonly string[]>> = (() => {
  const raw = JSON.parse(
    // Three ups = the package root from BOTH homes of this module (src/runners/gguf/ and the built
    // dist-server/runners/gguf/ — same nesting depth, so one relative path serves both).
    readFileSync(
      process.env.ROSTER_RESOLUTION_PATH ?? new URL("../../../roster-resolution.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const out: Record<string, readonly string[]> = {};
  for (const [k, v] of Object.entries(raw)) if (k !== "_comment" && Array.isArray(v)) out[k] = v as string[];
  return out;
})();

const safeReaddir = (dir: string): Dirent[] => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // unreadable / missing dir — treat as empty
  }
};

/** Tolerant key: lowercase, drop a trailing "gguf", collapse a version dot-zero (`4.0` ≡ `4`), strip
 *  non-alphanumerics. So `glm-4.7-flash` and on-disk `GLM-4.7-Flash-GGUF` both collapse to `glm47flash`, AND
 *  `granite-4.0-h-tiny` (the on-disk dir + roster key) matches LM Studio's served id `granite-4-h-tiny` (the
 *  API drops the `.0`) — without the collapse `granite40htiny` ≠ `granite4htiny`. Only dot-zero collapses;
 *  `4.6`/`4.7` are untouched. */
function norm(name: string): string {
  return name
    .toLowerCase()
    .replace(/gguf$/, "")
    .replace(/\.0(?=\D|$)/g, "") // version dot-zero: 4.0 ≡ 4 (LM Studio's served id drops it)
    .replaceAll(/[^a-z0-9]/g, "");
}

/** A later shard of a split GGUF (`…-00002-of-00003.gguf`) — skipped so only the FIRST shard is loaded. */
const isLaterShard = (p: string): boolean => /-\d{5}-of-\d{5}\.gguf$/i.test(p) && !/-0*1-of-\d{5}\.gguf$/i.test(p);

/** Quant LADDER for a `target`. The roster runs **q4 for fast (the workhorse), fp16 for full (reference)**;
 *  Q8 is no longer the goal (f16→q8 is only ~3-5pp but q8 ~doubles the size — a bad compromise).
 *    • `q4`  : q4 first, then ascend fidelity (q5, q6, f16) as fallback, **q8 LAST** (never wanted).
 *    • `fp16`: f16 first, then **q8** as the highest-fidelity fallback (the reference comparison, where no f16
 *      is downloaded — e.g. granite), then down to q4 (e.g. qwen3-8b, which has no f16 locally).
 *  Tie-broken by smallest file at the call site. */
function quantRank(p: string, target: Quant): number {
  const n = p.toLowerCase();
  const q4 = /q4/.test(n);
  const f16 = /fp?16|bf16|f32/.test(n);
  const q8 = /q8/.test(n);
  const q6 = /q6/.test(n);
  const q5 = /q5/.test(n);
  if (target === "q4") return q4 ? 0 : q5 ? 1 : q6 ? 2 : f16 ? 3 : q8 ? 9 : 4;
  return f16 ? 0 : q8 ? 1 : q6 ? 2 : q5 ? 3 : q4 ? 4 : 5;
}

function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Every `.gguf` under `dir` (LM Studio sometimes nests a quant subdir under the repo). */
function ggufsUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of safeReaddir(d)) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".gguf")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** From a set of `.gguf` files, pick the one to load at `target` quant (first shard, smallest tie-break).
 *  Excludes later split-shards (load the first) and `mmproj-*` files (a VLM's vision projector — never the
 *  model weights, so loading one as the LM would fail). */
function pickGguf(paths: readonly string[], target: Quant): string | undefined {
  const pool = paths.filter((p) => !isLaterShard(p) && !path.basename(p).toLowerCase().startsWith("mmproj"));
  return pool.toSorted((a, b) => quantRank(a, target) - quantRank(b, target) || fileSize(a) - fileSize(b)).at(0);
}

/**
 * Resolve a roster `key` (LM Studio owner/repo) to a local GGUF file path at the `quant` target (default
 * `q4`, the workhorse), or null if it isn't downloaded in LM Studio yet.
 *
 * RESOLUTION_MAP first: a mapped key resolves to EXACTLY its listed repo(s) (gathering ggufs across all of
 * them — q4 and f16 may live under different publishers) — killing the publisher-blind mis-resolve.
 *
 * Otherwise FUZZY: match by NORMALIZED repo name across all publishers — exact first, then the shortest repo
 * whose normalized name STARTS WITH `want` (catches `rnj-1` → `rnj-1-instruct`, without grabbing `qwen3-80b`),
 * then a CONTAINS fallback — so the roster's org need not equal LM Studio's on-disk publisher.
 */
export function resolveGguf(key: string, quant: Quant = "q4"): string | null {
  if (!existsSync(LMSTUDIO_MODELS)) return null;
  // EXPLICIT map: gather ggufs from every listed repo, pick the target quant across all of them.
  const mapped = RESOLUTION_MAP[key];
  if (mapped) {
    const paths = mapped.flatMap((r) => ggufsUnder(path.join(LMSTUDIO_MODELS, r)));
    return pickGguf(paths, quant) ?? null;
  }
  // FUZZY fallback (unmapped keys — ad-hoc test keys, future models not yet pinned in the map).
  const want = norm(key.split("/").pop() ?? key);
  const repos: { dir: string; n: string }[] = [];
  for (const pub of safeReaddir(LMSTUDIO_MODELS)) {
    if (!pub.isDirectory()) continue;
    const pubDir = path.join(LMSTUDIO_MODELS, pub.name);
    for (const r of safeReaddir(pubDir)) {
      if (r.isDirectory()) repos.push({ dir: path.join(pubDir, r.name), n: norm(r.name) });
    }
  }
  const exact = repos.find((r) => r.n === want);
  const startsWith = repos
    .filter((r) => r.n.startsWith(want))
    .toSorted((a, b) => a.n.length - b.n.length)
    .at(0);
  const contains = repos
    .filter((r) => r.n.includes(want))
    .toSorted((a, b) => a.n.length - b.n.length)
    .at(0);
  const match = exact ?? startsWith ?? contains;
  if (match === undefined) return null;
  return pickGguf(ggufsUnder(match.dir), quant) ?? null;
}

/** The quant tag from a GGUF filename (`Q8_0`, `Q4_K_M`, `IQ4_NL`, `fp16`, …), or "unknown" — the LAST
 *  quant-like token in the basename (the quant sits near the end, after the model name). Recorded into the
 *  eval's per-model report so V can verify the all-Q8 invariant + spot any confounding fallback. */
export function quantOf(ggufPath: string): string {
  const tags = path.basename(ggufPath).match(/IQ\d\w*|Q\d(?:_\w+)?|fp?16|bf16|f32/gi);
  return tags?.at(-1) ?? "unknown";
}

/** True iff a quant TAG (from {@link quantOf}) belongs to the requested {@link Quant} family — `q4` covers any
 *  q4 build, `fp16` covers f16/bf16/f32. Lets a call site flag a FALLBACK: the requested quant wasn't
 *  downloaded for this model, so {@link resolveGguf} laddered down to a different one. */
export function matchesQuant(quantTag: string, target: Quant): boolean {
  return target === "q4" ? /q4/i.test(quantTag) : /fp?16|bf16|f32/i.test(quantTag);
}
