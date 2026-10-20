import type { Meta, StoryObj } from "@storybook/react-vite";

import { LiveExecutionGraph, liveArgTypes, liveDecorator } from "./__fixtures__/live.js";

/**
 * One story per control construct the graph knows, each a real program over program-defined
 * designated functions (`ask`, `fetch`, `pred`, `boom` — see `__fixtures__/live.tsx`).
 * `mode: potential` is the plan; `mode: actual` runs it with the held/released host port.
 */
const meta: Meta<typeof LiveExecutionGraph> = {
  title: "Execution Graph/Constructs",
  component: LiveExecutionGraph,
  args: { mode: "actual", tick: 350 },
  argTypes: liveArgTypes,
  decorators: [liveDecorator],
};
export default meta;

type Story = StoryObj<typeof LiveExecutionGraph>;

export const LetStarChain: Story = {
  args: {
    program: `(let* ((topic (ask "pick a topic"))
       (outline (ask (string-append "outline: " topic)))
       (sources (fetch outline)))
  (ask (string-append outline sources)))`,
  },
};

export const MapLambda: Story = {
  args: {
    program: `(let* ((plan (ask "plan"))
       (steps (map (lambda (s) (ask s)) (list plan "research" "draft" "edit"))))
  (fetch (car steps)))`,
  },
};

/** The callback's verdict is the par's control egress. */
export const Filter: Story = { args: { program: `(filter (lambda (s) (pred s)) (list "yes" "no" "yes" "no"))` } };

/** A host whose callback schedule is undeclared: `×?`. */
export const ForEach: Story = { args: { program: `(for-each (lambda (s) (ask s)) (list "a" "b" "c"))` } };

/** An accumulator callback: sequential iterations. */
export const Reduce: Story = {
  args: { program: `(reduce (lambda (x acc) (ask (string-append acc x))) "" (list "r1" "r2" "r3"))` },
};

export const NamedLetTailLoop: Story = {
  args: {
    program: `(let loop ((i 0) (acc "draft"))
  (if (< i 3)
      (loop (+ i 1) (ask acc))
      (fetch acc)))`,
  },
};

export const Do: Story = {
  args: {
    program: `(do ((i 0 (+ i 1)) (acc "" (ask acc)))
    ((= i 2) (fetch acc))
  (fetch (number->string i)))`,
  },
};

/** arrival has no `set!`: the body raises to leave the loop, a guard catches it. */
export const While: Story = {
  args: {
    program: `(guard (e (#t (fetch "left the loop")))
  (while (pred "yes")
    (ask "body")
    (raise 'stop)))`,
  },
};

export const IfWhenUnless: Story = {
  args: {
    program: `(if (pred "yes") (ask "then") (fetch "else"))
(when (pred "no") (ask "when"))
(unless (pred "no") (fetch "unless"))`,
  },
};

/** The second clause's test runs inside its arm and says no: tested, not taken. */
export const Cond: Story = {
  args: {
    program: `(cond ((pred "no") (ask "one"))
      ((pred "no") (ask "two"))
      (else (ask "three")))`,
  },
};

export const Case: Story = {
  args: {
    program: `(case (string-length (ask "k"))
  ((2) (fetch "two"))
  (else (fetch "other")))`,
  },
};

/** `or` short-circuits on its second operand; `and` runs both. */
export const AndOr: Story = { args: { program: `(or (pred "no") (and (pred "yes") (ask "both")))` } };

/** `boom` raises: the rest of the body is skipped and the on-raise arm runs. */
export const GuardRaise: Story = {
  args: {
    program: `(guard (e (#t (fetch "recovered")))
  (ask "first")
  (boom "x")
  (ask "never"))`,
  },
};

const SUMMARIZE = `(define (summarize u) (ask (fetch u)))
(summarize "https://a.example/post")
(summarize "https://b.example/notes")`;

/** A program function inlined at each call site. */
export const CallFrame: Story = { args: { program: SUMMARIZE } };

/** The same function, itself designated: the call frame leads with its symbol. */
export const DesignatedFunction: Story = { args: { program: SUMMARIZE, symbols: ["summarize"] } };

/** All recursive calls in tail position: a loop. */
export const TailRecursion: Story = {
  args: {
    program: `(define (walk n acc)
  (if (= n 0) (fetch acc) (walk (- n 1) (ask acc))))
(walk 3 "s")`,
  },
};

/** A non-tail recursive call: a collapsed stub, expanded per depth while running. */
export const NonTailRecursion: Story = {
  args: {
    program: `(define (deep n)
  (if (= n 0) (fetch "bottom") (string-append (ask "level") (deep (- n 1)))))
(deep 3)`,
  },
};

/** Recursion through a fan callback: the call's depth tabs and, at each depth, the fan's own
 *  track picker — pick a track to descend through it. */
export const TreeWalk: Story = {
  args: {
    program: `(define (walk t) (if (pair? t) (map walk t) (ask t)))
(walk (list "a" (list "b" (list "c" "d")) "e"))`,
  },
};

export const Apply: Story = {
  args: {
    program: `(define (helper x) (ask x))
(string-append (apply ask (list "x")) (apply helper (list "y")))`,
  },
};

/** A bare designated callback: one template step carrying the par's state. */
export const BareCallback: Story = { args: { program: `(map ask (list "a" "b" "c"))` } };

/** `->` is a macro the plan does not expand: its steps take the host's state (LIMIT, noted). */
export const ThreadingMacro: Story = { args: { program: `(-> "q" (ask) (string-append "!") (fetch))` } };

/** A track whose only designated calls are hosted (inside an untracked macro): each track takes
 *  its state from the callback's own run, and settles with it. */
export const MacroInCallback: Story = {
  args: { program: `(map (lambda (s) (-> s (ask) (fetch))) (list "a" "b"))` },
};

// ── v3: fold, blocks, contours ─────────────────────────────────────────────────────────────

/** Eight tracks finishing out of order: the template is painted once, from the track the picker
 *  follows (first running, else first failed, else the last done). Click a tab to pin it; "live"
 *  follows the run again. */
export const FanRandomOrder: Story = {
  args: { program: `(map (lambda (s) (ask s)) (list "a" "b" "c" "d" "e" "f" "g" "h"))`, tick: 400 },
};

/** A loop with a counter: the loop return is the area's own contour, the counter `(+ n 1)` an
 *  expression pill on it; the iteration tabs follow the latest. */
export const LoopWithCounter: Story = {
  args: {
    program: `(let loop ((n 0) (draft "draft"))
  (if (< n 4)
      (loop (+ n 1) (ask draft))
      (fetch draft)))`,
  },
};

/** A computation over named work between steps: one `string-append` block fed by both answers,
 *  its value shown once they settle. */
export const LetStarTransform: Story = {
  args: {
    program: `(let* ((title (ask "title"))
       (body (ask "body")))
  (fetch (string-append title " — " body)))`,
  },
};

/** A projection chain: the line from the fan to `fetch` carries the path pill
 *  `[car].url` instead of a block. */
export const ProjectionChain: Story = {
  args: {
    program: `(let ((results (map (lambda (s) {:url (ask s)}) (list "a" "b" "c"))))
  (fetch (:url (car results))))`,
  },
};
