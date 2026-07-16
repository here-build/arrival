import { plus } from "./stage0.mts";
function OracleMain() {
    return [1, 2].map((__item, __i) => plus(__item, [10, 20][__i]));
}
export { __oracleResult };
const __oracleResult = OracleMain();
