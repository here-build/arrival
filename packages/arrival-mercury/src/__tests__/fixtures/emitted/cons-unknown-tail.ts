import { cons } from "./stage0.mts";
function OracleMain() {
    const numOrList = flag => flag !== false ? 7 : [8, 9];
    return cons("key", numOrList(true));
}
export { __oracleResult };
const __oracleResult = OracleMain();
