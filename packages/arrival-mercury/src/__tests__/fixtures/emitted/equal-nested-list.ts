import { equalP, list } from "./stage0.mts";
function OracleMain() {
    return equalP(list(1, list(2, 3)), list(1, list(2, 3)));
}
export { __oracleResult };
const __oracleResult = OracleMain();
