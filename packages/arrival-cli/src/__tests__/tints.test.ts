// tints — the D4 palette (Delta OKLCH emphasis hues → truecolor/nearest-256 ANSI).
import { describe, expect, it } from "vitest";

import { colorMode, paint } from "../tints.js";
import { stripAnsi } from "./ansi-strip.js";

describe("colorMode", () => {
  it("NO_COLOR wins over everything (https://no-color.org)", () => {
    expect(colorMode({ NO_COLOR: "1", COLORTERM: "truecolor" })).toBe("none");
  });

  it("COLORTERM=truecolor|24bit selects the truecolor rung", () => {
    expect(colorMode({ COLORTERM: "truecolor" })).toBe("truecolor");
    expect(colorMode({ COLORTERM: "24bit" })).toBe("truecolor");
  });

  it("no COLORTERM signal falls back to the nearest-256 rung, never bare/uncolored (D4)", () => {
    expect(colorMode({})).toBe("256");
  });

  it("`force` pins the mode regardless of env — the tape-recording / test escape hatch", () => {
    expect(colorMode({ COLORTERM: "truecolor" }, "none")).toBe("none");
  });
});

describe("paint", () => {
  it("mode: none is the identity function", () => {
    expect(paint("hello", "error", "none")).toBe("hello");
  });

  it("wraps with a truecolor SGR open + RESET, stripping back to the original text", () => {
    const painted = paint("hello", "done", "truecolor");
    expect(painted).toMatch(/^\x1b\[38;2;\d+;\d+;\d+mhello\x1b\[0m$/);
    expect(stripAnsi(painted)).toBe("hello");
  });

  it("256 mode uses the nearest-256 SGR form", () => {
    const painted = paint("hello", "done", "256");
    expect(painted).toMatch(/^\x1b\[38;5;\d+mhello\x1b\[0m$/);
    expect(stripAnsi(painted)).toBe("hello");
  });

  it("different tints paint different colors (pending/dim vs error/danger are visually distinct)", () => {
    const pending = paint("x", "pending", "truecolor");
    const error = paint("x", "error", "truecolor");
    expect(pending).not.toBe(error);
  });
});
