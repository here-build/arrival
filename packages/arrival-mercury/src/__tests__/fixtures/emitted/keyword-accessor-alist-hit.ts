function OracleMain() {
    return ([["guilty", 42], ["other", 7]].find(([__k]) => __k === "guilty") ?? [undefined, []])[1];
}
export { __oracleResult };
const __oracleResult = OracleMain();
