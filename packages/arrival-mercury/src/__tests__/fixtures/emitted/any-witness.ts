import { gt, any } from "./stage0.mts";
function OracleMain() {
    return any(x => gt(x, 1) ? x : false, [0, 2]);
}
export { __oracleResult };
const __oracleResult = OracleMain();
