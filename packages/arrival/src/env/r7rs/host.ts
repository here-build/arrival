// @here.build/arrival/r7rs/host — the host-interface OMISSIONS (§6.13, §6.14).
//
// Lineage: R7RS-small (Shinn, Cowan & Gleckler, eds., 2013) — §6.13 Input and
// output (ports, read/write/display, EOF objects) and §6.14 System interface
// (clock, environment variables, command line, exit).
//
// A DOORS-ONLY capability. arrival is a PURE INFERENCE PLANE: it ships NO IO surface
// and NO ambient system interface, because both are EFFECTS with no value-
// construction site for provenance to root at (IO is ambient; the clock / env /
// exit are non-deterministic). They are omitted BY DESIGN; each door (errors-as-
// doors) teaches the why and routes the caller back to pure dataflow.
//
// ─── HOME DECISION (flagged for review) ──────────────────────────────────────────
// §6.13 and §6.14 are WHOLE-section omissions — arrival ships no ports or system
// subsystem, so no existing pack "owns" them. They share one rationale (host effects
// have no construction-site), so they get ONE dedicated host pack here rather than
// being scattered, or left "aside" in a manifest. This completes the dissolution of
// the central `_unimplemented.ts` manifest into live, teaching capabilities. If
// review prefers, this pack is the most trimmable part of the change — it adds only
// teaching doors, none of them test-load-bearing.
//
// SINGLE SOURCE: `r7rs/index.ts` adds this to `allR7rs`, so `base-packs.ts`
// assembles it into the base env.

import { EnvCapability } from "../../common/capability.js";
import { symbol } from "../../common/symbol.js";

// §6.13 — no IO surface in the inference plane (an ambient effect, no construction-site).
const IO_REASON =
  "ports & IO are omitted from arrival by design — it is a pure inference plane with no IO surface; an ambient read/write has no value-construction site for provenance. Return the value from your dataflow instead of streaming it out";

// §6.14 — ambient / non-deterministic, no place in a provenance-grounded plane.
const SYSTEM_REASON =
  "the system interface is omitted from arrival by design — clock, environment, command line and exit are ambient and non-deterministic, with no construction-site to root a value's lineage at; pass any context you need in explicitly";

export default new EnvCapability("scheme/r7rs/host", {
  symbols: {
    "current-output-port": symbol.notImplemented`current-output-port: ${IO_REASON}`,
    "current-input-port": symbol.notImplemented`current-input-port: ${IO_REASON}`,
    "current-error-port": symbol.notImplemented`current-error-port: ${IO_REASON}`,
    "open-input-string": symbol.notImplemented`open-input-string: ${IO_REASON}`,
    "open-output-string": symbol.notImplemented`open-output-string: ${IO_REASON}`,
    read: symbol.notImplemented`read: ${IO_REASON}`,
    "read-char": symbol.notImplemented`read-char: ${IO_REASON}`,
    "write-char": symbol.notImplemented`write-char: ${IO_REASON}`,
    "write-string": symbol.notImplemented`write-string: ${IO_REASON}`,
    write: symbol.notImplemented`write: ${IO_REASON}`,
    display: symbol.notImplemented`display: ${IO_REASON}`,
    newline: symbol.notImplemented`newline: ${IO_REASON}`,
    "eof-object": symbol.notImplemented`eof-object: ${IO_REASON}`,
    "eof-object?": symbol.notImplemented`eof-object?: ${IO_REASON}`,
    "current-second": symbol.notImplemented`current-second: ${SYSTEM_REASON}`,
    "current-jiffy": symbol.notImplemented`current-jiffy: ${SYSTEM_REASON}`,
    "jiffies-per-second": symbol.notImplemented`jiffies-per-second: ${SYSTEM_REASON}`,
    "get-environment-variable": symbol.notImplemented`get-environment-variable: ${SYSTEM_REASON}`,
    "get-environment-variables": symbol.notImplemented`get-environment-variables: ${SYSTEM_REASON}`,
    "command-line": symbol.notImplemented`command-line: ${SYSTEM_REASON}`,
    exit: symbol.notImplemented`exit: ${SYSTEM_REASON}`,
    "emergency-exit": symbol.notImplemented`emergency-exit: ${SYSTEM_REASON}`,
  },
});
