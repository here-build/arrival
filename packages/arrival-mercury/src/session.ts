/**
 * The mercury session — the `(runCtx, scope, capabilities, config)` tuple
 * `execState` itself mints and reuses, plus a bound `dispose()`.
 *
 * Mercury does not own a product plane. The host passes the vocabulary
 * (`capabilities`, highest-first) that this compiler instance lowers against.
 * The first `execState("(begin)")` runs the prelude + capability lowering
 * ONCE; the returned tuple threads every later call. Dispose via `dispose()`
 * (or `await using`) when the session ends.
 *
 * No `loader` — mercury's programs are self-contained snippets, so
 * `(require …)` stays unbound by capability withholding unless a host capability
 * binds it.
 */
import { disposeRunContext, execState, LexicalScope, type EnvCapability, type RunContext, type SessionScope } from "@inhuman.tools/arrival";

export interface MercurySession {
  /** Per-run hermetic handle (identity / heap meter / strict / cache). Stable for
   *  the session's whole life — thread it on every later `execState` call. */
  readonly runCtx: RunContext;
  /** The session's define-accumulation frame — `SessionScope`, so `scope.env`
   *  carries the structural `SchemeEnv` write contract. */
  readonly scope: SessionScope;
  readonly capabilities: readonly EnvCapability[];
  /** THE SHARED CONFIG BAG — same object reference on every later `execState`
   *  call (the vocabulary memo and the runCtx tuple check are identity-keyed
   *  on it). */
  readonly config: object;
  dispose(): Promise<void>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

export async function openSession(opts: {
  name: string;
  /** Host vocabulary, highest-first. Empty ⇒ BASE_ROSTER only. */
  capabilities: readonly EnvCapability[];
  /** Per-run values for `(define/overridable …)` forms; `{}` ⇒ in-form defaults fire. */
  params?: Record<string, unknown>;
}): Promise<MercurySession> {
  const { capabilities } = opts;
  const config: Record<string, unknown> = { params: opts.params ?? {} };
  const scope = LexicalScope.fresh(opts.name);
  const first = await execState("(begin)", { capabilities, config, scope });
  const dispose = (): Promise<void> => disposeRunContext(first.runCtx);
  return { runCtx: first.runCtx, scope, capabilities, config, dispose, [Symbol.asyncDispose]: dispose };
}
