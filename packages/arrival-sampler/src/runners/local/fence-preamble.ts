// fence-preamble.ts — optional steer for models that open with a markdown code fence.
//
// Accepts the fence as preamble so the oracle sees valid Scheme tokens, then the caller can strip it
// from the final output. 
//
// WHY THIS EXISTS (the evidence, see the BFCL sweep's per-token oracle log). On the constrained NON-FC path
// some models open their answer with a markdown fence: at the FIRST content token the argmax is the fence
// opener ` ``` ` at p=0.87–0.99 — the model WANTS to write ` ```python\n<call>\n``` `. The oracle masks
// ` ``` ` (not valid Scheme) and force-feeds a rank-1 token. On easy entries the model snaps back to `(`;
// on HARD entries it has already committed to a PROSE plan, and the oracle then force-feeds Scheme tokens
// at rank 39, then off the distribution — producing garbage (`(a  ][:  ][: …`). Masking the fence suppresses
// the SYMPTOM, not the model's PLAN. So we ACCEPT the fence and STEER it: force the canonical
// ` ```scheme\n ` opener (normalising whatever language the model wanted to `scheme`), then run the existing
// Scheme-constrained decode INSIDE the fence. The emitted fence is unwrapped downstream (the scheme program
// is the first balanced `(...)` — `extractSchemeForm` already skips the ` ```scheme\n ` prefix).
//
// THE SEAM (the whole point — zero entanglement with the Scheme prefix). The fence tokens are committed to
// the BACKEND (the model sees them, so its post-fence distribution is conditioned on the fence), but they
// are NOT part of the Scheme oracle's prefix: the caller leaves `ctx.prefix` at the Scheme start (`""` or
// `(`). The descent reads `backend.stepDistribution()` (now the post-fence distribution) and grows
// `ctx.prefix` from the Scheme start, so the scanner only ever sees Scheme — the fence lives only in the KV.
//
// This is a PURE addition: it fires ONLY when the model's first token opens a fence (a leading backtick). A
// non-fence-opening model takes the early-return below and decodes BYTE-IDENTICALLY to today. It is gated by
// the caller to the NON-FC constrained path (never FC, never the unconstrained control).
//
// Node-only decode runtime (drives the node-llama-cpp backend through the abstract `DecodeBackend`), so it
// lives in `src/decode/` and is excluded from the published browser `.` entry.

import type { Token } from "node-llama-cpp";

import type { DecodeBackend } from "./backends/common/types.js";

/** The canonical fence opener we steer the model into. Whatever language the model wanted (` ```python `,
 *  ` ```js `, …) is normalised to `scheme` — the slot the Scheme oracle constrains. The trailing newline puts
 *  the cursor on a fresh line where the program begins, mirroring a real ` ```scheme\n<code> ` block. */
export const FENCE_OPENER = "```scheme\n";

/** The markdown fence sentinel — a single backtick. The model's first-token argmax opens a fence iff its
 *  detokenization STARTS WITH this (the binding may merge the run into one token ` ``` ` or ` ```python `,
 *  or surface a lone ` ` ` — all start with a backtick). */
const BACKTICK = "`";

/** What the preamble did: whether a fence was opened (and if so, the exact bytes committed to the backend).
 *  `fenceUsed:false` ⇒ the model did not open a fence and nothing was committed (the byte-identical path). */
export interface FencePreambleResult {
  /** True iff the model's first token opened a fence and the canonical opener was force-emitted. */
  readonly fenceUsed: boolean;
  /** The fence bytes committed to the backend (`""` when `fenceUsed` is false). Informational — the fence is
   *  in the KV only, never in the Scheme oracle prefix. */
  readonly committed: string;
}

const NO_FENCE: FencePreambleResult = { fenceUsed: false, committed: "" };

/**
 * Peek the model's FIRST generated token on a backend already PREFILLED with the prompt; if it opens a
 * markdown fence (its detokenization starts with a backtick), FORCE-emit the canonical {@link FENCE_OPENER}
 * (` ```scheme\n `) into the backend and return `{ fenceUsed: true, … }`. Otherwise commit NOTHING and return
 * {@link NO_FENCE} — the decode proceeds byte-identically to a no-preamble run.
 *
 * The force-emit uses the SAME round-trip-guarded pattern as the FC envelope ({@link generateFcEnvelope}):
 * tokenize the opener WITHOUT special tokens, verify `detokenize(ids) === FENCE_OPENER` (a node-llama-cpp
 * leading-space / merge artifact would desync the steer — decline rather than corrupt), then
 * `backend.commit(ids)`. On a round-trip miss we DO NOT commit the fence (the steer is best-effort; a clean
 * fall-through to the Scheme decode is always safe because `ctx.prefix` is untouched either way).
 *
 * IMPORTANT: this does NOT touch the caller's Scheme prefix. The fence is committed to the backend so the
 * model's post-fence distribution is conditioned on it; the caller keeps `ctx.prefix` at the Scheme start, so
 * the descent's scanner never sees the fence.
 */
export async function maybeOpenFence<Id extends number = Token>(
  backend: DecodeBackend<Id>,
  opts?: { readonly maxLeadingWhitespace?: number },
): Promise<FencePreambleResult> {
  // A model may emit LEADING WHITESPACE before the fence: rnj-1's argmax is `\n\n` at step 0 and the
  // ` ``` ` opener only at step 1. So consume up to `maxLeadingWhitespace` whitespace-ONLY tokens while
  // scanning for the fence. The consumed whitespace is harmless if no fence follows — the Scheme decode
  // handles leading whitespace identically whether it sits in the preamble or the descent (same token
  // stream, same extracted program); only the bookkeeping shifts. A first CONTENT token that is neither a
  // fence nor whitespace ⇒ the byte-identical fall-through (nothing committed).
  const maxWs = opts?.maxLeadingWhitespace ?? 4;
  let committed = "";

  for (let i = 0; ; i++) {
    const dist = backend.stepDistribution();
    if (dist === undefined) return { fenceUsed: false, committed }; // no successor distribution — stop.
    const top1 = dist.keys().next().value as Id | undefined;
    if (top1 === undefined) return { fenceUsed: false, committed };
    const str = backend.detokenize(top1);

    // FENCE opener: the argmax detokenizes to a leading backtick (the binding may merge the whole
    // ` ```python ` run into one token, so a prefix check — not equality — is right). FORCE-EMIT the canonical
    // opener (the FC-envelope force-emit pattern). Round-trip guard: a leading-space / merge artifact would
    // desync the steer, so decline (fall through to the Scheme decode) rather than corrupt.
    if (str.startsWith(BACKTICK)) {
      const ids = backend.model.tokenize(FENCE_OPENER, false);
      if (ids.length === 0 || backend.model.detokenize(ids) !== FENCE_OPENER) return { fenceUsed: false, committed };
      await backend.commit(ids);
      return { fenceUsed: true, committed: committed + FENCE_OPENER };
    }

    // LEADING WHITESPACE before a possible fence — consume it (committed to the KV) and keep scanning, up to
    // the budget. `/^\s+$/` is whitespace-ONLY (a `\n(` or ` foo` token is content, not skippable).
    if (i < maxWs && str.length > 0 && /^\s+$/.test(str)) {
      await backend.commit([top1]);
      committed += str;
      continue;
    }

    return { fenceUsed: false, committed }; // content (or whitespace budget exhausted) — no fence.
  }
}

/** Strip a ` ```scheme `-style markdown fence wrapper from `text`, returning the bare inner program. A
 *  defensive unwrap for any downstream consumer that receives the fence-wrapped text directly (the primary
 *  decode path never wraps — the fence lives only in the backend KV, not in the returned program — but a
 *  raw-text consumer scoring `rawDecode` benefits from a tolerant strip). Removes a leading
 *  ` ```<lang>\n ` opener and a trailing ` \n``` ` / ` ``` ` close; leaves non-fenced text unchanged. */
export function stripFence(text: string): string {
  let out = text;
  // Leading fence opener: ``` optionally followed by a language tag, up to and including the first newline.
  const open = /^\s*```[^\n]*\n/.exec(out);
  if (open) out = out.slice(open[0].length);
  // Trailing fence close: an optional newline then ``` (and any trailing whitespace).
  const close = /\n?```\s*$/.exec(out);
  if (close) out = out.slice(0, close.index);
  return out;
}
