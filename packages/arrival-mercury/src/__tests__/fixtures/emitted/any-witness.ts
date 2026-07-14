import { gt, any, list } from "./stage0.mts";
function OracleMain() {
    return any(x => gt(x, 1) ? x : false, list(0, 2));
}
export { __oracleResult };
const __oracleResult = OracleMain();
