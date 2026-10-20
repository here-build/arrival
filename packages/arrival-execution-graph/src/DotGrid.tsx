/**
 * DotGrid — the canvas's dot lattice, three stacked levels that fade in with zoom.
 *
 * Each level is an SVG pattern of one 1×1 rect centred on a lattice point; the tile is
 * `step × scale`, so the spacing follows the zoom and a dot stays one CSS pixel. A major dot is
 * no separate style: a 64-unit point is also a 16 and a 4 point, so the level opacities stack.
 * The grid's (0,0) is the graph's, given in the grid's own box (`origin`), so the dots ride with
 * the content. Colour is `--eg-dot`; `--eg-dot-strength` scales every level's opacity.
 */
import { useId } from "react";

import type { Point } from "./types.js";

// Ported from here.build's CanvasViewport grid (saas/studio/studio/src/canvas/CanvasViewport.ts).
/** Lattice steps in canvas units, finest first. */
export const DOT_STEPS = [4, 16, 64] as const;
/** Scale above which the 4-unit level starts to show. */
export const DOT_THRESHOLD_4 = 1;
/** Scale above which the 16-unit level starts to show. */
export const DOT_THRESHOLD_16 = 0.5;
/** Opacity gained per unit of scale past a threshold. */
export const DOT_FADE_RATE = 0.25;
/** No level is ever more opaque than this. */
export const DOT_MAX_OPACITY = 0.6;
/** The 64-unit level never fades below this, however far out. */
export const DOT_MIN_OPACITY = 0.2;

const round2 = (x: number): number => Math.round(x * 100) / 100;
const fadeIn = (s: number, threshold: number): number =>
  s > threshold ? round2(Math.min(DOT_MAX_OPACITY, (s - threshold) * DOT_FADE_RATE)) : 0;

/** The opacities of the 4-, 16- and 64-unit levels at scale `s`. */
export function dotOpacities(s: number): [number, number, number] {
  return [
    fadeIn(s, DOT_THRESHOLD_4),
    fadeIn(s, DOT_THRESHOLD_16),
    round2(Math.max(DOT_MIN_OPACITY, DOT_MAX_OPACITY * Math.min(1, s))),
  ];
}

/** `x` on the device pixel grid, so a dot at a whole-pixel lattice point is one crisp pixel at
 *  any device ratio (centred on the point at 2×, its right-down pixel at 1×). */
const snap = (x: number, dpr: number): number => Math.round(x * dpr) / dpr;

export function DotGrid({ scale, origin }: { scale: number; origin: Point }) {
  const id = useId().replaceAll(/[^\w-]/g, "");
  const opacities = dotOpacities(scale);
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return (
    <svg className="eg-dot-grid" aria-hidden>
      <defs>
        {DOT_STEPS.map((step) => (
          <pattern
            key={step}
            id={`${id}-${step}`}
            patternUnits="userSpaceOnUse"
            x={snap(origin.x - 0.5, dpr)}
            y={snap(origin.y - 0.5, dpr)}
            width={step * scale}
            height={step * scale}
          >
            <rect width={1} height={1} />
          </pattern>
        ))}
      </defs>
      {DOT_STEPS.map((step, i) =>
        opacities[i] === 0 ? null : (
          <rect
            key={step}
            width="100%"
            height="100%"
            fill={`url(#${id}-${step})`}
            style={{ opacity: `calc(${opacities[i]} * var(--eg-dot-strength))` }}
          />
        ),
      )}
    </svg>
  );
}
