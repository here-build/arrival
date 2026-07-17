import { list, map } from "./stage0.mts";
export default function OracleMain() {
    return map(list, ...[[1, 2], [3, 4]]);
}
