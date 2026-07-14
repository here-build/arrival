import { list } from "./stage0.mts";
function OracleMain() {
    return list() !== false ? "a" : "b";
}
export { __oracleResult };
const __oracleResult = OracleMain();
