// SRFI-28 — basic format strings (the string-destination subset). Scheme-bootstrap capability.
//
// SINGLE SOURCE: this module is the sole definition site. It is NOT registered in
// `srfi/index.ts` / `base-packs.ts` — an orchestrator wires it in later; a consumer
// assembles it onto an env explicitly (see the test).
//
// WHY: LLM agents in our sandboxed tool-calling REPL reach for `(format ...)` from
// training data (Common-Lisp / SRFI-28 idioms). Left unbound, a model that wants to
// build a message string crashes on `Unbound variable 'format'`. We complete the
// platform's grain by binding the PURE, string-returning subset honestly.
//
// SCOPE NARROWING (honest deltas from SRFI-28 / SRFI-48):
//   • SRFI-28 proper is `(format fmt-string arg ...)` → string. We bind exactly that.
//   • SRFI-48/CL put a DESTINATION first: `(format dest fmt-string arg ...)`. We admit
//     the `#f` destination ONLY — `(format #f "..." ...)` returns the same string. Any
//     OTHER destination (`#t` = current-output-port, or a port) is an IO effect, and
//     arrival ships no IO surface (see r7rs/host.ts) — it is a teaching door, not a
//     silent no-op.
//   • Directives: `~a` (display), `~s` (write), `~d` (decimal number), `~%` (newline),
//     `~~` (literal tilde), plus one bounded SRFI-48 subset — `~F` / `~w,dF` fixed-point
//     (optional width, optional `,decimals`; covers the CL-style `~,2f` models reach for
//     right after `~d`). SRFI-48's numeric-COLUMN directives (`~w` alone), `~r` (radix/
//     roman-numeral), and `~t`/`~_` whitespace directives are NOT bound — they are
//     presentation-layout, not value-rendering, and belong to a port-backed pretty-
//     printer we don't ship.
//   • Directive letters are case-insensitive (SRFI-48 admits `~A`/`~S`/`~D`/`~F`).
//
// PROVENANCE: `format` is a COLLAPSING op (it folds the fmt string + every arg into one
// fresh string), so — exactly like `string-append` / `string-join` — the result is
// `taintString(text, collapseProvenance(fmt, ...args))`, the DEEP union of every input's
// lineage (an arg may be a nested structure). See provenance-collapse.ts and the
// string-append comment in r7rs/strings.ts.
//
// RENDERING: values render through the printer's sole renderer `printValue` (display-
// style — strings bare), so `~a` reuses it directly. `~s` (write-style) is `~a` PLUS a
// re-readable double-quoted, backslash-escaped form for a top-level string (the one place
// the arrival printer, being display-only, differs from R7RS `write`). Non-string args
// render identically under `~a` and `~s`.

import { symbol } from "../../common/symbol.js";
import { EnvCapability } from "../../common/capability.js";
import * as z from "../../common/scheme-zod.js";
import { stringValue, isSchemeNumber } from "../../values/op-helpers.js";
import { collapseProvenance, taintString } from "../../provenance-collapse.js";
import { printValue } from "../../values/print.js";
import { AString } from "../../values/primitives/AString.js";
import { ABool } from "../../values/primitives/ABool.js";
import { ArrivalError } from "../../eval/evaluator.js";

/** A scheme string value (boxed AString, or a raw JS string on the odd pre-box path). */
const isStringLike = (v: unknown): v is AString | string => v instanceof AString || typeof v === "string";

/** Exactly `#f` (raw false or a boxed ABool false) — NOT `#null`, NOT `#t`, NOT a port. */
const isHashF = (v: unknown): boolean => v === false || (v instanceof ABool && v.value === false);

// The only IO effect a wrong destination would name — kept in the tone of r7rs/host.ts's
// IO doors: arrival is a pure inference plane, so streaming out has no construction-site.
const DEST_REASON =
  "format here is string-only: it returns the formatted string. A #t or port destination would stream to a port, but arrival ships no IO surface (it is a pure inference plane). Use (format #f ...) or (format \"...\" ...) to GET the string, then return it from your dataflow";

const SUPPORTED =
  "~a (display) ~s (write) ~d (decimal) ~F / ~w,dF (fixed-point, e.g. ~,2f) ~% (newline) ~~ (literal tilde)";

/** Display-style render (strings bare) — the printer's sole renderer. */
const displayOf = (arg: unknown): string => printValue(arg);

/** Write-style render — display, plus a re-readable quoted/escaped form for a string. */
const writeOf = (arg: unknown): string => {
  if (isStringLike(arg)) {
    const s = stringValue(arg);
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return printValue(arg);
};

export default new EnvCapability("scheme/srfi-28", {
  symbols: {
    format:
      symbol.native`format: (format fmt arg ...) or (format #f fmt arg ...) → the fmt string with ~a (display) ~s (write) ~d (decimal) ~F/~w,dF (fixed-point, e.g. ~,2f) ~% (newline) ~~ (tilde) directives filled from the args; string-only (a #t/port destination is a teaching door — no IO here) (SRFI-28/48)`(
        // A single homogeneous VARIADIC vector, not `[fmt, ...rest]` — the impl (below) is a
        // real `(...args: unknown[])`, and args[0]'s true type is decided AT RUNTIME (a format
        // string per SRFI-28, or `#f` per the SRFI-48/CL destination form, or anything else,
        // which throws the DEST_REASON teaching error) — there is no static fixed-prefix to
        // split `input`/`inputRest` at. Each element is `z.value` (the representation-BLIND
        // scheme-value identity — narrower than the old `z.value`, which was host-blind:
        // it also accepted raw non-scheme JS), since a directive-fill arg can be ANY scheme
        // value (rendered via `displayOf`/`writeOf`).
        { input: z.array(z.value), output: [z.string] },
        (...args: unknown[]): AString => {
          // ── Resolve destination vs format string ───────────────────────────────
          // SRFI-28: first arg IS the format string. SRFI-48/CL: first arg is a
          // destination; we admit `#f` only, and then the SECOND arg is the format.
          let fmtValue: unknown;
          let rest: unknown[];
          // provInputs — the values whose lineage the fresh string inherits: the fmt
          // string + every arg (the `#f` destination carries no data, so it's excluded).
          let provInputs: unknown[];

          if (args.length > 0 && isStringLike(args[0])) {
            fmtValue = args[0];
            rest = args.slice(1);
            provInputs = args;
          } else if (args.length > 0 && isHashF(args[0])) {
            if (args.length < 2 || !isStringLike(args[1])) {
              throw new ArrivalError(
                "format: (format #f fmt arg ...) needs a format string as its second argument",
                [],
              );
            }
            fmtValue = args[1];
            rest = args.slice(2);
            provInputs = args.slice(1);
          } else if (args.length === 0) {
            throw new ArrivalError("format: expected a format string (SRFI-28: (format fmt arg ...))", []);
          } else {
            // #t, a port, or any other non-string, non-#f first argument.
            throw new ArrivalError(`format: ${DEST_REASON}`, []);
          }

          const fmt = stringValue(fmtValue);

          // ── Walk the format string, filling directives from `rest` ─────────────
          let out = "";
          let argi = 0;
          const nextArg = (directive: string): unknown => {
            if (argi >= rest.length) {
              throw new ArrivalError(
                `format: too few arguments for "${fmt}" — the ${directive} directive has no argument to consume`,
                [],
              );
            }
            return rest[argi++];
          };

          for (let i = 0; i < fmt.length; i++) {
            const ch = fmt[i];
            if (ch !== "~") {
              out += ch;
              continue;
            }
            if (i + 1 >= fmt.length) {
              throw new ArrivalError(
                `format: dangling ~ at the end of "${fmt}" — a ~ must be followed by a directive (${SUPPORTED})`,
                [],
              );
            }
            // ── ~F / ~w,dF — SRFI-48's fixed-point directive family, a BOUNDED subset:
            // an optional width, an optional `,decimals`, then a case-insensitive `f`/`F`
            // — enough to cover `~,2f`, the CL-style habit models reach for right after
            // ~a/~s/~d (MCP-Atlas error-corpus `format-unknown-directive:~,` class). Tried
            // BEFORE the single-char switch below because the directive is multi-char
            // (digits + comma), unlike every other directive here. The rest of SRFI-48
            // (~r/~t/~c/~p, column directives, port-backed padding chars) is intentionally
            // NOT implemented — see the module header's scope-narrowing note.
            const fixedPoint = /^(\d*)(?:,(\d*))?[fF]/.exec(fmt.slice(i + 1));
            if (fixedPoint) {
              const [directiveText, widthStr, decimalsStr] = fixedPoint;
              const width = widthStr ? Number.parseInt(widthStr, 10) : undefined;
              const decimals = decimalsStr ? Number.parseInt(decimalsStr, 10) : undefined;
              const n = nextArg(`~${directiveText}`);
              if (!isSchemeNumber(n)) {
                throw new ArrivalError(
                  `format: the ~${directiveText} directive expects a number, got ${displayOf(n)}`,
                  [],
                );
              }
              const num = typeof n === "number" ? n : Number((n as { valueOf(): number | bigint }).valueOf());
              let rendered = decimals === undefined ? String(num) : num.toFixed(decimals);
              if (width !== undefined && rendered.length < width) {
                rendered = " ".repeat(width - rendered.length) + rendered;
              }
              out += rendered;
              i += directiveText.length; // advance past the consumed digits/comma/letter
              continue;
            }

            const d = fmt[++i];
            switch (d) {
              case "a":
              case "A":
                out += displayOf(nextArg("~a"));
                break;
              case "s":
              case "S":
                out += writeOf(nextArg("~s"));
                break;
              case "d":
              case "D": {
                const n = nextArg("~d");
                if (!isSchemeNumber(n)) {
                  throw new ArrivalError(`format: the ~d directive expects a number, got ${displayOf(n)}`, []);
                }
                out += displayOf(n);
                break;
              }
              case "%":
                out += "\n";
                break;
              case "~":
                out += "~";
                break;
              default:
                throw new ArrivalError(
                  `format: unknown directive ~${d} in "${fmt}" — supported directives are ${SUPPORTED}` +
                    ` — nearest form: numbers use ~d (integer) or ~F / ~w,dF (fixed-point); text uses ~a (display) or ~s (write)`,
                  [],
                );
            }
          }

          if (argi < rest.length) {
            throw new ArrivalError(
              `format: too many arguments for "${fmt}" — ${rest.length} given, ${argi} consumed by directives`,
              [],
            );
          }

          // Collapsing op: re-stamp the DEEP union of the fmt string + every arg's lineage.
          return taintString(out, collapseProvenance(...provInputs));
        },
      ),
  },
});
