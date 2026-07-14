import { every, list, odd } from "./stage0.mts";
function OracleMain() {
    return every(odd, list(1, 3, 5));
}
export { __oracleResult };
const __oracleResult = OracleMain();
