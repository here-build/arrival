import { le } from "./stage0.mts";
function OracleMain() {
    const numOrList = flag => flag !== false ? 7 : [8, 9];
    return le(numOrList(true), 7);
}
export { __oracleResult };
const __oracleResult = OracleMain();
