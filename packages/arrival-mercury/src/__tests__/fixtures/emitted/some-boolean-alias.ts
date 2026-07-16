import { gt, list, odd, some } from "./stage0.mts";
function OracleMain() {
    return list(some(x => gt(x, 1) ? x : false, [0, 2]), some(odd, [2, 4, 6]));
}
export { __oracleResult };
const __oracleResult = OracleMain();
