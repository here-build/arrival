/**
 * REJECTED crossings. A host impl that throws is a membrane crossing that RAISED: the throw is
 * information the program branched on (a `guard` clause taken because a port failed), so the
 * emission hook records it as a `raised` payload and replay re-raises it (P17).
 *
 * The rosetta call site marks the thrown object; the emission hook (which only sees the call's
 * rejection) reads the mark. A WeakSet over the error objects — residency is the error's own
 * lifetime, same idiom as the evaluator's `rawRaisedValues` — so a validation/arity/abort error
 * that never reached the host impl is never mistaken for a crossing.
 */
const crossingRaises = new WeakSet<object>();

/** Mark `err` (if it is an object) as raised BY a host crossing; returns it for `throw`. */
export function markCrossingRaise<T>(err: T): T {
  if (err !== null && typeof err === "object") crossingRaises.add(err);
  return err;
}

/** Was `err` raised by a host crossing? Walks one `cause` link (the trampoline wraps foreign throws). */
export function isCrossingRaise(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  if (crossingRaises.has(err)) return true;
  const cause = (err as { cause?: unknown }).cause;
  return cause !== null && typeof cause === "object" && crossingRaises.has(cause);
}

/** The condition message a raised payload carries. */
export function raiseMessage(err: unknown): string {
  const cause = (err as { cause?: unknown } | null)?.cause;
  const source = cause instanceof Error ? cause : err;
  return source instanceof Error ? source.message : String(source);
}
