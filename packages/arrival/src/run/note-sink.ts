/**
 * note-sink — the per-run side channels for what the MODEL must be told but did not
 * ask for. Two leaf sinks (zero imports), both riding `RunContext` (`notes`/`display`),
 * scoped to ONE run so nothing leaks across concurrent sessions the way a module-level
 * list would; both drain once, at end of call.
 *
 * LAW — the return channel must never lie. The kwargs tolerance drops a far-unknown
 * argument key and lets the call proceed (dropping `:limit 10` against a tool with no
 * `:limit` beats crashing over an argument that changes nothing). A silent drop is a lie
 * of omission — the model still believes `:limit` was honored — so the dropped key is
 * surfaced as a note. The note belongs to the RUN, not to any value inside it: a WeakMap
 * keyed on the decoded argument object is undrainable, because the renderer never sees
 * that object.
 *
 * NoteSink carries SESSION BOOKKEEPING — facts ABOUT the call, not results OF it —
 * rendered into a `#| ── environment notes ── |#` reader-comment footer that parses to
 * zero forms, so the model tells bookkeeping from answer at a glance. NOT for
 * per-statement teaching (a door explaining a mistake belongs on that statement's own
 * error) or anything that is part of the answer.
 *
 * DisplaySink backs `(display …)`, which arrival itself does NOT and will not provide:
 * ports and IO are omitted by design (a pure inference plane; an ambient write has no
 * value-construction site for provenance). A model reaches for `(display x)` as the
 * natural "show me this" idiom, so the MCP runner binds it as a host affordance —
 * identity plus a side effect into this sink, the value flowing on untouched so
 * composition is unaffected. Intent honored without the language acquiring an IO surface.
 */

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
      // Dedup: one tolerance can fire on several calls to the same tool in one program;
      // the model needs the fact once.
      if (!lines.includes(line)) lines.push(line);
    },
    drain(): readonly string[] {
      const out = lines.slice();
      lines.length = 0;
      return out;
    },
  };
}

/** One `(display …)` occurrence: the ORIGINAL source of the call, and the value it saw. */
export interface DisplayRecord {
  readonly src: string;
  readonly value: unknown;
}

export interface DisplaySink {
  push(record: DisplayRecord): void;
  drain(): readonly DisplayRecord[];
}

export function createDisplaySink(): DisplaySink {
  const records: DisplayRecord[] = [];
  return {
    push(record: DisplayRecord): void {
      records.push(record);
    },
    drain(): readonly DisplayRecord[] {
      const out = records.slice();
      records.length = 0;
      return out;
    },
  };
}
