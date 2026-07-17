import { lt } from "./stage0.mts";
function OracleMain() {
    const numOrList = flag => flag !== false ? 7 : [8, 9];
    return lt(numOrList(true), 10);
}
export { __oracleResult };
const __oracleResult = OracleMain();
