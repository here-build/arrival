// @here.build/arrival/srfi/srfi-stubs — the TEACHING-STUB pack.
//
// A DOORS-ONLY capability, sibling in spirit to `r7rs/host.ts`. These are the
// symbols an LLM agent PREDICTABLY reaches for (having seen the string / list /
// dict surface) that arrival deliberately does NOT implement. A bare "Unbound
// variable" is a dead-end wall; each door here (errors-as-doors) NAMES the fact,
// the REASON, and the EXACT alternative bound in this environment — turning the
// wall into a route back to the real dataflow.
//
// Eight families, grouped internally:
//   1. SRFI-69/125 hash tables → dicts are native & immutable ({…} / (dict …)).
//   2. file ports (+ the CL-ism with-open-file) → files arrive through TOOLS.
//   3. SRFI-27 random → ambient non-determinism has no place in a pure sandbox.
//   4. SRFI-14 char-sets → the string library takes a char or one-arg predicate.
//   5. SRFI-19 time/date → the clock is ambient; timestamps arrive in tool results.
//   6. SRFI-13 string-filter → not shipped; build it from filter + string<->list.
//   7. SRFI-113 sets (list->set, set-contains?) → no set type exists to redirect to.
//   8. string ports (call-with-input-string) → also omitted, same as host.ts's ports.
//
// SCOPE / COMPROMISES (honest deltas):
//   • Registered — this pack IS assembled by default: `srfi/index.ts` folds it into
//     `allSrfi`, which `base-packs.ts` assembles into `BASE_PACKS`. Every env that
//     inherits `sandboxedEnv` doors these symbols; there is no pack-less production
//     configuration left to pin as a counter-case (see `srfi-stubs.test.ts`).
//   • `char-set:whitespace` / `:alphabetic` / `:numeric` are SRFI VARIABLES, not
//     procedures. `symbol.notImplemented` only bakes a callable door, so they are
//     bound as throwing procedures: a model that CALLS one gets the teaching door;
//     a bare reference resolves to the throwing closure without firing. Acceptable
//     — the reach we care about is the call site. (Sub-note: `parseNameDoc` splits
//     on the first COLON-SPACE (": "), not the first colon — fixed in the law-grid
//     bug batch precisely because these colon-named doors were truncating to
//     `char-set`; `def.name` now reports the full `char-set:whitespace`.)
//
// No file-port symbol here is stubbed by `r7rs/host.ts`: host.ts doors the port
// PRIMITIVES (current-*-port, read/write/display, open-*-string, eof-object) and
// the §6.14 system verbs, but never the FILE openers below — so this pack adds,
// never double-binds.

import { EnvCapability } from "../../common/capability.js";
import { symbol } from "../../common/symbol.js";

// ── 1. SRFI-69 / SRFI-125 hash tables ────────────────────────────────────────
// The true alternative is the native `dict`: an immutable open-key map. Build with
// the `{:key value …}` literal or `(dict :key value …)`; read with `(:key d)` or
// `(@ d :key)`; enumerate keys with `(@keys d)`. There is no mutation — model any
// accumulation as a FRESH dict rebuilt from tool results.
const HASH_TABLE_REASON =
  "hash tables are not implemented — dicts are native and immutable here: build with {:key value ...} or (dict :key value ...), read with (:key d) or (@ d :key), enumerate keys with (@keys d); for iteration fold over (@keys d), and rebuild a fresh dict instead of mutating one in place";

// ── 2. File ports (+ the Common-Lisp `with-open-file`) ────────────────────────
const FILE_PORT_REASON =
  "no file ports in this sandbox — files arrive through tools, not streams; call the filesystem tool bound in this environment (e.g. (filesystem/read_file :path \"...\")) and use the returned value directly";

// ── 3. SRFI-27 random ─────────────────────────────────────────────────────────
// Mirrors host.ts's SYSTEM_REASON tone: ambient non-determinism has no lineage root.
const RANDOM_REASON =
  "randomness is omitted from arrival by design — non-deterministic ambient state has no construction-site to root a value's lineage at, and a pure sandbox stays reproducible; pass any needed choice or seed in explicitly, or draw it from a tool result";

// ── 4. SRFI-14 char-sets ──────────────────────────────────────────────────────
const CHAR_SET_REASON =
  "char-sets are not implemented — the string library here takes a char or a one-arg predicate instead, e.g. (string-index s char-numeric?) or (string-trim s #\\space)";

// ── 5. SRFI-19 time / date ────────────────────────────────────────────────────
// Ambient-clock door (host.ts tone) + the format/parse redirect for the pure verbs.
const TIME_DATE_REASON =
  "the date/time library is omitted from arrival by design — the clock is ambient and non-deterministic, with no construction-site to root a value's lineage at; timestamps arrive in tool results, so compare and format them as plain strings or numbers";

// ── 6. SRFI-13 string-filter ─────────────────────────────────────────────────
// Unlike families 1-5 (design omissions), this is a genuine gap in the bound SRFI-13
// subset (string-index/string-count/string-trim stop at "a char or one-arg predicate,
// no char-sets" — see CHAR_SET_REASON) — but it has an honest compositional redirect
// using symbols verified bound elsewhere: `filter` (SRFI-1, srfi-1.ts) and
// `string->list` / `list->string` (R7RS, r7rs/strings.ts).
const STRING_FILTER_REASON =
  "string-filter is not implemented (SRFI-13) — build the same result compositionally from what IS bound: (list->string (filter pred (string->list s))), using filter (SRFI-1), string->list and list->string (R7RS)";

// ── 7. SRFI-113 sets ──────────────────────────────────────────────────────────
// Verified: no set type is bound anywhere in this env (grepped values/ + env/{srfi,r7rs,
// core}) — dicts and lists are the only collection types. There is genuinely no set
// equivalent to redirect to, so — unlike family 6 — this door does NOT claim one.
const SET_REASON =
  "sets are not implemented (SRFI-113) — this sandbox has no set type, only lists and dicts, so there is no direct equivalent to redirect to; if de-duplication or membership alone covers what you needed a set for, (delete-duplicates xs) and (member x xs) are bound (SRFI-1 / R7RS), but they operate on lists, not sets";

// ── 8. String ports (call-with-input-string) ─────────────────────────────────
// Not a design-omission family of its own — it's the same §6.13 port omission
// r7rs/host.ts already doors (open-input-string / open-output-string throw IO_REASON
// there); call-with-input-string would just wrap a port constructor that doesn't
// exist, so it gets the identical redirect: operate on the string directly.
const STRING_PORT_REASON =
  "call-with-input-string is not implemented — string ports are omitted from arrival by design (R7RS §6.13.2 / SRFI-6), the same omission r7rs/host.ts's open-input-string door names; the string you would read through the port IS the value you already have, so operate on it directly with string-ref / string->list / string-split / string-index instead of reading it back through a port";

export default new EnvCapability("scheme/srfi-stubs", {
  symbols: {
    // 1. SRFI-69 / SRFI-125 hash tables
    "make-hash-table": symbol.notImplemented`make-hash-table: ${HASH_TABLE_REASON}`,
    "hash-table?": symbol.notImplemented`hash-table?: ${HASH_TABLE_REASON}`,
    "hash-table-ref": symbol.notImplemented`hash-table-ref: ${HASH_TABLE_REASON}`,
    "hash-table-ref/default": symbol.notImplemented`hash-table-ref/default: ${HASH_TABLE_REASON}`,
    "hash-table-set!": symbol.notImplemented`hash-table-set!: ${HASH_TABLE_REASON}`,
    "hash-table-delete!": symbol.notImplemented`hash-table-delete!: ${HASH_TABLE_REASON}`,
    "hash-table-update!": symbol.notImplemented`hash-table-update!: ${HASH_TABLE_REASON}`,
    "hash-table->alist": symbol.notImplemented`hash-table->alist: ${HASH_TABLE_REASON}`,
    "alist->hash-table": symbol.notImplemented`alist->hash-table: ${HASH_TABLE_REASON}`,
    "hash-table-keys": symbol.notImplemented`hash-table-keys: ${HASH_TABLE_REASON}`,
    "hash-table-values": symbol.notImplemented`hash-table-values: ${HASH_TABLE_REASON}`,
    "hash-table-walk": symbol.notImplemented`hash-table-walk: ${HASH_TABLE_REASON}`,
    "hash-table-fold": symbol.notImplemented`hash-table-fold: ${HASH_TABLE_REASON}`,
    "hash-table-count": symbol.notImplemented`hash-table-count: ${HASH_TABLE_REASON}`,
    "hash-table-exists?": symbol.notImplemented`hash-table-exists?: ${HASH_TABLE_REASON}`,
    "hash-table-contains?": symbol.notImplemented`hash-table-contains?: ${HASH_TABLE_REASON}`,

    // 2. File ports (host.ts stubs the port primitives; these file openers are new)
    "call-with-input-file": symbol.notImplemented`call-with-input-file: ${FILE_PORT_REASON}`,
    "call-with-output-file": symbol.notImplemented`call-with-output-file: ${FILE_PORT_REASON}`,
    "with-input-from-file": symbol.notImplemented`with-input-from-file: ${FILE_PORT_REASON}`,
    "with-output-to-file": symbol.notImplemented`with-output-to-file: ${FILE_PORT_REASON}`,
    "open-input-file": symbol.notImplemented`open-input-file: ${FILE_PORT_REASON}`,
    "open-output-file": symbol.notImplemented`open-output-file: ${FILE_PORT_REASON}`,
    "with-open-file": symbol.notImplemented`with-open-file: ${FILE_PORT_REASON}`,

    // 3. SRFI-27 random
    "random-integer": symbol.notImplemented`random-integer: ${RANDOM_REASON}`,
    "random-real": symbol.notImplemented`random-real: ${RANDOM_REASON}`,
    "random-source-make-integers": symbol.notImplemented`random-source-make-integers: ${RANDOM_REASON}`,

    // 4. SRFI-14 char-sets (the `char-set:*` entries are VARIABLES — see COMPROMISES)
    "char-set": symbol.notImplemented`char-set: ${CHAR_SET_REASON}`,
    "char-set?": symbol.notImplemented`char-set?: ${CHAR_SET_REASON}`,
    "char-set-contains?": symbol.notImplemented`char-set-contains?: ${CHAR_SET_REASON}`,
    "string->char-set": symbol.notImplemented`string->char-set: ${CHAR_SET_REASON}`,
    "char-set:whitespace": symbol.notImplemented`char-set:whitespace: ${CHAR_SET_REASON}`,
    "char-set:alphabetic": symbol.notImplemented`char-set:alphabetic: ${CHAR_SET_REASON}`,
    "char-set:numeric": symbol.notImplemented`char-set:numeric: ${CHAR_SET_REASON}`,

    // 5. SRFI-19 time / date
    "current-date": symbol.notImplemented`current-date: ${TIME_DATE_REASON}`,
    "current-time": symbol.notImplemented`current-time: ${TIME_DATE_REASON}`,
    "date->string": symbol.notImplemented`date->string: ${TIME_DATE_REASON}`,
    "string->date": symbol.notImplemented`string->date: ${TIME_DATE_REASON}`,
    "time-utc->date": symbol.notImplemented`time-utc->date: ${TIME_DATE_REASON}`,
    "current-julian-day": symbol.notImplemented`current-julian-day: ${TIME_DATE_REASON}`,

    // 6. SRFI-13 string-filter (compositional gap, not a design omission)
    "string-filter": symbol.notImplemented`string-filter: ${STRING_FILTER_REASON}`,

    // 7. SRFI-113 sets (no set type — no redirect claimed)
    "list->set": symbol.notImplemented`list->set: ${SET_REASON}`,
    "set-contains?": symbol.notImplemented`set-contains?: ${SET_REASON}`,

    // 8. String ports (mirrors host.ts's port omission)
    "call-with-input-string": symbol.notImplemented`call-with-input-string: ${STRING_PORT_REASON}`,
  },
});
