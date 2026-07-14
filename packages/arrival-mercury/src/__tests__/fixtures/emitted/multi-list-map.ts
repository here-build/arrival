import { plus, list } from "./stage0.mts";
function OracleMain() {
    return list(1, 2).map((__item, __i) => plus(__item, list(10, 20)[__i]));
}
export { __oracleResult };
const __oracleResult = OracleMain();
