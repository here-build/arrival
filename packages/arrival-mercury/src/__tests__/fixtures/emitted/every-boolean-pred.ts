import { every, odd } from "./stage0.mts";
function OracleMain() {
    return every(odd, [1, 3, 5]);
}
export { __oracleResult };
const __oracleResult = OracleMain();
