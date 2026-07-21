import { list, odd, some } from "./stage0.mts";
export default function OracleMain() {
    return list(some(x => x > 1 ? x : false, [0, 2]), some(odd, [2, 4, 6]));
}
