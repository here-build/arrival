import { lt, inferScalar } from "./stage0.mts";
export default async function OracleMain() {
    const raw = await inferScalar("fast", "read devices");
    const devices = (() => {
        throw new Error("unsupported-form/unresolved-identifier: `json/parse` is not lexically bound and is not a registry symbol.");
    })();
    const privileged = devices.filter(__x => (({ port, owner }) => lt(port, 1024) && !(owner === "root"))(__x) !== false);
    const offenders = privileged.map(({ name }) => name);
    return offenders;
}
