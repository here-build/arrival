import { equalP } from "./stage0.mts";
export default function OracleMain() {
    return equalP([1, [2, 3]], [1, [2, 3]]);
}
