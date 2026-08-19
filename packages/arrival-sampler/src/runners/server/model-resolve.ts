// model-resolve.ts — resolve a request `model` field → an on-disk GGUF path, the way the intent-eval roster
// does, but WITHOUT a cross-package dependency on the example. The roster GGUFs live under the sampler's own
// `models/roster/` (the roster.ts `rosterGguf()` resolves there); the binaries are not checked in, so the
// source of truth is the FILESYSTEM at run time. Resolution order:
//
//   1. The `model` field is itself a path to an existing `.gguf`        → use it verbatim.
//   2. The `model` field denotes a logical model with on-disk variants  → pick a variant by the QUANT LADDER.
//   3. (folded into 2) a known roster id / a present basename           → still resolve, ladder-disambiguated.
//
// QUANT AWARENESS: one logical model (e.g. "Arch-Agent-1.5B") may have several GGUFs on disk that differ only
// by quantization (`…-q4_k_m.gguf`, `…-q8_0.gguf`, `…-f16.gguf`). They share a logical STEM (the basename with
// the quant marker stripped), so we GROUP present files by stem and pick ONE by an env-dependent preference
// ladder: dev favours the small/fast q4 end, prod favours the precise f16 end. Both fall THROUGH to the next
// available tier. This only decides WHICH variant when a logical id has several — single-variant resolution is
// unchanged.
//
// The known-id catalog below mirrors roster.ts (the canonical sweep roster) so `/v1/models` can list the
// roster ids even before the binaries are downloaded, and so a friendly id ("Qwen2.5-1.5B") resolves to the
// right filename. It is a CONVENIENCE map, not the source of truth — the filesystem decides what actually loads.
//
// SOURCES: the single roster directory generalizes to an ordered SOURCE LIST. Besides the sampler's own roster
// dir, the server can discover GGUFs already on disk from LM Studio (`~/.lmstudio/models`) and Ollama
// (`~/.ollama/models`), plus arbitrary gguf trees (`--models-dir`). Each source reuses the SAME quant ladder.
// Resolution tries sources in PRECEDENCE order `roster > models-dir > lmstudio > ollama`; ids that collide
// across sources are namespaced (`lmstudio:<id>` / `ollama:<id>`), the bare id surviving when it's unique.

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The sampler's roster directory (absolute, stable regardless of cwd) — mirrors roster.ts `rosterGguf()`. */
export const ROSTER_DIR = fileURLToPath(new URL("../../../models/roster/", import.meta.url));

/** A roster id → its GGUF filename, mirroring intent-eval's roster.ts. Convenience for friendly-id resolution
 *  and `/v1/models` listing; the filesystem is authoritative for what actually loads. */
export const KNOWN_ROSTER: Readonly<Record<string, string>> = {
  "Qwen2.5-0.5B": "qwen2.5-0.5b-instruct-q4_k_m.gguf",
  "Qwen2.5-1.5B": "qwen2.5-1.5b-instruct-q4_k_m.gguf",
  "Qwen2.5-3B": "qwen2.5-3b-instruct-q4_k_m.gguf",
  "Qwen2.5-7B": "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
  "xLAM-2-1b": "xLAM-2-1B-fc-r-Q4_K_M.gguf",
  "xLAM-2-3b": "xLAM-2-3B-fc-r-Q4_K_M.gguf",
  "Arch-Agent-1.5B": "Arch-Agent-1.5B.Q4_K_M.gguf",
  "Arch-Agent-3B": "Arch-Agent-3B.Q4_K_M.gguf",
  "SmolLM2-1.7B": "SmolLM2-1.7B-Instruct-Q4_K_M.gguf",
  "Qwen3-0.6B": "Qwen_Qwen3-0.6B-Q4_K_M.gguf",
  "Rnj-1": "Rnj-1-Instruct-8B-Q4_K_M.gguf",
  "Falcon3-1B": "Falcon3-1B-Instruct-q4_k_m.gguf",
  "Command-R7B": "c4ai-command-r7b-12-2024-Q4_K_M.gguf",
};

/** The `.gguf` files actually present in the roster directory (basenames). Empty when the binaries aren't
 *  downloaded yet (the common dev case — the sampler ships no GGUFs). */
export function presentGgufs(rosterDir = ROSTER_DIR): string[] {
  if (!existsSync(rosterDir)) return [];
  return readdirSync(rosterDir).filter((f) => f.toLowerCase().endsWith(".gguf"));
}

// ── quant awareness ───────────────────────────────────────────────────────────────────────────────────────

/** A GGUF quantization tier, coarsened to the bands the resolution ladder ranks over. The exact GGML quant
 *  (q4_k_m vs q4_0, q5_k_s vs q6_k) is collapsed — the ladder only cares about the speed/precision band.
 *  `f16` is the full-precision band: f16/bf16/f32, AND a bare `<name>.gguf` with no quant marker (an
 *  unquantized export). `other` catches q2/q3/q5/q6/iq* — ranked last in both envs. */
export type QuantTier = "q4" | "q8" | "f16" | "other";

/** A quant marker following a `-`/`.`/`_` separator and running to the next separator or end of the (lower-
 *  cased, .gguf-stripped) basename: `q4_k_m`, `Q4_K_M`, `q8_0`, `q5_k_s`, `q6_k`, `iq4_xs`, `f16`, `bf16`,
 *  `f32`. Non-global, so `.match`/`.replace` carry no `lastIndex` state across the call sites that share it. */
const QUANT_MARKER_RE = /[._-](i?q[0-9]+(?:_[0-9a-z]+)*|bf16|f16|f32)(?=[._-]|$)/;

/** Classify a gguf filename into a {@link QuantTier}. No marker ⇒ full precision (the `f16` band). */
export function quantTierOf(filename: string): QuantTier {
  const marker = filename.toLowerCase().replace(/\.gguf$/, "").match(QUANT_MARKER_RE)?.[1];
  if (marker === undefined) return "f16"; // no marker ⇒ unquantized full-precision export
  if (/^i?q4/.test(marker)) return "q4";
  if (/^i?q8/.test(marker)) return "q8";
  if (marker === "f16" || marker === "bf16" || marker === "f32") return "f16";
  return "other"; // q2/q3/q5/q6/iq2/iq3/…
}

/** The logical stem of a gguf filename: the lower-cased basename with the `.gguf` suffix AND the quant marker
 *  (with its leading separator) stripped, so every quant variant of one model shares a stem. A bare name with
 *  no marker is its own stem. Used to GROUP present files into one logical model. */
function logicalStem(filename: string): string {
  return filename.toLowerCase().replace(/\.gguf$/, "").replace(QUANT_MARKER_RE, "");
}

/** The resolution environment that selects the quant preference ladder. `prod` iff `NODE_ENV==='production'`. */
export type ResolveEnv = "dev" | "prod";

/** Detect the resolution env from `NODE_ENV` (prod iff exactly `'production'`, else dev). */
export function resolveEnv(): ResolveEnv {
  return process.env.NODE_ENV === "production" ? "prod" : "dev";
}

/** The quant preference ladder per env. Dev favours the small/fast q4 end (quick iteration); prod favours the
 *  precise f16 end (output quality). Both list ALL tiers, so resolution falls THROUGH to the next available
 *  one when the preferred tier is absent. `other` (q5/q6/…) is ranked last in both. */
const LADDER: Readonly<Record<ResolveEnv, readonly QuantTier[]>> = {
  dev: ["q4", "q8", "f16", "other"],
  prod: ["f16", "q8", "q4", "other"],
};

/** Pick one variant from a non-empty set by the env's quant ladder. Within a tier (e.g. two q4 builds) the
 *  filename sort is the deterministic tiebreak. */
function pickByLadder(variants: readonly string[], env: ResolveEnv): string {
  const sorted = [...variants].sort();
  for (const tier of LADDER[env]) {
    const match = sorted.find((f) => quantTierOf(f) === tier);
    if (match !== undefined) return match;
  }
  // Unreachable for a non-empty set: quantTierOf is total and the ladder lists all four tiers, so some tier
  // always matches. A throw (not a cast) keeps the type honest if that invariant is ever broken.
  throw new Error(`model-resolve: no quant tier matched ${JSON.stringify(sorted)}`);
}

/** The present GGUFs that are variants of the logical model `model` denotes: a known roster id resolves to the
 *  stem of its mapped filename (so "Qwen3-0.6B" groups with "Qwen_Qwen3-0.6B-*"); any other id is its own
 *  quant-stripped stem. The legacy exact-basename matches are unioned in so single-file resolution is
 *  preserved verbatim. */
function variantsFor(model: string, rosterDir: string): string[] {
  const present = presentGgufs(rosterDir);
  const knownFile = KNOWN_ROSTER[model];
  const stem = knownFile
    ? logicalStem(knownFile)
    : logicalStem(model.toLowerCase().endsWith(".gguf") ? model : `${model}.gguf`);
  return present.filter(
    (f) =>
      logicalStem(f) === stem || // quant-variant grouping
      f === model ||
      f === `${model}.gguf` ||
      path.basename(f, ".gguf") === model, // legacy exact-basename
  );
}

// ── source discovery ──────────────────────────────────────────────────────────────────────────────────────

/** The kind of a model source, in PRECEDENCE order (the order resolution prefers): the sampler's own roster,
 *  arbitrary `--models-dir` trees, an LM Studio store, an Ollama store. */
export type ModelSource = "roster" | "models-dir" | "lmstudio" | "ollama";

/** One model source: a kind + the absolute directory to walk. The kind decides the on-disk LAYOUT (a flat
 *  roster dir, a `publisher/repo` LM Studio tree, an Ollama content-addressed store, …). */
export interface Source {
  readonly kind: ModelSource;
  readonly dir: string;
}

/** One model discovered on disk: the id we advertise (collision-namespaced), the chosen gguf path, its byte
 *  size, and which source produced it. The id is what `/v1/models` shows and what a request `model` resolves. */
export interface DiscoveredModel {
  readonly id: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly source: ModelSource;
}

/** The default LM Studio / Ollama store locations on macOS (overridable via env / CLI). */
export const DEFAULT_LMSTUDIO_DIR = path.join(os.homedir(), ".lmstudio", "models");
export const DEFAULT_OLLAMA_DIR = path.join(os.homedir(), ".ollama", "models");

/** The auto-detecting default source list: the roster, plus an LM Studio / Ollama store IFF its directory
 *  exists (so a machine without either store simply gets the roster). Env overrides the store paths
 *  (`LMSTUDIO_MODELS_DIR`, `OLLAMA_MODELS`). The CLI builds a richer list from its flags; this is the fallback
 *  for direct callers. NOTE: the library functions below default to roster-ONLY (back-compat) — discovery is
 *  opted into by passing a source list (the CLI does) or calling this explicitly. */
export function defaultSources(): Source[] {
  const lmDir = process.env.LMSTUDIO_MODELS_DIR?.trim() || DEFAULT_LMSTUDIO_DIR;
  const olDir = process.env.OLLAMA_MODELS?.trim() || DEFAULT_OLLAMA_DIR;
  const sources: Source[] = [{ kind: "roster", dir: ROSTER_DIR }];
  if (existsSync(lmDir)) sources.push({ kind: "lmstudio", dir: lmDir });
  if (existsSync(olDir)) sources.push({ kind: "ollama", dir: olDir });
  return sources;
}

/** Normalize the `sources` argument shared by the public resolvers: `undefined` ⇒ roster-only (the legacy
 *  default), a bare string ⇒ a single roster source at that dir (the legacy positional `rosterDir`), an
 *  explicit list ⇒ used as-is. The string form keeps every legacy `(model, rosterDir, env)` call working. */
function normSources(sources: string | readonly Source[] | undefined): readonly Source[] {
  if (sources === undefined) return [{ kind: "roster", dir: ROSTER_DIR }];
  if (typeof sources === "string") return [{ kind: "roster", dir: sources }];
  return sources;
}

/** Precedence rank per source kind (lower = preferred). Drives resolution order AND collision namespacing:
 *  the highest-precedence source keeps the bare id, lower ones yield by self-namespacing. */
const SOURCE_PRECEDENCE: Readonly<Record<ModelSource, number>> = {
  roster: 0,
  "models-dir": 1,
  lmstudio: 2,
  ollama: 3,
};

/** Recursively collect every `.gguf` FILE under `root` (absolute paths). Directories named `<x>.gguf` (LM
 *  Studio "imported" models) are walked into, not treated as files, so the real `.gguf` inside is found; a
 *  `.part` in-progress download is skipped (wrong suffix). Unreadable dirs are skipped, not fatal. */
function walkGgufFiles(root: string, maxDepth = 8): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission / transient error — skip this subtree
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) visit(full, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".gguf")) out.push(full);
    }
  };
  visit(root, 0);
  return out;
}

/** A shard suffix `-NNNNN-of-MMMMM` (llama.cpp split-gguf): its 1-based index, or null if not a shard. */
function shardIndex(basename: string): number | null {
  const m = basename.match(/-(\d+)-of-(\d+)\.gguf$/i);
  return m ? Number(m[1]) : null;
}

/** Is this gguf basename a STANDALONE loadable model? False for a `mmproj-*` CLIP/vision projector (not an
 *  LLM) and for a non-first shard (llama.cpp auto-loads siblings from the first `-00001-of-…` — listing the
 *  rest duplicates the model). A non-sharded, non-mmproj file is loadable. */
function isLoadableGguf(basename: string): boolean {
  if (/^mmproj-/i.test(basename)) return false;
  const idx = shardIndex(basename);
  return idx === null || idx === 1;
}

/** Strip the `.gguf` ext, a shard suffix, and the quant marker from a basename → a clean model name, case
 *  preserved (e.g. `Hammer2.1-3b.Q4_K_S.gguf` → `Hammer2.1-3b`). Quant variants of one model collapse to it. */
function cleanModelName(basename: string): string {
  return basename
    .replace(/\.gguf$/i, "")
    .replace(/-\d+-of-\d+$/i, "")
    .replace(/[._-](i?q[0-9]+(?:_[0-9a-z]+)*|bf16|f16|f32)(?=[._-]|$)/i, "");
}

/** Strip a trailing `.gguf` (imported-dir / bare-file repo) and a trailing `-GGUF` (HF repo convention) from
 *  an LM Studio `publisher/repo` key → the advertised id (e.g. `mradermacher/Hammer2.1-3b-GGUF` →
 *  `mradermacher/Hammer2.1-3b`; `katanemo/Arch-Agent-1.5B.gguf` → `katanemo/Arch-Agent-1.5B`). */
function cleanRepoName(key: string): string {
  return key.replace(/\.gguf$/i, "").replace(/-GGUF$/i, "");
}

/** A model discovered within ONE source, before cross-source collision namespacing. `primaryId` is the source-
 *  local id (bare); {@link discoverModels} may namespace it on collision. */
interface RawModel {
  readonly primaryId: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly source: ModelSource;
}

/** Choose one path from a group of quant variants by the ladder (keyed on each file's basename). */
function pickPathByLadder(paths: readonly string[], env: ResolveEnv): string {
  const chosen = pickByLadder(
    paths.map((p) => path.basename(p)),
    env,
  );
  // A group is built from distinct files; the first path whose basename is the ladder pick is that file.
  return paths.find((p) => path.basename(p) === chosen) ?? paths[0]!;
}

/** The roster-source advertise ids: the KNOWN roster ids (downloadable even before the binary lands) UNION
 *  every present basename. The roster's contribution to {@link listModelIds}; also drives {@link discoverRoster}. */
function rosterAdvertiseIds(dir: string): string[] {
  const ids = new Set<string>(Object.keys(KNOWN_ROSTER));
  for (const f of presentGgufs(dir)) ids.add(path.basename(f, ".gguf"));
  return [...ids].sort();
}

/** Discover the roster source: every advertised id that RESOLVES to a file, deduped by resolved path (so quant
 *  variants of one model collapse), the lexicographically-first id winning. The flat-dir + KNOWN_ROSTER twin of
 *  the store walkers below. */
function discoverRoster(dir: string, env: ResolveEnv): RawModel[] {
  const byPath = new Map<string, RawModel>();
  for (const id of rosterAdvertiseIds(dir)) {
    const variants = variantsFor(id, dir);
    if (variants.length === 0) continue;
    const p = path.join(dir, pickByLadder(variants, env));
    if (byPath.has(p)) continue; // a variant of this model already mapped to this file
    byPath.set(p, { primaryId: id, path: p, sizeBytes: statSync(p).size, source: "roster" });
  }
  return [...byPath.values()];
}

/** Discover an LM Studio store (`~/.lmstudio/models/<publisher>/<repo>/…`). Walks for loadable ggufs, groups by
 *  the first two path segments (`publisher/repo`, or `publisher/<file>` for a bare/imported model), collapses
 *  the group's quant variants via the ladder, and advertises `cleanRepoName(publisher/repo)`. */
function discoverLmStudio(root: string, env: ResolveEnv): RawModel[] {
  const files = walkGgufFiles(root).filter((f) => isLoadableGguf(path.basename(f)));
  const groups = new Map<string, string[]>(); // publisher/repo key → member file paths
  for (const f of files) {
    const segs = path.relative(root, f).split(path.sep);
    const key = segs.length >= 2 ? `${segs[0]}/${segs[1]}` : segs[0]!;
    const bucket = groups.get(key);
    if (bucket) bucket.push(f);
    else groups.set(key, [f]);
  }
  const out: RawModel[] = [];
  for (const [key, paths] of groups) {
    const chosen = pickPathByLadder(paths, env);
    out.push({ primaryId: cleanRepoName(key), path: chosen, sizeBytes: statSync(chosen).size, source: "lmstudio" });
  }
  return out;
}

/** Discover an arbitrary gguf tree (`--models-dir`). Walks for loadable ggufs and collapses same-directory quant
 *  variants (grouped by directory + logical stem) via the ladder; the id is the clean (quant-stripped) basename. */
function discoverModelsDir(root: string, env: ResolveEnv): RawModel[] {
  const files = walkGgufFiles(root).filter((f) => isLoadableGguf(path.basename(f)));
  const groups = new Map<string, string[]>(); // dir + logical stem → member file paths
  for (const f of files) {
    const key = `${path.dirname(f)} ${logicalStem(path.basename(f))}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(f);
    else groups.set(key, [f]);
  }
  const out: RawModel[] = [];
  for (const paths of groups.values()) {
    const chosen = pickPathByLadder(paths, env);
    out.push({
      primaryId: cleanModelName(path.basename(chosen)),
      path: chosen,
      sizeBytes: statSync(chosen).size,
      source: "models-dir",
    });
  }
  return out;
}

/** The single model layer of an Ollama image manifest (the gguf blob), narrowed from parsed JSON. */
function ollamaModelLayer(manifest: unknown): { digest: string; size: number | undefined } | null {
  if (typeof manifest !== "object" || manifest === null || !("layers" in manifest)) return null;
  const layers = manifest.layers;
  if (!Array.isArray(layers)) return null;
  const arr: readonly unknown[] = layers; // Array.isArray widens to any[]; re-narrow each element honestly
  for (const layer of arr) {
    if (typeof layer !== "object" || layer === null) continue;
    if (!("mediaType" in layer) || layer.mediaType !== "application/vnd.ollama.image.model") continue;
    if (!("digest" in layer) || typeof layer.digest !== "string") continue;
    const size = "size" in layer && typeof layer.size === "number" ? layer.size : undefined;
    return { digest: layer.digest, size };
  }
  return null;
}

/** Discover an Ollama store (`~/.ollama/models`, a content-addressed OCI store). Walks every image manifest
 *  under `manifests/.../<ns>/<model>/<tag>`, reads its model-layer `digest`, and resolves the gguf blob at
 *  `blobs/sha256-<hex>` (the manifest's `sha256:<hex>` → `-` on disk). id = `model:tag` (or `ns/model:tag` for
 *  a non-`library` namespace). A manifest whose blob is missing is skipped; a missing store yields nothing. */
function discoverOllama(root: string): RawModel[] {
  const manifestsRoot = path.join(root, "manifests");
  if (!existsSync(manifestsRoot)) return [];
  const out: RawModel[] = [];
  for (const mf of walkFiles(manifestsRoot)) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(mf, "utf8"));
    } catch {
      continue; // not a JSON manifest — skip
    }
    const layer = ollamaModelLayer(manifest);
    if (layer === null) continue;
    const blob = path.join(root, "blobs", layer.digest.replace(":", "-"));
    if (!existsSync(blob)) continue; // blob not pulled / partial — skip
    const segs = path.relative(manifestsRoot, mf).split(path.sep);
    if (segs.length < 3) continue; // not a `<ns>/<model>/<tag>` leaf
    const [ns, model, tag] = segs.slice(-3);
    const id = ns === "library" ? `${model}:${tag}` : `${ns}/${model}:${tag}`;
    out.push({ primaryId: id, path: blob, sizeBytes: layer.size ?? statSync(blob).size, source: "ollama" });
  }
  return out;
}

/** Recursively collect every FILE under `root` (Ollama manifests are extension-less JSON leaves). */
function walkFiles(root: string, maxDepth = 8): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) visit(full, depth + 1);
      else if (e.isFile()) out.push(full);
    }
  };
  visit(root, 0);
  return out;
}

/** Discover one source's models (pre-namespacing), dispatching on its kind. */
function discoverSource(src: Source, env: ResolveEnv): RawModel[] {
  switch (src.kind) {
    case "roster":
      return discoverRoster(src.dir, env);
    case "models-dir":
      return discoverModelsDir(src.dir, env);
    case "lmstudio":
      return discoverLmStudio(src.dir, env);
    case "ollama":
      return discoverOllama(src.dir);
  }
}

/** Discover every model on disk across `sources`, with cross-source collision namespacing applied. A bare id
 *  survives when a single source produces it; when ≥2 sources produce the same id, the roster keeps the bare id
 *  (it is canonical / highest-precedence) and every other source self-namespaces (`lmstudio:<id>`,
 *  `ollama:<id>`, `models-dir:<id>`). Used by `/v1/models` advertising and the preloader's warm set. */
export function discoverModels(sources: readonly Source[], env: ResolveEnv = resolveEnv()): DiscoveredModel[] {
  const raw: RawModel[] = [];
  for (const src of sources) raw.push(...discoverSource(src, env));
  const byId = new Map<string, RawModel[]>();
  for (const m of raw) {
    const bucket = byId.get(m.primaryId);
    if (bucket) bucket.push(m);
    else byId.set(m.primaryId, [m]);
  }
  const out: DiscoveredModel[] = [];
  for (const [primaryId, group] of byId) {
    const collides = new Set(group.map((g) => g.source)).size > 1;
    for (const m of group) {
      const id = collides && m.source !== "roster" ? `${m.source}:${primaryId}` : primaryId;
      out.push({ id, path: m.path, sizeBytes: m.sizeBytes, source: m.source });
    }
  }
  return out;
}

/** Parse a source-namespaced id `kind:bareid` (e.g. `lmstudio:katanemo/Arch-Agent-1.5B`) into its parts, or
 *  null when the leading token isn't a source kind (so a bare `qwen3:latest` Ollama id stays bare — its `qwen3`
 *  is not a kind). The `kind:` prefix routes resolution to exactly that source. */
function parseNamespacedId(model: string): { kind: ModelSource; bareId: string } | null {
  const idx = model.indexOf(":");
  if (idx <= 0) return null;
  const prefix = model.slice(0, idx);
  if (isModelSource(prefix)) return { kind: prefix, bareId: model.slice(idx + 1) };
  return null;
}

/** A type guard: is this string one of the four source kinds? */
function isModelSource(s: string): s is ModelSource {
  return s === "roster" || s === "models-dir" || s === "lmstudio" || s === "ollama";
}

/** Resolve a request `model` field → an absolute GGUF path, or null if it can't be resolved to an existing
 *  file. Order: an explicit existing `.gguf` path short-circuits FIRST; then each SOURCE is tried in precedence
 *  order — for the roster, logical-model variants picked by the quant ladder (covering both a known-roster id
 *  and a present basename); for a store, the discovered id (bare, or its `kind:<id>` namespaced form). A bare
 *  id resolves to the highest-precedence source that has it; a `kind:<id>` form routes to exactly that source.
 *  Returns null (not throw) so the handler can surface a 404-style OpenAI error with the available ids.
 *  `sources` (default roster-only; a bare string is the legacy positional `rosterDir`) and `env` (default
 *  {@link resolveEnv}) parameterize the search. */
export function resolveModelPath(
  model: string,
  sources?: string | readonly Source[],
  env: ResolveEnv = resolveEnv(),
): string | null {
  // 1. An explicit path to an existing .gguf — verbatim, no ladder (the caller named an exact file).
  if (model.toLowerCase().endsWith(".gguf") && existsSync(model)) return path.resolve(model);
  const srcs = normSources(sources);
  const ns = parseNamespacedId(model); // a `kind:<id>` request routes to that source kind only
  for (const src of srcs) {
    if (ns !== null && ns.kind !== src.kind) continue;
    const query = ns !== null ? ns.bareId : model;
    if (src.kind === "roster") {
      // 2a. Roster: the on-disk quant variants of the logical model this id denotes; the ladder picks one.
      const variants = variantsFor(query, src.dir);
      if (variants.length > 0) return path.join(src.dir, pickByLadder(variants, env));
    } else {
      // 2b. Store: match the discovered id (or the raw chosen-file basename, a convenience for store models).
      const hit = discoverSource(src, env).find(
        (m) => m.primaryId === query || path.basename(m.path, ".gguf") === query,
      );
      if (hit !== undefined) return hit.path;
    }
  }
  return null;
}

/** The list of model ids to advertise in `GET /v1/models`, unioned across sources: for each roster source,
 *  every PRESENT gguf (by basename) UNION the known roster ids (so a client can discover the roster even before
 *  the binaries land); for every store source, the discovered (collision-namespaced) ids. Deduped, sorted.
 *  `sources` defaults to roster-only (a bare string is the legacy positional `rosterDir`). */
export function listModelIds(sources?: string | readonly Source[], env: ResolveEnv = resolveEnv()): string[] {
  const srcs = normSources(sources);
  const ids = new Set<string>();
  for (const src of srcs) {
    if (src.kind === "roster") for (const id of rosterAdvertiseIds(src.dir)) ids.add(id);
  }
  // Store ids come (collision-namespaced) from discovery; the roster's own discovered ids are already covered
  // by `rosterAdvertiseIds` above (which also lists not-yet-downloaded KNOWN ids), so skip them here.
  for (const m of discoverModels(srcs, env)) if (m.source !== "roster") ids.add(m.id);
  return [...ids].sort();
}

/** Every logical model that currently RESOLVES to a file on disk across `sources` (the "warm-able" set). For
 *  the roster this walks the advertised ids and dedupes by resolved path so quant variants collapse; for a
 *  store it walks the store's layout. Cross-source id collisions are namespaced. Used by the startup preloader
 *  to size the budget (the budget's smallest-first / 80%-of-RAM cap guards against a huge on-disk store). The
 *  name is kept for back-compat; the result now spans every source, not just the roster. */
export function resolvableRosterModels(sources?: string | readonly Source[], env?: ResolveEnv): DiscoveredModel[] {
  return discoverModels(normSources(sources), env ?? resolveEnv());
}
