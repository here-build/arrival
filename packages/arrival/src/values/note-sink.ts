// note-sink.ts — the per-run channel for things the MODEL needs told, that are not the answer.
//
// A leaf (zero imports): it rides `RunContext.notes`, the same per-run hermetic seam `cache` /
// `effects` / `reads` ride, so it is scoped to ONE run and cannot leak across concurrent sessions
// the way a module-level list would.
//
// ─── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────
//
// The kwargs tolerance (kwargs-rejection.ts, B5) DROPS a far-unknown argument key and lets the call
// proceed — which is right: a model that writes `(memory/search_nodes :query "x" :limit 10)` against
// a tool with no `:limit` should not eat a hard rejection over an argument that changes nothing.
// Before the tolerance, that was a CRASH.
//
// But the fix was only half-landed. The note explaining what was ignored was produced correctly and
// then *never surfaced* — `drainDroppedKwargNotes` had zero production callers, so the notes sat in
// a WeakMap forever. The model went from an unexplained CRASH to an unexplained SILENT DROP: it
// still believed `:limit 10` had been honored, and would reasonably conclude the tool ignores limits
// or that its own result set was capped. A silent drop is a lie of omission, and this medium's
// governing diagnosis is that the return channel must never lie.
//
// The WeakMap keyed the note on the DECODED ARGUMENT OBJECT — reachable from the decode site and
// nowhere else. The renderer (mcp-substrate's runner) never sees that object, which is precisely why
// nothing could drain it. The key was wrong for the job: the note belongs to the RUN, not to a value
// inside it. Hence this sink.
//
// ─── WHAT BELONGS HERE ──────────────────────────────────────────────────────────────────────
//
// SESSION BOOKKEEPING the model must know but did not ask for — facts ABOUT the call rather than
// results OF it. They render into the consolidated `#| ── environment notes ── |#` footer, a reader
// comment that parses to zero forms, so the model can tell bookkeeping from answer at a glance.
//
// NOT for: substantive per-statement teaching (a door explaining a mistake belongs on that
// statement's own error, where the mistake is), or anything that is part of the answer.

/** A per-run collector for model-facing bookkeeping. Push at the point the fact becomes true;
 *  the renderer drains once, at the end of the call. */
export interface NoteSink {
  push(line: string): void;
  /** Take everything pushed so far, leaving the sink empty. Called once per call by the renderer. */
  drain(): readonly string[];
}

export function createNoteSink(): NoteSink {
  const lines: string[] = [];
  return {
    push(line: string): void {
      // Deduplicate: the same tolerance can fire on several calls to the same tool inside one
      // program, and the model needs the fact once, not once per call.
      if (!lines.includes(line)) lines.push(line);
    },
    drain(): readonly string[] {
      const out = lines.slice();
      lines.length = 0;
      return out;
    },
  };
}
