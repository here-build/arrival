// gguf-models.ts — the model ROSTER binding for the gguf (llama.cpp/Metal) eval. The model SET lives in
// `rosters.json` at the package root (ONE source, importable by any language — this binding, the python BFCL
// reference runner, a future sweep); this file READS + VALIDATES it and selects the active roster by env.
//
// A roster entry is an LM Studio owner/repo KEY; the SHARED resolver `resolveGguf` (in `../../src/../../src/src/runners/gguf/lmstudio.ts`, the
// `./lmstudio` export) finds its local `.gguf`. A model not downloaded yet resolves to null ⇒ the eval
// LOUD-SKIPS it. The resolver used to live HERE, but this file is in uncompiled `__harness__/` — so it could
// not be imported by sibling packages and got copied; lifting it to `lmstudio.ts` removed that duplication.

import { readFileSync } from "node:fs";

import invariant from "tiny-invariant";

import type { Quant } from "../../src/runners/gguf/lmstudio.js";

/** One roster model: its LM Studio owner/repo key + a short display label for the `describe.each` block. */
export interface GgufModel {
  readonly key: string;
  readonly label: string;
}

// ── roster DATA (ejected to rosters.json — ONE source of truth) ─────────────────────────────────────
// The model SET lives in `rosters.json` at the package root, NOT here, so it is importable by ANY language:
// this TS harness (below), the python BFCL reference runner (scripts/), a future sweep. This file is the
// TYPED BINDING — it reads + VALIDATES the JSON on load (an honest TypeError on malformed data, since the
// file is hand-editable). Edit the model set in rosters.json, never here.

interface RostersJson {
  readonly fast: readonly GgufModel[];
  readonly full: readonly GgufModel[];
  readonly extended: readonly GgufModel[];
}

/** A roster entry is well-formed iff it carries a string `key` (owner/repo) and `label`. */
function isGgufModel(m: unknown): m is GgufModel {
  return (
    typeof m === "object" &&
    m !== null &&
    "key" in m &&
    typeof m.key === "string" &&
    "label" in m &&
    typeof m.label === "string"
  );
}

/** Validate one roster array from the parsed JSON — an honest TypeError on a malformed entry (bad hand-edits
 *  must fail loud at load, not silently mis-resolve later). The `_comment` key on the root is ignored. */
function parseRoster(value: unknown, name: string): readonly GgufModel[] {
  invariant(Array.isArray(value), `rosters.json: "${name}" must be a model array`);
  return value.map((m): GgufModel => {
    invariant(isGgufModel(m), `rosters.json: malformed "${name}" entry (need { key, label }): ${JSON.stringify(m)}`);
    return m;
  });
}

function parseRosters(raw: unknown): RostersJson {
  invariant(typeof raw === "object" && raw !== null, "rosters.json: root must be an object with fast/full/extended");
  invariant("fast" in raw && "full" in raw && "extended" in raw, "rosters.json: missing a roster (fast/full/extended)");
  return {
    fast: parseRoster(raw.fast, "fast"),
    full: parseRoster(raw.full, "full"),
    extended: parseRoster(raw.extended, "extended"),
  };
}

const ROSTERS: RostersJson = parseRosters(
  JSON.parse(readFileSync(new URL("../../rosters.json", import.meta.url), "utf8")),
);

/** The FULL roster — the RESEARCH-WORTHY models (good or bad, TBD until the sweep runs), every one runnable
 *  at Q8. BFCL-inspired: varied lineages + sibling sizes. Source: rosters.json `full`. */
export const GGUF_MODELS_FULL: readonly GgufModel[] = ROSTERS.full;

/** The FAST roster — a small subset of FULL for in-motion dynamics (<10 min/model). Source: rosters.json `fast`. */
export const GGUF_MODELS_FAST: readonly GgufModel[] = ROSTERS.fast;

/** The EXTENDED roster — WILDCARDS (a can't-Q8 behemoth; families we're still forming an opinion on), kept
 *  OUT of FULL so the research comparison stays clean. Source: rosters.json `extended`. */
export const GGUF_MODELS_EXTENDED: readonly GgufModel[] = ROSTERS.extended;

/** The roster active for THIS run, selected by env `LLM_ROSTER`. Default = EMPTY ⇒ `describe.each([])`
 *  yields zero model cases, so the default `test` (and a bare `custdev`) loads no model and is instant. */
export function activeRoster(): readonly GgufModel[] {
  switch (process.env.LLM_ROSTER) {
    case "full":
      return GGUF_MODELS_FULL;
    case "fast":
      return GGUF_MODELS_FAST;
    case "extended":
      return GGUF_MODELS_EXTENDED;
    case "all":
      return [...GGUF_MODELS_FULL, ...GGUF_MODELS_EXTENDED];
    default:
      return [];
  }
}

/** The quant the active roster runs at, mirroring {@link activeRoster}'s `LLM_ROSTER` selection:
 *   • `fast` (and the default) ⇒ **q4** — the DAILY-PROGRESS workhorse.
 *   • `full` / `extended` / `all` ⇒ **fp16** — the CONTROL comparison vs official benchmarks (full fidelity).
 *  Passed to {@link resolveGguf}, which ladders down when that quant isn't downloaded for a given model. */
export function activeQuant(): Quant {
  const r = process.env.LLM_ROSTER;
  return r === "full" || r === "extended" || r === "all" ? "fp16" : "q4";
}
