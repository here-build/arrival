import { gt } from "./stage0.mts";
function OracleMain() {
    const numOrList = flag => flag !== false ? 7 : [8, 9];
    return gt(numOrList(true), 4);
}
export { __oracleResult };
const __oracleResult = OracleMain();
