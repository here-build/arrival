import { lt, equalP, inferScalar } from "./stage0.mts";
async function OracleMain() {
    const raw = await inferScalar("fast", "read devices");
    const devices = (() => {
        throw new Error("unsupported-form/unresolved-identifier: `json/parse` is not lexically bound and is not a registry symbol.");
    })();
    const privileged = devices.filter(__x => (({ port, owner }) => lt(port, 1024) && !equalP(owner, "root"))(__x) !== false);
    const offenders = privileged.map(({ name }) => name);
    return offenders;
}
export { __oracleResult };
const __oracleResult = await OracleMain();
