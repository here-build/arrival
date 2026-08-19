// chat-template.test.ts — the MODEL-FREE gate on the per-family chat-template registry (renderPrompt).
//
// The llama.cpp backend renders each task prompt with a per-FAMILY chat frame (the CHAT_TEMPLATES
// registry). This test pins both framings WITHOUT loading a model: it drives the exported `renderPrompt`
// with an explicit systemPrompt (so the content is fixed — no dependency on the apple-intents default,
// which embeds drifting CONTACTS/INSTALLED_APPS) and asserts the EXACT emitted strings.
//
//   • "llama3" (the default / Rnj-1) — MUST stay byte-identical to the original hardcoded frame. The
//     loop-parity benchmark proves token-identity on the real GGUF; this test proves the STRING is
//     unchanged with no model, so a registry refactor that drifts the Llama-3 bytes fails in default CI.
//   • "chatml" (Qwen2.5 / xLAM-2 / Hammer2.1 / Arch-Agent / SmolLM2) — the `<|im_start|>…<|im_end|>`
//     frame, split at the assistant-turn-open with the prefill at the tail.
//   • detectChatTemplate — auto-detection over synthetic GGUF metadata (template-string + arch signals).
//
// Per .claude/rules/tests.md this is `__tests__/` (a pass/fail verdict, model-free → the default CI gate).

import { afterEach, describe, expect, it, vi } from "vitest";

import { CHAT_TEMPLATES, detectChatTemplate, renderPrompt, type ChatTemplateFamily } from "../../src/runners/chat-template.js";

// A fixed system prompt + task, so the asserted strings are deterministic (no default-framing drift).
const SYS = "You are a function caller.";
const TASK = "Set a timer for 5 minutes.";
const PREFILL = "(";
// What buildMessages produces for the user turn — kept in sync with runner/generate.ts buildMessages.
const USER = `User: ${TASK}\nProgram:`;
// Stable alphabetical comparator for the registry-key set check (toSorted needs an explicit comparator).
const byName = (a: string, b: string) => a.localeCompare(b);

describe("chat-template registry: renderPrompt frames per family", () => {
  it("llama3 (default) is byte-identical to the original hardcoded frame", () => {
    // EXACT strings the pre-registry renderPrompt emitted — the byte-identity contract (the loop-parity
    // benchmark proves the same bytes tokenize identically on the real Rnj-1 GGUF).
    const expectedSystem = `<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n${SYS}<|eot_id|>`;
    const expectedTail =
      `<|start_header_id|>user<|end_header_id|>\n\n${USER}<|eot_id|>` +
      `<|start_header_id|>assistant<|end_header_id|>\n\n${PREFILL}`;

    // Called with 3 args → default family "llama3".
    const defaulted = renderPrompt(TASK, SYS, PREFILL);
    expect(defaulted.systemText, "llama3 systemText must be byte-identical").toBe(expectedSystem);
    expect(defaulted.tailText, "llama3 tailText must be byte-identical").toBe(expectedTail);

    // Explicit "llama3" must match the default exactly.
    const explicit = renderPrompt(TASK, SYS, PREFILL, "llama3");
    expect(explicit).toEqual(defaulted);
  });

  it("chatml frames system/user/assistant turns with <|im_start|>…<|im_end|> and the prefill at the tail", () => {
    const { systemText, tailText } = renderPrompt(TASK, SYS, PREFILL, "chatml");

    // The system turn (split point): system role, content, im_end, trailing newline.
    expect(systemText, "chatml systemText frames the system turn").toBe(`<|im_start|>system\n${SYS}<|im_end|>\n`);
    // The tail: user turn closed, then the assistant turn OPENED (no <|im_end|>) with the prefill last —
    // exactly where the model continues.
    expect(tailText, "chatml tailText opens the assistant turn with the prefill last").toBe(
      `<|im_start|>user\n${USER}<|im_end|>\n<|im_start|>assistant\n${PREFILL}`,
    );

    // Structural cross-checks (independent of the literal above):
    expect(tailText.endsWith(`<|im_start|>assistant\n${PREFILL}`), "prefill seeds the assistant turn").toBe(true);
    // The assistant turn is OPEN — no closing <|im_end|> after it (the model writes the body).
    expect(tailText.includes("<|im_start|>assistant\n")).toBe(true);
    expect(tailText.split("<|im_start|>assistant\n")[1], "nothing after the assistant-open but the prefill").toBe(
      PREFILL,
    );
    // No Llama-3 markers leak into the ChatML frame.
    expect(systemText.includes("<|begin_of_text|>"), "no llama3 BOS in chatml").toBe(false);
    expect(tailText.includes("<|start_header_id|>"), "no llama3 header in chatml").toBe(false);
  });

  it("glm frames the GLM-4.x system/user turns with [gMASK]<sop> + control tokens and opens thinking-OFF", () => {
    const { systemText, tailText } = renderPrompt(TASK, SYS, PREFILL, "glm");

    // The system turn (split point): [gMASK]<sop> bos prefix, <|system|> role token, content. No <|eot|>
    // closer — GLM's turn boundary is the NEXT role token (<|user|>), which opens the tail.
    expect(systemText, "glm systemText frames the GLM system turn with the [gMASK]<sop> bos prefix").toBe(
      `[gMASK]<sop><|system|>\n${SYS}`,
    );
    // The tail: user turn (opened by <|user|>), then the assistant turn OPENED <|assistant|> with the
    // no-reasoning </think> right after (enable_thinking=false path), then the prefill last.
    expect(tailText, "glm tailText opens the assistant turn thinking-OFF with the prefill last").toBe(
      `<|user|>\n${USER}<|assistant|>\n</think>${PREFILL}`,
    );

    // Structural cross-checks (independent of the literal above):
    expect(tailText.endsWith(`</think>${PREFILL}`), "thinking-OFF </think> then the prefill seeds the turn").toBe(true);
    expect(tailText.split("<|assistant|>\n")[1], "nothing after the assistant-open but </think> + prefill").toBe(
      `</think>${PREFILL}`,
    );
    // No ChatML / Llama-3 markers leak into the GLM frame.
    expect(systemText.includes("<|im_start|>"), "no chatml marker in glm").toBe(false);
    expect(tailText.includes("<|im_start|>"), "no chatml marker in glm tail").toBe(false);
    expect(systemText.includes("<|begin_of_text|>"), "no llama3 BOS in glm").toBe(false);
    expect(tailText.includes("<|start_header_id|>"), "no llama3 header in glm").toBe(false);
  });

  it("glm-think is glm's THINKING-ON twin: byte-identical system turn, but the assistant turn is left OPEN (no hardcoded </think>)", () => {
    const glm = renderPrompt(TASK, SYS, PREFILL, "glm");
    const glmThink = renderPrompt(TASK, SYS, PREFILL, "glm-think");

    // The system turn is BYTE-IDENTICAL to plain glm (same [gMASK]<sop> bos + <|system|> role frame).
    expect(glmThink.systemText, "glm-think systemText is identical to glm's").toBe(glm.systemText);

    // The tail: the SAME user turn, but the assistant turn opens straight into the prefill — no </think>
    // skip. When a caller wants reasoning, `prefill` becomes the family's thinkOpen ("<think>\n"), threaded
    // in by the decode loop exactly like qwen3/chatml — this render never bakes `<think>` in itself (a
    // per-run prefill choice, not a static template fact).
    expect(glmThink.tailText, "glm-think tailText opens the assistant turn with the prefill last, no </think> skip").toBe(
      `<|user|>\n${USER}<|assistant|>\n${PREFILL}`,
    );
    expect(glmThink.tailText.includes("</think>"), "glm-think never hardcodes </think> (unlike plain glm)").toBe(
      false,
    );
    expect(glmThink.tailText, "glm-think differs from glm ONLY by the missing </think>").not.toBe(glm.tailText);

    // Everything else (turnTerminator, toolCallFrame) is IDENTICAL to glm; only thinkOpen diverges.
    expect(CHAT_TEMPLATES["glm-think"].turnTerminator).toBe(CHAT_TEMPLATES.glm.turnTerminator);
    expect(CHAT_TEMPLATES["glm-think"].toolCallFrame).toBe(CHAT_TEMPLATES.glm.toolCallFrame);
    expect(CHAT_TEMPLATES.glm.thinkOpen, "glm (thinking-OFF) has no reasoning opener").toBeUndefined();
    expect(CHAT_TEMPLATES["glm-think"].thinkOpen, "glm-think (thinking-ON) has the enable_thinking prefill").toBe(
      "<think>\n",
    );
  });

  it("nemotron frames the VERIFIED (NVIDIA-Nemotron-3-Nano-4B-Q8_0) system/user/assistant turns identically to chatml, but closes </think> via a special token", () => {
    const chatml = renderPrompt(TASK, SYS, PREFILL, "chatml");
    const { systemText, tailText } = renderPrompt(TASK, SYS, PREFILL, "nemotron");

    // Byte-identical to chatml (verified against the GGUF's embedded chat_template — see the `nemotron`
    // FamilyDef comment). Nemotron is not a distinct string frame; it diverges only in the think-close
    // mechanism below.
    expect(systemText, "nemotron systemText is byte-identical to chatml's").toBe(chatml.systemText);
    expect(tailText, "nemotron tailText is byte-identical to chatml's").toBe(chatml.tailText);

    // The special-token close mechanism — the ONE real divergence from chatml. `<think>`/`</think>` are
    // SPECIAL control tokens (ids 12/13) in nemotron_h's vocab, not ordinary text, so the close must resolve
    // via `thinkCloseSpecialToken` rather than the text-tokenize fallback.
    expect(CHAT_TEMPLATES.nemotron.thinkOpen).toBe("<think>\n");
    expect(CHAT_TEMPLATES.nemotron.thinkCloseSpecialToken).toBe(13);
    expect(CHAT_TEMPLATES.chatml.thinkCloseSpecialToken, "chatml has no special think-close token").toBeUndefined();
  });

  it("deepseek frames the DeepSeek-Coder ### Instruction:/### Response: turns with the <｜begin▁of▁sentence｜> bos (xLAM-1b-fc-r)", () => {
    const { systemText, tailText } = renderPrompt(TASK, SYS, PREFILL, "deepseek");

    // The system turn (split point): the DeepSeek bos `<｜begin▁of▁sentence｜>` (a single in-vocab special id)
    // then the system content. No closer — DeepSeek's turn boundary is the `### Instruction:` header (the tail).
    expect(systemText, "deepseek systemText is the bos + system content").toBe(`<｜begin▁of▁sentence｜>${SYS}`);
    // The tail: the instruction header + user turn, then the response OPENED (`### Response:`) with the prefill
    // last — exactly where the model continues. (Its real frame; the GGUF arch `llama` would mis-frame to llama3.)
    expect(tailText, "deepseek tailText opens the response with the prefill last").toBe(
      `### Instruction:\n${USER}\n### Response:\n${PREFILL}`,
    );

    // Structural cross-checks (independent of the literal above):
    expect(tailText.endsWith(`### Response:\n${PREFILL}`), "the response opens with the prefill last").toBe(true);
    // No ChatML / Llama-3 / GLM markers leak into the DeepSeek frame (the shatter-to-bytes bug if they did).
    expect(systemText.includes("<|im_start|>"), "no chatml marker in deepseek").toBe(false);
    expect(systemText.includes("<|begin_of_text|>"), "no llama3 BOS in deepseek").toBe(false);
    expect(tailText.includes("<|start_header_id|>"), "no llama3 header in deepseek").toBe(false);
    expect(systemText.includes("[gMASK]"), "no glm marker in deepseek").toBe(false);
  });

  it("the registry holds a holistic FamilyDef (render + turnTerminator + toolCallFrame) for every family", () => {
    for (const family of [
      "llama3",
      "chatml",
      "glm",
      "glm-think",
      "deepseek",
      "nemotron",
    ] satisfies ChatTemplateFamily[]) {
      const def = CHAT_TEMPLATES[family];
      expect(typeof def.render, `${family} renderer present`).toBe("function");
      expect(def, `${family} has a turnTerminator field`).toHaveProperty("turnTerminator");
      expect(typeof def.toolCallFrame.decide, `${family} tool-call frame present`).toBe("function");
    }
  });

  it("renders an undefined system prompt as the literal 'undefined' (matches buildMessages → string)", () => {
    // buildMessages always fills the system slot (defaulting to buildSystemPrompt), so renderPrompt never
    // sees an undefined content for a real call. But the renderer is total over `sys: string | undefined`;
    // when the resolved content is undefined it stringifies in the template (documents the boundary).
    const { systemText } = CHAT_TEMPLATES.chatml.render(undefined, USER, PREFILL);
    expect(systemText).toBe(`<|im_start|>system\nundefined<|im_end|>\n`);
  });
});

// A minimal structural stand-in for the LlamaModel fields detectChatTemplate reads (fileInfo.metadata).
// detectChatTemplate only touches `metadata.tokenizer.chat_template` + `metadata.general.architecture`.
function fakeModel(meta: { chat_template?: string; architecture?: string }): Parameters<typeof detectChatTemplate>[0] {
  return {
    fileInfo: {
      metadata: {
        ...(meta.architecture === undefined ? {} : { general: { architecture: meta.architecture } }),
        tokenizer: meta.chat_template === undefined ? {} : { chat_template: meta.chat_template },
      },
    },
  } as unknown as Parameters<typeof detectChatTemplate>[0];
}

describe("detectChatTemplate: auto-detect family from GGUF metadata", () => {
  it("picks chatml when the embedded template contains <|im_start|> (the robust signal)", () => {
    // A Qwen2.5-style template string. Even if the arch said llama (SmolLM2's case), the template wins.
    expect(detectChatTemplate(fakeModel({ chat_template: "{% for m in messages %}<|im_start|>{{ m.role }}\n" }))).toBe(
      "chatml",
    );
    // SmolLM2 corner: llama architecture but a ChatML template ⇒ chatml (template precedence).
    expect(detectChatTemplate(fakeModel({ chat_template: "<|im_start|>system\n", architecture: "llama" }))).toBe(
      "chatml",
    );
  });

  it("picks llama3 when the template contains <|start_header_id|>", () => {
    expect(detectChatTemplate(fakeModel({ chat_template: "<|start_header_id|>system<|end_header_id|>\n\n" }))).toBe(
      "llama3",
    );
  });

  it("picks glm from the [gMASK]+<|assistant|> template signal (GLM-4.x has no ChatML/Llama-3 markers)", () => {
    // A GLM-4.x-style template string: the [gMASK]<sop> bos prefix + GLM control tokens, no im_start /
    // start_header_id. The GLM-4.7-Flash bug was this template falling through to the llama3 default.
    expect(
      detectChatTemplate(
        fakeModel({
          chat_template: "[gMASK]<sop>{% for m in messages %}<|{{ m.role }}|>\n{{ m.content }}<|assistant|>\n",
        }),
      ),
    ).toBe("glm");
  });

  it("picks glm from the architecture (deepseek2 ⇒ GLM-4-MoE, glm/chatglm ⇒ ChatGLM) — pins the GLM-4.7-Flash fix", () => {
    // GLM-4-MoE (GLM-4.7-Flash) ships as the `deepseek2` arch in GGUF; before the glm family this fell
    // through to the llama3 default and mis-framed the prompt (garbled output). These three pin the fix.
    expect(detectChatTemplate(fakeModel({ architecture: "deepseek2" }))).toBe("glm");
    expect(detectChatTemplate(fakeModel({ architecture: "glm" }))).toBe("glm");
    expect(detectChatTemplate(fakeModel({ architecture: "glm4" }))).toBe("glm");
    expect(detectChatTemplate(fakeModel({ architecture: "chatglm" }))).toBe("glm");
  });

  it("falls back to architecture when no template is embedded (qwen* ⇒ chatml, llama* ⇒ llama3)", () => {
    expect(detectChatTemplate(fakeModel({ architecture: "qwen2" }))).toBe("chatml");
    expect(detectChatTemplate(fakeModel({ architecture: "qwen3" }))).toBe("chatml");
    expect(detectChatTemplate(fakeModel({ architecture: "llama" }))).toBe("llama3");
  });

  it("picks nemotron from the architecture (nemotron_h) — pins the mis-detection fix (previously fell through to the llama3 guess)", () => {
    expect(detectChatTemplate(fakeModel({ architecture: "nemotron_h" }))).toBe("nemotron");
  });
});

// glm-think is a DELIBERATE exception to "every family is auto-detectable": thinking-on/off for GLM is a
// per-run choice, not a GGUF property, so there is no metadata signal that could distinguish it from plain
// "glm" — detectChatTemplate always resolves a GLM GGUF to the thinking-OFF twin, by design.
describe("detectChatTemplate: glm-think is intentionally NEVER auto-detected (roster-driven only)", () => {
  it('every GLM detection signal (template or architecture) resolves to plain "glm", never "glm-think"', () => {
    const templateWitness = fakeModel({
      chat_template: "[gMASK]<sop>{% for m in messages %}<|{{ m.role }}|>\n{{ m.content }}<|assistant|>\n",
    });
    const archWitnesses = ["deepseek2", "glm", "glm4", "chatglm"].map((architecture) => fakeModel({ architecture }));
    for (const model of [templateWitness, ...archWitnesses]) {
      expect(detectChatTemplate(model)).toBe("glm");
    }
  });

  it("glm-think IS a real, distinct, selectable family — reachable via the explicit chatTemplate override, just not detection", () => {
    // Proves glm-think isn't dead/unreachable code: its render is MEANINGFULLY DIFFERENT from glm's (no
    // hardcoded </think>) and it carries its own thinkOpen, so a caller CAN select it explicitly (the
    // `chatTemplate` override on `llamaCppGenerator` / `renderPrompt`'s 4th argument).
    const glm = renderPrompt(TASK, SYS, PREFILL, "glm");
    const glmThink = renderPrompt(TASK, SYS, PREFILL, "glm-think");
    expect(glmThink.tailText).not.toBe(glm.tailText);
    expect(CHAT_TEMPLATES["glm-think"].thinkOpen).toBeDefined();
    expect(CHAT_TEMPLATES.glm.thinkOpen).toBeUndefined();
  });
});

// The UNRECOGNIZED-ARCH terminal fallback. detectChatTemplate still returns "llama3" so an unknown GGUF
// keeps today's behavior, but it must WARN — this guess silently mis-frames any non-Llama-3 arch (exactly
// how GLM-4.7-Flash's deepseek2 broke before the glm family). The warn makes the next mismatch LOUD.
describe("detectChatTemplate: the unknown-arch fallback warns (no silent-wrong-default)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns AND returns llama3 when no signal resolves (empty metadata)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(detectChatTemplate(fakeModel({})), "still returns llama3 (keeps today's behavior)").toBe("llama3");
    expect(warn, "the unrecognized fallback is LOUD, not silent").toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0], "the warning names the fallback + the mis-frame risk").toContain(
      'Falling back to "llama3" as a GUESS',
    );
  });

  it("warns when the arch is recognized-as-text but unknown to us (e.g. gemma, mistral)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // gemma/mistral have real frames we don't render yet; we still guess llama3, but LOUD now (this was a
    // silent-wrong-default before — the assertion that gemma "correctly" maps to llama3 was the bug).
    expect(detectChatTemplate(fakeModel({ architecture: "gemma" }))).toBe("llama3");
    expect(detectChatTemplate(fakeModel({ architecture: "mistral" }))).toBe("llama3");
    expect(warn, "each unrecognized arch warns").toHaveBeenCalledTimes(2);
  });

  it("does NOT warn when a family is legitimately detected (template or known arch)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Template signals.
    detectChatTemplate(fakeModel({ chat_template: "<|im_start|>system\n" })); // chatml
    detectChatTemplate(fakeModel({ chat_template: "<|start_header_id|>system" })); // llama3
    detectChatTemplate(fakeModel({ chat_template: "[gMASK]<sop>...<|assistant|>\n" })); // glm
    // Known archs (incl. llama3, which is LEGITIMATELY detected — not the unknown fallback).
    detectChatTemplate(fakeModel({ architecture: "qwen2" })); // chatml
    detectChatTemplate(fakeModel({ architecture: "llama" })); // llama3 — detected, not guessed
    detectChatTemplate(fakeModel({ architecture: "deepseek2" })); // glm
    detectChatTemplate(fakeModel({ architecture: "nemotron_h" })); // nemotron
    expect(warn, "a real detection (including legit llama3) is silent").not.toHaveBeenCalled();
  });
});

// CONVENTION GATE: the ChatTemplateFamily union, the CHAT_TEMPLATES registry, and detectChatTemplate's
// reachable branches must stay in lockstep. This is convention-only in the source (a comment on the union),
// so pin it: every family that has a renderer must be REACHABLE from detection, and vice-versa — otherwise
// a family is dead (unselectable) or detection points at a missing renderer (the GLM-4.7-Flash class of bug).
//
// EXCEPTION: a ROSTER-ONLY family (currently just `"glm-think"`) is legitimately UNREACHABLE from detection —
// its selection is a PER-RUN choice, not a GGUF property (see the `glm` FamilyDef comment + the "glm-think is
// intentionally NEVER auto-detected" describe block above). The split below keeps the "no dead family"
// guarantee for the auto-detectable subset while pinning the roster-only exception explicitly, so a family
// added to the union but forgotten in BOTH buckets fails loudly rather than silently passing.
describe("chat-template coupling: union ⇔ CHAT_TEMPLATES renderer ⇔ detectChatTemplate branch", () => {
  // Every ChatTemplateFamily member, listed exhaustively. `satisfies` makes adding a union member without
  // updating this list a COMPILE error — so the coverage check below can never silently miss a new family.
  const ALL_FAMILIES = [
    "llama3",
    "chatml",
    "glm",
    "glm-think",
    "deepseek",
    "nemotron",
  ] satisfies ChatTemplateFamily[];

  // ROSTER-ONLY: deliberately excluded from detectChatTemplate reachability (see the block comment above).
  const ROSTER_ONLY_FAMILIES = ["glm-think"] satisfies ChatTemplateFamily[];
  type AutoDetectable = Exclude<ChatTemplateFamily, (typeof ROSTER_ONLY_FAMILIES)[number]>;

  // Every OTHER family, listed exhaustively as the auto-detectable subset (`satisfies` catches a member that
  // isn't actually excluded via ROSTER_ONLY_FAMILIES).
  const AUTO_DETECTABLE_FAMILIES = ["llama3", "chatml", "glm", "deepseek", "nemotron"] satisfies AutoDetectable[];

  // A metadata fixture that detectChatTemplate resolves to each AUTO-DETECTABLE family (the reachability
  // witness). deepseek's GGUF arch is `llama` (would mis-resolve to llama3), so its witness is the TEMPLATE
  // signal `### Instruction:` — exactly why the deepseek case must precede the `llama` arch fallback in
  // detectChatTemplate. `Record<AutoDetectable, …>` makes forgetting a witness a COMPILE error.
  const DETECTION_WITNESS: Record<AutoDetectable, Parameters<typeof fakeModel>[0]> = {
    llama3: { architecture: "llama" },
    chatml: { architecture: "qwen2" },
    glm: { architecture: "deepseek2" },
    deepseek: { chat_template: "### Instruction:\n" },
    nemotron: { architecture: "nemotron_h" },
  };

  it("every union member has a FamilyDef in CHAT_TEMPLATES", () => {
    for (const family of ALL_FAMILIES) {
      expect(typeof CHAT_TEMPLATES[family].render, `${family} must have a renderer`).toBe("function");
    }
    // And the registry holds no EXTRA keys beyond the union (Record already enforces the type; this pins
    // the runtime key set so a stray renderer without a union member is caught too).
    expect(Object.keys(CHAT_TEMPLATES).toSorted(byName)).toEqual([...ALL_FAMILIES].toSorted(byName));
  });

  it("every AUTO-DETECTABLE union member is REACHABLE from detectChatTemplate (no dead/unselectable family)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const family of AUTO_DETECTABLE_FAMILIES) {
      expect(detectChatTemplate(fakeModel(DETECTION_WITNESS[family])), `${family} must be reachable`).toBe(family);
    }
    // None of the witnesses hit the unknown-arch fallback (they're all real detections).
    expect(warn, "every witness is a real detection, not the warned fallback").not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("the auto-detectable + roster-only buckets EXACTLY partition the union (no family forgotten in both)", () => {
    expect([...AUTO_DETECTABLE_FAMILIES, ...ROSTER_ONLY_FAMILIES].toSorted(byName)).toEqual(
      [...ALL_FAMILIES].toSorted(byName),
    );
    // Roster-only families still have a real, selectable FamilyDef (dead code would be a renderer that
    // throws or a stub — neither is the case, per the "glm-think IS a real, distinct, selectable family" test).
    for (const family of ROSTER_ONLY_FAMILIES) {
      expect(typeof CHAT_TEMPLATES[family].render, `${family} still has a real renderer`).toBe("function");
    }
  });
});
