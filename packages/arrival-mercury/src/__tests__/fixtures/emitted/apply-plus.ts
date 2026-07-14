import { list } from "./stage0.mts";
function OracleMain() {
    return list(1, 2, 3).reduce((__acc, __item) => __acc + __item, 0);
}
export { __oracleResult };
const __oracleResult = OracleMain();
