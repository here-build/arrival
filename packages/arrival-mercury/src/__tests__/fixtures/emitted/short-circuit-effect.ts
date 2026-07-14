function OracleMain() {
    const n = 0;
    (() => {
        const __or = true;
        return __or !== false ? __or : (() => {
            throw new Error("prohibited-dynamics/set!: `set!` is prohibited by design: arrival-scheme is immutable and no-dynamics \u2014 mutation and re-entrant control are incompatible with non-exponential provenance (a mutable cell's lineage becomes writers \u00D7 readers; a re-entrant continuation makes the provenance DAG unbounded). This is a permanent language law (constitution \u00A72.2), not a backlog gap \u2014 restructure with immutable bindings and plain data flow.");
            return "x";
        })();
    })();
    return n;
}
export { __oracleResult };
const __oracleResult = OracleMain();
