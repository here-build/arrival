/**
 * The declared-role vocabulary `buildPlan` / `attachDataflow` read (`runCtx.vocabulary`: values
 * carry `.provenanceRole` / `.callbackRoles`). A `LexicalScope` does not see it, so it is taken
 * from a throwaway run context built over the same capabilities the program will run with.
 */
import { disposeRunContext, type EnvCapability, execState, LexicalScope } from "@here.build/arrival";

import type { Vocabulary } from "./plan.js";

/** A snapshot of the vocabulary arrival builds for `capabilities` (builtins only without). */
export async function loadVocabulary(capabilities?: readonly EnvCapability[]): Promise<Vocabulary> {
  const state = await execState("(begin)", {
    ...(capabilities ? { capabilities } : {}),
    config: {},
    scope: LexicalScope.fresh("vocabulary"),
  });
  try {
    return new Map(state.runCtx.vocabulary);
  } finally {
    await disposeRunContext(state.runCtx);
  }
}
