import { equalP } from "./stage0.mts";
function OracleMain() {
    return equalP([1, [2, 3]], [1, [2, 3]]);
}
export { __oracleResult };
const __oracleResult = OracleMain();
