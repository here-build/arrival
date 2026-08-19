// eos-tokens.ts — the stop-token-set logic, factored OUT of LlamaModelHandle so it carries NO value
// import of node-llama-cpp (only the `Token` TYPE, erased at compile). That keeps the round-trip guard
// unit-testable on a synthetic vocab in the default model-free __tests__ gate: `buildEosTokenSet` is pure
// in (eos, eot, tokenize, terminator), so the "did the terminator split?" branch can be exercised without
// loading a GGUF or the native llama backend.

import type { Token } from "node-llama-cpp";

/**
 * Build the decode loop's stop-token set: the model's own `eos`/`eot` PLUS the family's literal turn
 * `terminator`, resolved as a SINGLE special token via the model's `tokenize`. If the terminator does not
 * resolve to exactly one token — the model's vocab lacks it, so it splits into CONTENT tokens — it is
 * WARNED + DROPPED, never added as a spurious early-stop id (the bug this guards: hardcoding Llama-3's
 * `<|eot_id|>` for a ChatML model split it into content and injected the first id as a false terminator).
 * `terminator === null` ⇒ rely on `eos`/`eot` alone.
 */
export function buildEosTokenSet(
  eos: Token | null | undefined,
  eot: Token | null | undefined,
  tokenize: (text: string, specialTokens: boolean) => readonly Token[],
  terminator: string | null,
): Set<Token> {
  const ids = new Set<Token>([eos, eot].filter((t): t is Token => t != null));
  if (terminator !== null) {
    const toks = tokenize(terminator, true);
    if (toks.length === 1 && toks[0] != null) {
      ids.add(toks[0]);
    } else {
      console.warn(
        `[arrival-sampler] buildEosTokens: turn terminator ${JSON.stringify(terminator)} did not resolve to a ` +
          `single special token (got ${toks.length}) — this model's vocab may not define it. Dropping it from ` +
          `the stop set; relying on eos/eot. Natural turn-stop may be impaired for this family.`,
      );
    }
  }
  return ids;
}
