import { describe, expect, it } from "vitest";

import { dotOpacities } from "../DotGrid.js";

describe("dotOpacities", () => {
  it.each([
    // scale, [4, 16, 64]
    [0.2, [0, 0, 0.2]], // far out: only the 64 level, at its floor
    [0.5, [0, 0, 0.3]], // the 16 level's threshold is exclusive
    [1, [0, 0.13, 0.6]], // 64 at its cap; 16 fading in; 4 at its threshold, still off
    [2.9, [0.48, 0.6, 0.6]], // 16 has reached the cap; 4 almost
    [3.4, [0.6, 0.6, 0.6]], // all three capped
    [4, [0.6, 0.6, 0.6]],
  ] as const)("at scale %s", (s, expected) => {
    expect(dotOpacities(s)).toEqual(expected);
  });
});
