// chat-template.ts — per-family chat template rendering.
//
// Used by the wiring. For minimal OpenAI/BFCL path the server mostly uses render-strategies; family
// frames for native FC are research. Pure (type-only llama). 

import dedent from "dedent";
import type { LlamaModel } from "node-llama-cpp";

import { GLM_FRAME, HERMES_FRAME, type ToolCallFrame } from "./local/fc-envelope.js";
import { buildMessages } from "./generate.js";

/** A family's prompt renderer: frame the (optional) system + user turns and OPEN the assistant turn,
 *  splitting at the assistant-open so `tailText` ends right where the model continues (then + prefill).
 *  `sys`/`user` are the already-assembled message contents; `prefill` seeds the assistant turn. */
type ChatTemplateRenderer = (
  sys: string | undefined,
  user: string,
  prefill: string,
) => { systemText: string; tailText: string };

/**
 * THE HOLISTIC PER-FAMILY DEFINITION — everything per-arch in one place. A family is its `render` (prompt
 * frame), its `turnTerminator` (the literal token its template ends an assistant turn with — node-llama's
 * `tokens.eos`/`eot` frequently report a DIFFERENT id, so the decode loop adds this explicitly; `null` ⇒
 * rely on the model's own eos/eot), and its `toolCallFrame` (the FC-envelope shape — note it is a SEPARATE
 * dimension from the prompt frame: rnj-1 is `llama3`-prompt but `hermes`-tool).
 */
export interface FamilyDef {
  readonly render: ChatTemplateRenderer;
  readonly turnTerminator: string | null;
  readonly toolCallFrame: ToolCallFrame;
  /** The family's reasoning-block OPENER, if it has one (e.g. ChatML/qwen3 `"<think>\n"`). The FC reasoning
   *  budget force-emits this to enable thinking (the template's enable_thinking prefill). Undefined ⇒ the
   *  family has no `<think>`-style control, so a reasoning budget no-ops. */
  readonly thinkOpen?: string;
  /** How the family's think-CLOSE marker resolves, when it is NOT ordinary text. Omitted (the default):
   *  {@link runThinkPhase} resolves the close by tokenizing the literal text `"</think>"`
   *  (`model.tokenize("</think>", false)`) — correct when `</think>` is genuine VOCABULARY TEXT (qwen3's
   *  `chatml`, GLM's `glm`/`glm-think` markers are ordinary text tokens too). Nemotron's `<think>`/`</think>`
   *  are SPECIAL/control tokens instead (ids 12/13 — see the `nemotron` FamilyDef below): text-tokenizing with
   *  `specialTokens:false` can never produce the real special id (it resolves to some OTHER, wrong id), so the
   *  true close is swallowed as ordinary reasoning content and the hard backstop then force-commits the WRONG
   *  id — DOUBLE-emitting `</think>`. Declare the family's real close id here to bypass the text-tokenize path
   *  entirely for it. */
  readonly thinkCloseSpecialToken?: number;
}

/**
 * THE REGISTRY — family → holistic definition. `"llama3"` is the original Rnj-1 frame, kept BYTE-IDENTICAL
 * (the loop-parity gate verifies the same token stream). `"chatml"` is the Qwen/ChatML frame. `"glm"` /
 * `"glm-think"` are GLM-4.x's thinking-OFF/ON twins — same system/tail frame, differing only in whether the
 * assistant turn hardcodes `</think>` (see the `glm` FamilyDef comment). `"nemotron"` is the (UNVALIDATED —
 * see its own comment) Nemotron frame. Tool frames: llama3/chatml/deepseek/nemotron emit Hermes JSON tool
 * calls; glm/glm-think emit the `<arg_key>/<arg_value>` XML. The `gemma`/`phi`/`falcon`/`cohere` rows remain
 * follow-up STUBS (see git history) — add a FamilyDef here + one `detectChatTemplate` branch (unless the
 * family is a PER-RUN choice rather than a GGUF property, like `glm-think` — see its comment); the union
 * derives from the keys, so it can't drift.
 */
export const CHAT_TEMPLATES = {
  // Llama-3 instruct (Rnj-1). MUST stay byte-identical to the original renderPrompt output. Hermes tool calls.
  llama3: {
    render: (sys, user, prefill) => ({
      systemText: dedent`
        <|begin_of_text|><|start_header_id|>system<|end_header_id|>

        ${sys}<|eot_id|>`,
      tailText: dedent`
        <|start_header_id|>user<|end_header_id|>

        ${user}<|eot_id|><|start_header_id|>assistant<|end_header_id|>

        ${prefill}`,
    }),
    turnTerminator: "<|eot_id|>",
    toolCallFrame: HERMES_FRAME,
    thinkOpen: undefined, // Rnj-1 is not a reasoning model
    thinkCloseSpecialToken: undefined,
  },
  // ChatML (Qwen2.5/3, xLAM-2, Hammer2.1, Arch-Agent, SmolLM2). Markers are real Qwen special tokens. Hermes.
  chatml: {
    render: (sys, user, prefill) => ({
      systemText: `<|im_start|>system\n${sys}<|im_end|>\n`,
      tailText: dedent`
        <|im_start|>user
        ${user}<|im_end|>
        <|im_start|>assistant
        ${prefill}`,
    }),
    turnTerminator: "<|im_end|>",
    toolCallFrame: HERMES_FRAME,
    thinkOpen: "<think>\n", // qwen3 reasons when the assistant turn opens with <think> (template enable_thinking)
    thinkCloseSpecialToken: undefined, // qwen3's </think> is ordinary vocabulary TEXT — the default text-tokenize path resolves it correctly
  },
  // GLM-4.x / ChatGLM (GLM-4.7-Flash, GLM-4.6V-Flash, arch deepseek2). Markers are real GLM special control
  // tokens ([gMASK]/<sop>/<|system|>/<|user|>/<|assistant|>, each a single id under specialTokens:true). The
  // assistant turn is OPENED thinking-OFF (`<|assistant|></think>`) — the model's own template emits `</think>`
  // for the no-reasoning path, so it continues straight into the answer. GLM `<arg_key>/<arg_value>` tool frame.
  glm: {
    render: (sys, user, prefill) => ({
      systemText: `[gMASK]<sop><|system|>\n${sys}`,
      tailText: dedent`
        <|user|>
        ${user}<|assistant|>
        </think>${prefill}`,
    }),
    turnTerminator: "<|user|>", // GLM-4 ends an assistant turn at the next role marker; guarded if not a single special id.
    toolCallFrame: GLM_FRAME,
    // thinking-OFF: this family hardcodes `</think>` in the render (the no-reasoning path), so it has NO
    // reasoning-open token → the think phase no-ops here. GLM-4.6/4.6V models that DO want to reason use the
    // SEPARATE `glm-think` family below (identical system/tail frame minus the hardcoded `</think>`, thinkOpen
    // `<think>\n`). Selecting between them is ROSTER-DRIVEN (an explicit `chatTemplate` override), never
    // auto-detected — thinking-on/off is a PER-RUN choice, not a GGUF property, so `detectChatTemplate` always
    // resolves a GLM GGUF to plain `"glm"` here (glm-4.7-flash's byte-identical thinking-OFF path never drifts).
    thinkOpen: undefined,
    thinkCloseSpecialToken: undefined,
  },
  // GLM-4.6/4.6V's THINKING-ON twin of `glm` — identical system/tail frame, tool frame, and turn terminator,
  // but the assistant turn is left OPEN (no hardcoded `</think>`) so the shared reasoning-budget mechanism can
  // prefill `thinkOpen` (GLM's `enable_thinking` text marker) and `runThinkPhase` reasons freely before the
  // answer, exactly like qwen3/chatml. Select it EXPLICITLY via `chatTemplate: "glm-think"` — it is
  // intentionally UNREACHABLE from `detectChatTemplate` (see the `glm` comment above: thinking-on/off is a
  // per-run choice, not a GGUF property). The roster already sets glm-4.6v's `thinkBudget` today; it opts into
  // this family the same way once wired roster-side (out of scope here — this package only needs to make the
  // family SELECTABLE).
  "glm-think": {
    render: (sys, user, prefill) => ({
      systemText: `[gMASK]<sop><|system|>\n${sys}`,
      tailText: dedent`
        <|user|>
        ${user}<|assistant|>
        ${prefill}`,
    }),
    turnTerminator: "<|user|>",
    toolCallFrame: GLM_FRAME,
    thinkOpen: "<think>\n", // LIVE-VALIDATE: confirm against the loaded GLM-4.6/4.6V GGUF that this is the literal enable_thinking text prefill (mirrors qwen3/chatml's opener).
    thinkCloseSpecialToken: undefined, // GLM's </think> is ordinary vocabulary TEXT, same as qwen3 — the default text-tokenize path applies
  },
  // DeepSeek-Coder instruct (xLAM-1b-fc-r is DeepSeek-Coder-1.3B-based — its GGUF `architecture` says `llama`,
  // so the arch fallback wrongly picks llama3, whose `<|eot_id|>`/`<|start_header_id|>` tokens DON'T exist in
  // the DeepSeek vocab and shatter into bytes → 0% output. Its real frame is `### Instruction:` / `### Response:`
  // with bos `<｜begin▁of▁sentence｜>` (32013) and eos `<|EOT|>` (32021), all single special ids in-vocab.
  deepseek: {
    render: (sys, user, prefill) => ({
      systemText: `<｜begin▁of▁sentence｜>${sys ?? ""}`,
      tailText: dedent`
        ### Instruction:
        ${user}
        ### Response:
        ${prefill}`,
    }),
    turnTerminator: "<|EOT|>",
    toolCallFrame: HERMES_FRAME,
    thinkOpen: undefined,
    thinkCloseSpecialToken: undefined,
  },
  // Nemotron-3 / "the Nemotrons" (`nemotron_h` arch — NVIDIA's hybrid Mamba-Transformer line). Currently
  // mis-detected → llama3 (no `nemotron_h` branch below); fixed by the detectChatTemplate case added with
  // this family. UNVALIDATED BEST-EFFORT FRAME: everything below except the `thinkCloseSpecialToken` mechanism
  // itself is a GUESS, not a researched fact — NVIDIA's historically-documented Nemotron convention
  // (Nemotron-4-340B-Instruct / Llama-3.1-Nemotron), repurposed T5 sentinel tokens as role markers. Whether
  // `nemotron_h` kept this convention is UNCONFIRMED (V has not loaded this model yet — "Nemotron loading
  // soon"). Every literal is flagged; confirm ALL of them (not only the think ids) against the loaded GGUF's
  // `tokenizer.chat_template` / architecture docs before relying on this family for real decoding.
  // Nemotron-3 Nano (`nemotron_h` arch). VERIFIED against the GGUF's embedded chat_template + tokenizer
  // (NVIDIA-Nemotron-3-Nano-4B-Q8_0, 2026-07-05): the frame is CHATML — byte-identical to `chatml` above
  // (`<|im_start|>role\n…<|im_end|>\n`, assistant opens `<|im_start|>assistant\n<think>\n`, Hermes tool
  // frame). The ONE difference from qwen3/chatml: `<think>`/`</think>` are SPECIAL control tokens (ids 12/13,
  // confirmed in tokenizer.ggml.tokens), NOT ordinary vocabulary text. So the CLOSE must resolve via
  // `thinkCloseSpecialToken` (the text-tokenize fallback would never produce id 13 — that's the bug the
  // pinned test guards). `enable_thinking` defaults True in the template, so the reasoning path is the norm.
  nemotron: {
    render: (sys, user, prefill) => ({
      systemText: `<|im_start|>system\n${sys}<|im_end|>\n`,
      tailText: dedent`
        <|im_start|>user
        ${user}<|im_end|>
        <|im_start|>assistant
        ${prefill}`,
    }),
    turnTerminator: "<|im_end|>",
    toolCallFrame: HERMES_FRAME,
    thinkOpen: "<think>\n",
    thinkCloseSpecialToken: 13, // nemotron_h's </think> is special-token id 13 (verified in the GGUF vocab).
  },
} satisfies Record<string, FamilyDef>;

/** The chat-template families this backend supports — DERIVED from the registry keys via
 *  `keyof typeof CHAT_TEMPLATES`, so adding a FamilyDef above is the SINGLE act that creates a family (the
 *  union cannot drift from the registry). To make it auto-DETECTABLE from a GGUF's own metadata, also add a
 *  {@link detectChatTemplate} branch — but that is NOT mandatory: a family whose selection is a PER-RUN choice
 *  rather than a GGUF property (e.g. `"glm-think"`) is legitimately reachable ONLY via an explicit
 *  `chatTemplate` override, by design (see `detectChatTemplate`'s doc). */
export type ChatTemplateFamily = keyof typeof CHAT_TEMPLATES;

/**
 * AUTO-DETECT the family from the loaded GGUF's metadata (cheap — node-llama-cpp parses it at load).
 * Two signals, template-string first:
 *   1. `metadata.tokenizer.chat_template` — the embedded Jinja. If it contains `<|im_start|>` ⇒ ChatML;
 *      if `<|start_header_id|>` ⇒ Llama-3; the GLM control tokens + `[gMASK]<sop>` ⇒ GLM. This is the ROBUST
 *      signal: xLAM-2/Hammer/Arch-Agent/SmolLM2 vary in ARCHITECTURE but all template as ChatML.
 *   2. `metadata.general.architecture` — fallback when no template is embedded.
 * When NEITHER resolves, returns `"llama3"` (Rnj-1's family) as a last-resort guess — but emits a
 * `console.warn` first, because that guess is a SILENT-WRONG-DEFAULT risk (the GLM-4.7-Flash `deepseek2` bug
 * was exactly this). The caller's explicit `chatTemplate` option OVERRIDES this.
 *
 * NOTE: this function only ever returns AUTO-DETECTABLE families. `"glm-think"` is deliberately excluded —
 * thinking-on/off for GLM is a PER-RUN choice, not a GGUF property, so a GLM GGUF always resolves to plain
 * `"glm"` here; a caller opts into `"glm-think"` via the explicit `chatTemplate` override instead.
 */
export function detectChatTemplate(model: LlamaModel): ChatTemplateFamily {
  const meta = model.fileInfo.metadata;
  const template = meta.tokenizer?.chat_template;
  const arch = meta.general?.architecture;
  // Normalize each signal to a string so every case is a pure predicate: an absent signal becomes "",
  // matches nothing, and falls through to the next signal — exactly as the original nested guards did.
  const tpl = typeof template === "string" ? template : "";
  const ar = typeof arch === "string" ? arch : "";
  switch (true) {
    // 1. Embedded template string — the ROBUST signal (architecture varies; the template states the frame).
    case tpl.includes("<|im_start|>"):
      return "chatml";
    case tpl.includes("<|start_header_id|>"):
      return "llama3";
    // GLM-4.x: no ChatML/Llama-3 markers, but the GLM control tokens + the [gMASK]<sop> bos prefix.
    case tpl.includes("[gMASK]") && tpl.includes("<|assistant|>"):
      return "glm";
    // DeepSeek-Coder (xLAM-1b-fc-r): `### Instruction:` frame + eos `<|EOT|>`. Its GGUF `architecture` is
    // `llama`, so this template-string case MUST precede the `llama` arch fallback below — else it mis-frames
    // to llama3 (tokens not in the DeepSeek vocab → shattered → 0% output).
    case tpl.includes("### Instruction:") || tpl.includes("<|EOT|>"):
      return "deepseek";
    // 2. Architecture fallback — when no template is embedded.
    case ar.startsWith("qwen"):
      return "chatml";
    case ar.startsWith("llama"):
      return "llama3";
    // GLM-4-MoE ships in GGUF as the `deepseek2` architecture; ChatGLM as `glm`/`chatglm`.
    case ar.startsWith("glm") || ar.startsWith("chatglm") || ar === "deepseek2":
      return "glm";
    // Nemotron-3 / "the Nemotrons" — nemotron_h's hybrid Mamba-Transformer arch. Unlike GLM there is no
    // thinking-OFF twin to disambiguate here (today's roster always sets a thinkBudget for "the Nemotrons" —
    // add a `nemotron-no-think` twin if a non-reasoning cell is ever needed), so the arch alone is unambiguous
    // and this case is safe to auto-detect (unlike `glm-think`, which needs a roster-side choice).
    case ar === "nemotron_h":
      return "nemotron";
    // UNRECOGNIZED: no signal matched. Fall back to "llama3" to keep today's behavior, but warn LOUD so the
    // next mis-framed arch isn't silent (the class of bug that mis-framed GLM-4.7-Flash — nemotron_h fell into
    // this exact bucket before the case above).
    default:
      // eslint-disable-next-line no-console
      console.warn(
        `[arrival-sampler] detectChatTemplate: no chat-template signal matched ` +
          `(arch=${typeof arch === "string" ? JSON.stringify(arch) : "<none>"}, ` +
          `template=${typeof template === "string" ? "present-but-unrecognized" : "<none>"}). ` +
          `Falling back to "llama3" as a GUESS — if this model is not Llama-3-framed the prompt is mis-framed ` +
          `(garbled output). Add a detectChatTemplate branch + a CHAT_TEMPLATES FamilyDef for this family.`,
      );
      return "llama3";
  }
}

/**
 * Render a chat prompt for the given `family` (default `"llama3"` ⇒ Rnj-1 is unchanged). Dispatches to the
 * family's renderer in {@link CHAT_TEMPLATES}, splitting at the assistant-turn-open so the prefill seeds the
 * assistant turn. EXPORTED so the loop-parity test renders the BYTE-IDENTICAL prompt the decode loop uses.
 */
export function renderPrompt(
  taskPrompt: string,
  systemPrompt: string | undefined,
  prefill: string,
  family: ChatTemplateFamily = "llama3",
): { systemText: string; tailText: string } {
  const [sys, user] = buildMessages(taskPrompt, systemPrompt ?? "");
  return CHAT_TEMPLATES[family].render(sys.content, user.content, prefill);
}
