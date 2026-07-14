import { eqP, stringAppend } from "./stage0.mts";
function OracleMain() {
    return eqP("ab", stringAppend("a", "b"));
}
export { __oracleResult };
const __oracleResult = OracleMain();
