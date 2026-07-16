import { lt, le, gt, ge, equalP, evenP, every, length_, list, listRef, map, max_, nullP, zeroP } from "./stage0.mts";
function OracleMain() {
    throw new Error("unsupported-form/require: `(require \"metric.scm\")` \u2014 module loading is not compiled in this slice (the loader/FRAME wave owns import planning).");
    const examples = (() => {
        throw new Error("unsupported-form/require: `(require \"examples.json\")` \u2014 module loading is not compiled in this slice (the loader/FRAME wave owns import planning).");
    })();
    const runAnalyze = (() => {
        throw new Error("unsupported-form/require: `(require \"analyze.prompt\")` \u2014 module loading is not compiled in this slice (the loader/FRAME wave owns import planning).");
    })();
    const runDecide = (() => {
        throw new Error("unsupported-form/require: `(require \"decide.prompt\")` \u2014 module loading is not compiled in this slice (the loader/FRAME wave owns import planning).");
    })();
    const runReflect = (() => {
        throw new Error("unsupported-form/require: `(require \"reflect.prompt\")` \u2014 module loading is not compiled in this slice (the loader/FRAME wave owns import planning).");
    })();
    const paretoset = examples;
    const trace = (analyze, decide, { input, id, expected }) => {
        const message = input;
        const analysis = runAnalyze([analyze, message], { instruction: analyze, message: message });
        const label = runDecide([decide, message, analysis], { instruction: decide, message: message, analysis: analysis });
        return { id: id, input: message, analysis: analysis, prediction: label, expected: expected };
    };
    const evaluate = (analyze, decide, set) => set.map(it => trace(analyze, decide, it));
    const recScore = rec => {
        throw new Error("unsupported-form/unresolved-identifier: `metric` is not lexically bound and is not a registry symbol.");
    };
    const scoresOf = recs => recs.map(recScore);
    const failuresOf = recs => recs.filter(__x => (rec => zeroP(recScore(rec)))(__x) !== false);
    const candidate = (analyze, decide, via, recs) => ({ analyze: analyze, decide: decide, via: via, recs: recs });
    const instrOf = ({ analyze, decide }, stage) => equalP(stage, "analyze") ? analyze : decide;
    const assess = (analyze, decide, via) => candidate(analyze, decide, via, evaluate(analyze, decide, paretoset));
    const scores = ({ recs }) => scoresOf(recs);
    const total = c => scores(c).reduce((__acc, score) => __acc + score, 0);
    const dominates = (a, b) => every(ge, scores(a), scores(b)) && (() => {
        throw new Error("unsupported-form/unresolved-identifier: `some` is not lexically bound and is not a registry symbol.");
    })();
    const frontier = pool => pool.filter(__x => (c => !(() => {
        throw new Error("unsupported-form/unresolved-identifier: `some` is not lexically bound and is not a registry symbol.");
    })())(__x) !== false);
    const stageFor = iter => evenP(iter) ? "analyze" : "decide";
    const propose = (c, batch, iter) => {
        const stage = stageFor(iter);
        const current = instrOf(c, stage);
        const fails = failuresOf(batch);
        return fails.length === 0 ? false : (() => {
            const improved = runReflect([stage, current, fails], { stage: stage, instruction: current, failures: fails });
            return equalP(stage, "analyze") ? [improved, c["decide"], "analyze"] : [c["analyze"], improved, "decide"];
        })();
    };
    const complementary = ({ via }, { via: via_2 }) => equalP(via, "analyze") && equalP(via_2, "decide") || equalP(via, "decide") && equalP(via_2, "analyze");
    const merge = ({ via, analyze, decide }, { decide: decide_2, analyze: analyze_2 }) => equalP(via, "analyze") ? assess(analyze, decide_2, "merge") : assess(analyze_2, decide, "merge");
    const findMerge = pool => {
        const outer = as => nullP(as) ? false : (() => {
            let bs = pool;
            /*[ts-base/self-tail-loop] named let `inner` → while*/
            while (true) {
                if (nullP(bs)) {
                    return outer(as.slice(1));
                }
                else {
                    if (complementary(as[0], bs[0])) {
                        return [as[0], bs[0]];
                    }
                    else {
                        bs = bs.slice(1);
                        continue;
                    }
                }
            }
        })();
        return outer(pool);
    };
    const columnMaxima = pool => map(list, ...pool.map(scores)).map(it => max_(...it));
    const paretoWeight = (c, maxima) => scores(c).map((score, __i) => ((s, m) => ge(s, m) ? 1 : 0)(score, maxima[__i])).reduce((__acc, __item) => __acc + __item, 0);
    const rngNext = state => (state * 16807 % 2147483647 + 2147483647) % 2147483647;
    const rngInt = (state, n) => (state % max_(n, 1) + max_(n, 1)) % max_(n, 1);
    const weightedIndex = (weights, target) => {
        let ws = weights;
        let i = 0;
        let acc = 0;
        /*[ts-base/self-tail-loop] named let `walk` → while*/
        while (true) {
            if (ws.slice(1).length === 0 || lt(target, acc + ws[0])) {
                return i;
            }
            else {
                [ws, i, acc] = [ws.slice(1), i + 1, acc + ws[0]];
                continue;
            }
        }
    };
    const select = (pool, state) => {
        const maxima = columnMaxima(pool);
        const weights = pool.map(it => paretoWeight(it, maxima));
        const target = rngInt(state, weights.reduce((__acc, weight) => __acc + weight, 0));
        return list(listRef(pool, weightedIndex(weights, target)), rngNext(state));
    };
    const isPicked = (ex, batch) => {
        throw new Error("unsupported-form/unresolved-identifier: `some` is not lexically bound and is not a registry symbol.");
    };
    const sampleBatch = (set, k, state) => {
        let picked = [];
        let tries = 3 * k;
        let s = state;
        /*[ts-base/self-tail-loop] named let `loop` → while*/
        while (true) {
            if (zeroP(tries) || ge(length_(picked), k) || ge(length_(picked), length_(set))) {
                return [picked, s];
            }
            else {
                {
                    const ex = listRef(set, rngInt(s, length_(set)));
                    [picked, tries, s] = [isPicked(ex, picked) ? picked : [ex, ...picked], tries - 1, rngNext(s)];
                    continue;
                }
            }
        }
    };
    const proposalBatchScore = (analyze, decide, batch) => scoresOf(evaluate(analyze, decide, batch)).reduce((__acc, __item) => __acc + __item, 0);
    const parentBatchScore = batch => scoresOf(batch).reduce((__acc, __item) => __acc + __item, 0);
    const BATCH = 4;
    const MERGEEVERY = 3;
    const evolve = (pool, budget, rng, iter) => le(budget, 0) ? pool : (() => {
        const pair = (() => {
            const __and = zeroP((iter % MERGEEVERY + MERGEEVERY) % MERGEEVERY);
            return __and === false ? __and : findMerge(frontier(pool));
        })();
        return pair !== false ? evolve(frontier([merge(pair[0], (() => {
                throw new Error("unsupported-form/unresolved-identifier: `cadr` is not lexically bound and is not a registry symbol.");
            })()), ...pool]), budget - length_(paretoset), rngNext(rng), iter + 1) : (() => {
            const sel = select(pool, rng);
            const parent = sel[0];
            const rng1 = (() => {
                throw new Error("unsupported-form/unresolved-identifier: `cadr` is not lexically bound and is not a registry symbol.");
            })();
            const smp = sampleBatch(parent["recs"], BATCH, rng1);
            const batch = smp[0];
            const rng2 = (() => {
                throw new Error("unsupported-form/unresolved-identifier: `cadr` is not lexically bound and is not a registry symbol.");
            })();
            const prop = propose(parent, batch, iter);
            return prop === false ? evolve(pool, budget - BATCH, rng2, iter + 1) : (() => {
                const pAnalyze = prop[0];
                const pDecide = (() => {
                    throw new Error("unsupported-form/unresolved-identifier: `cadr` is not lexically bound and is not a registry symbol.");
                })();
                const pVia = (() => {
                    throw new Error("unsupported-form/unresolved-identifier: `caddr` is not lexically bound and is not a registry symbol.");
                })();
                const propScore = proposalBatchScore(pAnalyze, pDecide, batch);
                const parentScore = parentBatchScore(batch);
                return gt(propScore, parentScore) ? evolve(frontier([assess(pAnalyze, pDecide, pVia), ...pool]), budget - BATCH - length_(paretoset), rng2, iter + 1) : evolve(pool, budget - BATCH, rng2, iter + 1);
            })();
        })();
    })();
    const BUDGET = 100;
    const SEEDRNG = 4;
    const gepa = () => {
        const seed = assess((() => {
            throw new Error("unsupported-form/require: `(require \"analyze-seed.txt\")` \u2014 module loading is not compiled in this slice (the loader/FRAME wave owns import planning).");
        })(), (() => {
            throw new Error("unsupported-form/require: `(require \"decide-seed.txt\")` \u2014 module loading is not compiled in this slice (the loader/FRAME wave owns import planning).");
        })(), "seed");
        const final = evolve([seed], BUDGET - length_(paretoset), SEEDRNG, 0);
        throw new Error("unsupported-form/unresolved-identifier: `max-by` is not lexically bound and is not a registry symbol.");
    };
    return gepa();
}
export { __oracleResult };
const __oracleResult = OracleMain();
