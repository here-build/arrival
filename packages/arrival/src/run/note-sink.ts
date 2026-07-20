/**
 * note-sink — the two per-run model-facing side channels (`notes`/`display` on `RunContext`),
 * leaf sinks (zero imports) scoped to ONE run so nothing leaks across concurrent sessions, both
 * drained once at end of call. The model — the return-channel-never-lies law, what each channel
 * carries, and why arrival binds no `(display …)` verb of its own — is docs/RUN-MODEL.md §SINKS.
 *
 * FOOTER FORMAT (this file's mechanism): `NoteSink` lines render into a
 * `#| ── environment notes ── |#` reader-comment footer that parses to zero forms, so the model
 * tells bookkeeping from answer at a glance. NOT for per-statement teaching (a door explaining a
 * mistake belongs on that statement's own error) or anything that is part of the answer.
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
