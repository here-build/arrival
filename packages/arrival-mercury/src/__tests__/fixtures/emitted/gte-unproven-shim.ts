import { ge } from "./stage0.mts";
function OracleMain() {
    const numOrList = flag => flag !== false ? 7 : [8, 9];
    return ge(numOrList(true), 8);
}
export { __oracleResult };
const __oracleResult = OracleMain();
