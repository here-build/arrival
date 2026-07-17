import { list } from "./stage0.mts";
export default function OracleMain() {
    return list([1, 2, 3, 4, 5][1], [1, 2, 3, 4, 5][2], [1, 2, 3, 4, 5].slice(2), [[10, 20, 30], [40, 50]][0][1]);
}
