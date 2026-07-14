import { every, list } from "./stage0.mts";
function OracleMain() {
    return every(x => x, list(1, 2));
}
export { __oracleResult };
const __oracleResult = OracleMain();
