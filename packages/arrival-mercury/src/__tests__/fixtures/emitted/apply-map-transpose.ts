import { list, map } from "./stage0.mts";
function OracleMain() {
    return map(list, ...[[1, 2], [3, 4]]);
}
export { __oracleResult };
const __oracleResult = OracleMain();
