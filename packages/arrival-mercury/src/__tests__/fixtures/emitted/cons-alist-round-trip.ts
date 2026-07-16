function OracleMain() {
    const e = [["guilty", true]];
    return (e.find(([__k]) => __k === "guilty") ?? [undefined, []])[1];
}
export { __oracleResult };
const __oracleResult = OracleMain();
