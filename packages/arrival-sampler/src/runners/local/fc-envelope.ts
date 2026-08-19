// fc-envelope.ts — explicit FSM for native FC models to emit inside the execute-scheme envelope.
//
// Lets models heavily trained on function calling still produce a guaranteed-valid Scheme program
// (in the expr field) under the substrate. 
//
// The model's FC output is a tool call whose SHAPE is family-specific. Two confirmed frames (from the GGUF
// chat templates — see chat-template.ts):
//   • HERMES (qwen3 / nanbeige / rnj-1 / hammer / arch):
//       <tool_call>{"name": "execute-scheme", "arguments": {"intent": "…", "expr": "<scheme>"}}</tool_call>
//     — a JSON object; `expr` is a JSON string (escaped, terminated by an unescaped `"`).
//   • GLM (glm-4.6v / glm-4.7):
//       <tool_call>execute-scheme<arg_key>intent</arg_key><arg_value>…</arg_value>
//                                  <arg_key>expr</arg_key><arg_value><scheme></arg_value></tool_call>
//     — XML key/value; `expr` is RAW (not escaped, terminated by the `</arg_value>` special token).
// Either way it is generated as TOKENS (node-llama-cpp gives the logits), so we can mask it.
//
// ── THE STATE MACHINE IS A `ToolCallFrame` ──
// A frame is a visible, linear `stages` script PLUS the small per-family variance (how a slot is unescaped,
// where its terminator is, what closes the expr slot, whether its tags are special tokens). `makeFrame(spec)`
// closes the SHARED skeleton (`locate`/`decide`) over that spec — one skeleton, written once, so a forked
// family is `makeFrame({ ...SPEC, oneHook })`, never a copy. `decide()` turns the cursor into the one masking
// regime for this step:
//   • literal / tool-name → FORCE-EMIT the structural bytes (the model is held up — the zimmerframe).
//   • intent              → free string, until the model emits the slot terminator.
//   • expr                → the EXISTING Scheme oracle (`pickConstrained`), admitting the close ONLY when
//                           the program is `closeable` (a complete top-level boundary, or empty).
// The decode LOOP (fc-generate.ts) owns the machinery (backend / scanner / oracle / EOS) and consults a
// frame; the frame stays a pure-syntax leaf so collaborator-coupled logic can't accrete onto it.
//
// ── v1 SCOPE (deliberate; widen later) ──
//   • The whole call is FORCED from token 0 (no free preamble / no abstention). The trigger-on-`<tool_call>`
//     two-phase generalization (free think/preamble until the model emits `<tool_call>`) is the next step.
//   • HERMES OBSERVE-DON'T-BLOCK the JSON-escape hazards: a literal newline inside `expr` is invalid JSON and
//     needs `\n`. v1 admits the Scheme token and LOGS the hazard ({@link ToolCallFrame.wireHazards}); the
//     future fix is an oracle "rewrite strategy". (GLM is raw, so it has no such hazard.)

/** The arrival discovery tool, renamed: a generalized Scheme runner, not just "discover". */
export const EXECUTE_SCHEME_TOOL = "execute-scheme";

/** One node of the envelope FSM. The union is exhaustive — the decoder is always in exactly one. */
export type Stage =
  | { readonly id: "literal"; readonly text: string } // forced structural / tool-call-frame bytes
  | { readonly id: "tool-name" } //                      the tool name (v1: forced to EXECUTE_SCHEME_TOOL)
  | { readonly id: "intent" } //                         free string value, until the slot terminator
  | { readonly id: "expr" }; //                          Scheme REPL value, Σ-masked, until a closeable close

/** The literal bytes a stage forces: a `literal`'s `text`, or the (v1-forced) tool name. */
function stageLiteral(stage: Stage): string | null {
  if (stage.id === "literal") return stage.text;
  if (stage.id === "tool-name") return EXECUTE_SCHEME_TOOL;
  return null; // intent / expr are generated, not forced
}

/**
 * The index in `s` (≥ `from`) of the first `"` that is NOT backslash-escaped, or -1. JSON strings escape
 * an interior quote as `\"`; an odd run of backslashes before a `"` escapes it. This is the HERMES slot
 * terminator scan (intent + expr); exported for the FSM tests.
 */
export function firstUnescapedQuote(s: string, from = 0): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] !== '"') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= from && s[j] === "\\"; j--) backslashes++;
    if (backslashes % 2 === 0) return i;
  }
  return -1;
}

/**
 * JSON-string DESERIALIZE a wire value into the raw Scheme the oracle must see — the HERMES `unescapeWire`.
 * A Hermes model emits ESCAPED Scheme on the wire (`\"` for a string quote, `\n` for a newline), but the Σ /
 * structure oracle reasons over RAW Scheme. Handles `\" \\ \/ \n \t \r \b \f` and `\uXXXX`; a trailing
 * incomplete escape (a lone `\` at the end) is DROPPED (pending the next token). (GLM is raw — its
 * `unescapeWire` is the identity.)
 */
export function jsonUnescape(wire: string): string {
  let out = "";
  for (let i = 0; i < wire.length; i++) {
    const c = wire[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = wire[i + 1];
    if (n === undefined) break; // trailing lone backslash — pending, dropped until the next token completes it
    switch (n) {
      case '"': out += '"'; break;
      case "\\": out += "\\"; break;
      case "/": out += "/"; break;
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "u": {
        const hex = wire.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += n; // malformed \u — pass the char through
        }
        break;
      }
      default:
        out += n; // unknown escape — pass the escaped char through
    }
    i++; // consumed the escaped char
  }
  return out;
}

/** Where the decode cursor sits in the envelope, derived statelessly from the generated text so far.
 *  `forcedRemaining` is set iff the current stage is forced (literal / tool-name) and not yet complete —
 *  the exact bytes still owed. `exprSoFar` is the raw `expr` content generated so far (Scheme to mask). */
export interface Cursor {
  readonly stageIndex: number;
  readonly stage: Stage | null; // null ⇒ the whole envelope is complete (DONE)
  readonly forcedRemaining?: string;
  readonly exprSoFar?: string;
}

function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** What the decode loop should do for this step — the one masking regime, chosen by the cursor's stage.
 *  `force` skips the model (emit the bytes); `free` is an unconstrained string pick; `scheme` defers to the
 *  existing `pickConstrained` on `exprPrefix`, additionally admitting the close when the loop finds the
 *  program `closeable` (the loop owns the scanner, so it computes closeable from `exprPrefix`). */
export type EnvelopeAction =
  | { readonly kind: "force"; readonly bytes: string; readonly stage: Stage["id"] }
  | { readonly kind: "free"; readonly stage: "intent" } // close on the slot terminator
  | { readonly kind: "scheme"; readonly exprPrefix: string } // pickConstrained + admit close iff closeable
  | { readonly kind: "done" };

/** Tuning for {@link ToolCallFrame.decide}. */
export interface DecideOptions {
  /** Force `(` at the expr opening so the model writes a CALL (default true — the dropped-prefill fix). Set
   *  FALSE to let the model pick the first expr token freely, INCLUDING an immediate close (an empty
   *  expr = "no call at all"). That is the abstention probe: on an irrelevant prompt, does the model decline
   *  by leaving expr empty, or hallucinate a call anyway? */
  readonly forceOpenParen?: boolean;
}

/** A JSON-escape hazard observed inside the `expr` value — content that is not yet escaped and would make a
 *  HERMES envelope invalid JSON. v1 LOGS these to size the future "rewrite strategy"; it does not block. */
export interface ExprHazard {
  readonly kind: "newline" | "control-char";
  /** The offending substring (e.g. "\n"). */
  readonly text: string;
  /** Offset within the wire expr value. */
  readonly at: number;
}

/** Scan a committed wire `expr` chunk for BARE (unescaped) control chars — the genuine JSON-string breakers a
 *  rewrite-strategy must escape (`\n`, `\t`, …). The HERMES `wireHazards`. Quotes/backslashes the model
 *  escapes ITSELF (verified live), so they are NOT hazards; the closing `"` is the FSM terminator, not here. */
export function exprHazards(exprChunk: string, baseOffset = 0): ExprHazard[] {
  const out: ExprHazard[] = [];
  for (let i = 0; i < exprChunk.length; i++) {
    const c = exprChunk[i]!;
    if (c === "\n" || c === "\r" || c === "\t") out.push({ kind: "newline", text: c, at: baseOffset + i });
    else if (c.charCodeAt(0) < 0x20) out.push({ kind: "control-char", text: c, at: baseOffset + i });
  }
  return out;
}

// ── the frame: per-family variance (data + the leaf logic), composed by makeFrame ──────────────────────

/** The per-family VARIANCE — everything two tool-call frames genuinely differ on. `makeFrame` closes the
 *  shared `locate`/`decide` skeleton over a spec; a forked family is `makeFrame({ ...SPEC, oneHook })`. */
export interface FrameSpec {
  /** The visible linear `stages` script. The slot-closing terminator of intent/expr is MODEL-emitted (part
   *  of the slot); the literals are the structure BETWEEN slots, with NO leading terminator. */
  readonly stages: readonly Stage[];
  /** Wire value → raw Scheme for the oracle. HERMES: {@link jsonUnescape}; GLM: identity (raw). */
  unescapeWire(wire: string): string;
  /** The position just PAST a generated slot's terminator in `text` (≥ `from`), or -1 if not yet present.
   *  HERMES: the next unescaped `"`, +1; GLM: `indexOf("</arg_value>")`, + its length. */
  findTerminator(text: string, from: number): number;
  /** The literal bytes that close the `expr` slot when the program is `closeable`. HERMES: `"`; GLM:
   *  `</arg_value>`. The loop tokenizes this (with {@link forceSpecialTokens}) and force-emits it when the
   *  model's argmax IS its first token at a closeable boundary. */
  readonly exprCloseDelimiter: string;
  /** Bare-control-char hazards in a committed wire `expr` chunk (observe-first). HERMES: {@link exprHazards};
   *  GLM: none (raw arg value — newlines are legal, nothing to escape). */
  wireHazards(exprChunk: string, baseOffset: number): ExprHazard[];
  /** Tokenize/detokenize the frame's structural bytes with `specialTokens` set to THIS. GLM's tags
   *  (`<tool_call>`, `<arg_value>`, `</arg_value>`, …) are ADDED tokens — invisible under `false` — so GLM
   *  needs `true`. HERMES uses `false` (its proven path; its literals are plain text). */
  readonly forceSpecialTokens: boolean;
}

/** A frame = its spec PLUS the shared, derived FSM behaviour (`locate`/`decide`). */
export interface ToolCallFrame extends FrameSpec {
  /** Walk the `stages` consuming `fcText` and report the cursor — pure + stateless, re-derivable each step. */
  locate(fcText: string): Cursor;
  /** The per-step decision read straight off the cursor — the heart of the FSM. */
  decide(fcText: string, opts?: DecideOptions): EnvelopeAction;
}

/**
 * Compose a {@link ToolCallFrame} from its variance: close the SHARED `locate`/`decide` skeleton over `spec`.
 * The skeleton is written ONCE here; a family supplies only the variance, and a forked family spreads the
 * spec. (This is Template-Method's win — write-once skeleton, define-only-the-variance — in functional form,
 * with no class, no `this`, no inheritance: the frame stays a flat leaf.)
 */
export function makeFrame(spec: FrameSpec): ToolCallFrame {
  /** Walk `spec.stages`; a forced literal must match (else park as `forcedRemaining`); a generated slot
   *  scans for `spec.findTerminator`. Assumes forced bytes were emitted faithfully (we force them). */
  function locate(fcText: string): Cursor {
    let pos = 0;
    for (let i = 0; i < spec.stages.length; i++) {
      const stage = spec.stages[i]!;
      const lit = stageLiteral(stage);
      if (lit !== null) {
        const have = fcText.slice(pos, pos + lit.length);
        if (have === lit) {
          pos += lit.length; // forced bytes fully present — advance to the next stage
          continue;
        }
        const matched = commonPrefixLen(have, lit); // still owed (or re-force from the matching prefix)
        return { stageIndex: i, stage, forcedRemaining: lit.slice(matched) };
      }
      // generated slot: scan for the model's slot terminator
      const after = spec.findTerminator(fcText, pos);
      if (after === -1) {
        return stage.id === "expr"
          ? { stageIndex: i, stage, exprSoFar: fcText.slice(pos) }
          : { stageIndex: i, stage };
      }
      pos = after; // consume the content + its terminator; advance to the next stage
    }
    return { stageIndex: spec.stages.length, stage: null }; // DONE — full call emitted
  }

  function decide(fcText: string, opts: DecideOptions = {}): EnvelopeAction {
    const cur = locate(fcText);
    if (cur.stage === null) return { kind: "done" };
    if (cur.forcedRemaining !== undefined) return { kind: "force", bytes: cur.forcedRemaining, stage: cur.stage.id };
    if (cur.stage.id === "intent") return { kind: "free", stage: "intent" };
    // expr: DESERIALIZE the wire to raw Scheme for the oracle. FORCE `(` at a form start so the model writes a
    // CALL — the FC envelope dropped prompt-mode's `(` prefill, which is why a bare `set-timer` slipped through.
    const raw = spec.unescapeWire(cur.exprSoFar ?? "");
    if (raw === "" && opts.forceOpenParen !== false) return { kind: "force", bytes: "(", stage: "expr" };
    return { kind: "scheme", exprPrefix: raw };
  }

  return { ...spec, locate, decide };
}

// ── the two confirmed frames ────────────────────────────────────────────────────────────────────────────

/** HERMES stages (qwen3 / nanbeige / rnj-1 / hammer / arch). The closing `"` of intent/expr is MODEL-emitted
 *  (it ends that slot); the following literals carry NO leading `"`. Also exported as `ENVELOPE` (back-compat). */
export const HERMES_STAGES: readonly Stage[] = [
  { id: "literal", text: '<tool_call>\n{"name": "' },
  { id: "tool-name" }, //                      forced ⇒ its closing `"` is forced, in the next literal
  { id: "literal", text: '", "arguments": {"intent": "' },
  { id: "intent" }, //                         the model emits the closing `"` (it decides intent is done)
  { id: "literal", text: ', "expr": "' }, //   ← no leading `"`: intent's closing `"` was model-emitted
  { id: "expr" }, //                           the model emits the closing `"` (admitted only when closeable)
  { id: "literal", text: "}}\n</tool_call>" }, // ← no leading `"`: expr's closing `"` was model-emitted
];

/** Back-compat alias — the original single (Hermes) envelope. */
export const ENVELOPE = HERMES_STAGES;

const HERMES_SPEC: FrameSpec = {
  stages: HERMES_STAGES,
  unescapeWire: jsonUnescape,
  findTerminator: (text, from) => {
    const q = firstUnescapedQuote(text, from);
    return q === -1 ? -1 : q + 1; // past the closing `"`
  },
  exprCloseDelimiter: '"',
  wireHazards: exprHazards,
  forceSpecialTokens: false,
};

/** The Hermes/Qwen JSON tool-call frame. */
export const HERMES_FRAME: ToolCallFrame = makeFrame(HERMES_SPEC);

/** GLM's `</arg_value>` close tag — a single special token (id 151359 in GLM-4.6V), so its `indexOf` in the
 *  emitted text is unambiguous (no collision with Scheme's `<`), and forcing it tokenizes to one id. */
const GLM_ARG_CLOSE = "</arg_value>";

/** GLM stages (glm-4.6v / glm-4.7). XML key/value; the `</arg_value>` terminator of intent/expr is
 *  MODEL-emitted; the following literals carry NO leading `</arg_value>`. The tags are special tokens
 *  (forceSpecialTokens). */
export const GLM_STAGES: readonly Stage[] = [
  { id: "literal", text: "<tool_call>" },
  { id: "tool-name" }, //                      execute-scheme
  { id: "literal", text: "\n<arg_key>intent</arg_key>\n<arg_value>" },
  { id: "intent" }, //                         the model emits `</arg_value>` to close intent
  { id: "literal", text: `\n<arg_key>expr</arg_key>\n<arg_value>` }, // ← no leading close: intent's was model-emitted
  { id: "expr" }, //                           the model emits `</arg_value>` (admitted only when closeable)
  { id: "literal", text: "\n</tool_call>" }, // ← no leading close: expr's `</arg_value>` was model-emitted
];

const GLM_SPEC: FrameSpec = {
  stages: GLM_STAGES,
  unescapeWire: (wire) => wire, // raw — GLM arg values are not JSON-escaped
  findTerminator: (text, from) => {
    const i = text.indexOf(GLM_ARG_CLOSE, from);
    return i === -1 ? -1 : i + GLM_ARG_CLOSE.length; // past `</arg_value>`
  },
  exprCloseDelimiter: GLM_ARG_CLOSE,
  wireHazards: () => [], // raw arg value — newlines are legal, nothing escapes
  forceSpecialTokens: true,
};

/** The GLM XML key/value tool-call frame. */
export const GLM_FRAME: ToolCallFrame = makeFrame(GLM_SPEC);

// ── back-compat standalone entry points (delegate to HERMES_FRAME) ──────────────────────────────────────
// The FSM unit tests + any non-frame-aware caller use these; they are the Hermes frame's methods, so the
// suite proves Hermes stays byte-identical through the refactor.

/** Walk the (Hermes) ENVELOPE and report the cursor. @see ToolCallFrame.locate */
export function locate(fcText: string): Cursor {
  return HERMES_FRAME.locate(fcText);
}

/** The per-step decision for the (Hermes) ENVELOPE. @see ToolCallFrame.decide */
export function decide(fcText: string, opts: DecideOptions = {}): EnvelopeAction {
  return HERMES_FRAME.decide(fcText, opts);
}
