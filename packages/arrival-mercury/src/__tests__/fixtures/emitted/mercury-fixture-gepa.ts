import { ge, append_, every, list, zeroP } from "./stage0.mts";
function OracleMain() {
    throw new Error("unsupported-form/require: `(require \"metric.scm\")` \u2014 module loading is not compiled in this slice (the loader/FRAME wave owns import planning).");
    const examples = (() => {
        throw new Error("unsupported-form/require: `(require \"examples.json\")` \u2014 module loading is not compiled in this slice (the loader/FRAME wave owns import planning).");
    })();
    const runPredict = (() => {
        throw new Error("unsupported-form/require: `(require \"predict.prompt\")` \u2014 module loading is not compiled in this slice (the loader/FRAME wave owns import planning).");
    })();
    const runImprove = (() => {
        throw new Error("unsupported-form/require: `(require \"improve.prompt\")` \u2014 module loading is not compiled in this slice (the loader/FRAME wave owns import planning).");
    })();
    const ask = (instruction, input) => runPredict([instruction, input], { instruction: instruction, input: input });
    const reflect = (instruction, failures) => runImprove([instruction, failures], { instruction: instruction, failures: failures });
    const evaluate = instruction => examples.map(ex => {
        throw new Error("unsupported-form/unresolved-identifier: `metric` is not lexically bound and is not a registry symbol.");
    });
    const assess = instruction => ({ instruction: instruction, scores: evaluate(instruction) });
    const failing = ({ scores }) => examples.map((example, __i) => list(example, scores[__i])).filter(__x => (pair => zeroP((() => {
        throw new Error("unsupported-form/unresolved-identifier: `cadr` is not lexically bound and is not a registry symbol.");
    })()))(__x) !== false).map(([head]) => head);
    const mutate = candidate => assess(reflect(candidate["instruction"], failing(candidate)));
    const dominates = ({ scores }, { scores: scores_2 }) => every(ge, scores, scores_2) && (() => {
        throw new Error("unsupported-form/unresolved-identifier: `some` is not lexically bound and is not a registry symbol.");
    })();
    const frontier = pool => pool.filter(__x => (c => !(() => {
        throw new Error("unsupported-form/unresolved-identifier: `some` is not lexically bound and is not a registry symbol.");
    })())(__x) !== false);
    const iterate = (step, pool, n) => zeroP(n) ? pool : iterate(step, step(pool), n - 1);
    const generation = pool => frontier(append_(pool, pool.map(mutate)));
    const gepa = (seed, rounds) => {
        throw new Error("unsupported-form/unresolved-identifier: `max-by` is not lexically bound and is not a registry symbol.");
    };
    return gepa((() => {
        throw new Error("unsupported-form/require: `(require \"seed.txt\")` \u2014 module loading is not compiled in this slice (the loader/FRAME wave owns import planning).");
    })(), 4);
}
export { __oracleResult };
const __oracleResult = OracleMain();
