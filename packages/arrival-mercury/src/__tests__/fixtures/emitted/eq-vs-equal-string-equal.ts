import { equalP, stringAppend } from "./stage0.mts";
function OracleMain() {
    return equalP("ab", stringAppend("a", "b"));
}
export { __oracleResult };
const __oracleResult = OracleMain();
