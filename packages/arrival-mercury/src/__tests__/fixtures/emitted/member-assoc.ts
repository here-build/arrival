import { assoc, list, member } from "./stage0.mts";
function OracleMain() {
    return list(member(2, list(1, 2, 3)), assoc(2, list(list(1, "a"), list(2, "b"))));
}
export { __oracleResult };
const __oracleResult = OracleMain();
