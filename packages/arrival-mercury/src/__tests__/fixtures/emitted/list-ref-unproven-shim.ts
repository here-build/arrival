import { listRef } from "./stage0.mts";
function OracleMain() {
    const numOrList = flag => flag !== false ? 7 : [10, 20, 30];
    return listRef(numOrList(false), 1);
}
export { __oracleResult };
const __oracleResult = OracleMain();
