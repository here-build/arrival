import { list, maxBy } from "./stage0.mts";
export default function OracleMain() {
    return list(maxBy(x => x, [3, 1, 4, 1, 5, 9, 2, 6]), maxBy(([head]) => head, [[5, "first"], [5, "second"], [2, "third"]]));
}
