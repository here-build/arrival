import { eqP, stringAppend } from "./stage0.mts";
export default function OracleMain() {
    return eqP("ab", stringAppend("a", "b"));
}
