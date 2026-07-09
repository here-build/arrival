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
// §6.13 and §6.14 are WHOLE-section omissions — arrival ships no ports or system
// subsystem, so no existing pack "owns" them. They share one rationale (host effects
// have no construction-site), so they get ONE dedicated host pack here rather than
// being scattered across unrelated packs.
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

// §6.13.1 — the FILE operations (call-with-input-file … open-output-file), relocated
// here from env/srfi/srfi-stubs.ts (the registry-dissolution sweep: each stub beside
// its family — these are R7RS-small §6.13.1 verbs, so they belong with the §6.13 port
// doors below, not in the SRFI section). Same omission, one step earlier: the PORT
// these openers would produce doesn't exist. Unlike IO_REASON's "return the value"
// redirect, files have a real route — the filesystem TOOLS.
const FILE_PORT_REASON =
  'no file ports in this sandbox — files arrive through tools, not streams; call the filesystem tool bound in this environment (e.g. (filesystem/read_file :path "...")) and use the returned value directly';

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
    "call-with-input-file": symbol.notImplemented`call-with-input-file: ${FILE_PORT_REASON}`,
    "call-with-output-file": symbol.notImplemented`call-with-output-file: ${FILE_PORT_REASON}`,
    "with-input-from-file": symbol.notImplemented`with-input-from-file: ${FILE_PORT_REASON}`,
    "with-output-to-file": symbol.notImplemented`with-output-to-file: ${FILE_PORT_REASON}`,
    "open-input-file": symbol.notImplemented`open-input-file: ${FILE_PORT_REASON}`,
    "open-output-file": symbol.notImplemented`open-output-file: ${FILE_PORT_REASON}`,
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
