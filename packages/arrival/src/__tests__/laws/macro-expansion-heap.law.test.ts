/**
 * LAW — macro expansion charges the run's heap meter (constant-ctx Wave 3;
 * the CONSTANT_CTX audit §2.1/§4).
 *
 * The syntax-rules engine RUNS LIVE: template instantiation materializes its whole
 * output in synchronous walks with no trampoline TICK — exactly the chokepoint case
 * heap-budget.ts documents. Pre-Wave-3 every engine mint carried CONSTANT_CTX, so a
 * sandboxed (metered) run could expand an arbitrarily large template for free — the
 * audit's "expansion heap-budget bypass". Post-plumb, every cell the matcher/expander
 * constructs goes through the engine's mint door (eval/syntax-rules.ts `consCell`/
 * `listFromArray`/`concatPairLoose`), charging `MacroInvokeContext.runCtx`'s meter.
 *
 * Two law rows, plus the span-contract guard:
 *   (a) BUDGET DOOR — a tight-budget run expanding a large template dies on
 *       "heap budget exceeded"; the SAME template as a direct literal (no macro)
 *       passes the same budget (a quoted literal is read once, construction-free —
 *       the trip is the EXPANSION's charge, nothing else's).
 *   (b) RUN IDENTITY — expansion output pairs carry the RUN's ctx (observable as the
 *       run's own heapMeter reference on the value), not the run-neutral constant.
 *   (+) carrySpan is UNDISTURBED — the metered expansion output is still fully
 *       located (the tap-membership contract `span-totality.law.test.ts` pins in
 *       depth; asserted here jointly with the charge so a future edit can't trade
 *       one law for the other).
 */
import { describe, expect, it } from "vitest";
import { mintFrame } from "../../env/AmbientRuntime.js";
import { execOverFrame as exec, execStateOverFrame as execState } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../env/inference-env.js";
import { APair } from "../../values/primitives/APair.js";

// A macro whose single expansion mints a large quoted skeleton: n top-level cells,
// each a fresh 4-element form — every Pair here is expansion-constructed (quoted
// TEMPLATE data, no call-site fragments to share by reference).
const bigTemplate = (n: number) => `(quote (${Array.from({ length: n }, (_, i) => `(cell${i} a b c)`).join(" ")}))`;

const run = (code: string, heapBudget?: number) =>
  exec(code, { env: mintFrame(inferenceEnv, "macro-heap-law"), heapBudget });

describe("law (a) — the budget door: a tight-budget run expanding a large template dies on it", () => {
  it("expanding a 200-form quoted template trips a 100-cell budget", async () => {
    await expect(
      run(
        `(define-syntax big (syntax-rules () ((_) ${bigTemplate(200)})))
         (big)`,
        100,
      ),
    ).rejects.toThrow(/heap budget exceeded/);
  });

  it("control: the SAME datum as a direct literal passes the same 100-cell budget", async () => {
    // A quoted literal evaluates by reference to the read-time datum — construction-
    // free (the same control heap-budget-sequence-ops.test.ts uses). So the trip
    // above is the expansion's own charge, not the program's size.
    await expect(run(`(begin ${bigTemplate(200)} #t)`, 100)).resolves.toBeDefined();
  });

  it("ellipsis repetition charges too: a repetition-heavy expansion trips the door", async () => {
    // Each use-site argument drives a template repetition minting fresh cells; the
    // matcher's accumulation cells charge as well (HygieneScope.ctx).
    const args = Array.from({ length: 100 }, (_, i) => String(i)).join(" ");
    await expect(
      run(
        `(define-syntax listify (syntax-rules () ((_ x ...) (quote ((x x x) ...)))))
         (listify ${args})`,
        100,
      ),
    ).rejects.toThrow(/heap budget exceeded/);
  });

  it("no false positive: a small expansion stays under a generous budget", async () => {
    await expect(
      run(
        `(define-syntax pairify (syntax-rules () ((_ x) (quote (x x)))))
         (pairify 7)`,
        10_000,
      ),
    ).resolves.toBeDefined();
  });
});

describe("law (b) — expansion output pairs stay fully located", () => {
  it("expansion-constructed pairs stay fully located", async () => {
    const env = mintFrame(inferenceEnv, "macro-heap-law-identity");
    const { values } = await execState(
      `(define-syntax wrap (syntax-rules () ((_ x) (quote (alpha beta (gamma x))))))
       (wrap 42)`,
      { env, heapBudget: 1_000_000 },
    );
    const v = values[values.length - 1];
    expect(v).toBeInstanceOf(APair);
    const head = v as APair<any, any>;

    // carrySpan contract undisturbed: every reachable expansion Pair is located
    // (the template's span — the deep pin lives in span-totality.law.test.ts).
    const spanless: APair<any, any>[] = [];
    const seen = new Set<unknown>();
    const walk = (x: unknown): void => {
      if (!(x instanceof APair) || seen.has(x)) return;
      seen.add(x);
      if (x.getLocation() === undefined) spanless.push(x);
      walk(x.car);
      walk(x.cdr);
    };
    walk(head);
    expect(spanless).toEqual([]);
  });
});
