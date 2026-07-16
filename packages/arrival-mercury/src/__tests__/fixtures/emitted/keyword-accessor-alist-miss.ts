function OracleMain() {
    return ([["guilty", 42]].find(([__k]) => __k === "missing") ?? [undefined, []])[1];
}
export { __oracleResult };
const __oracleResult = OracleMain();
