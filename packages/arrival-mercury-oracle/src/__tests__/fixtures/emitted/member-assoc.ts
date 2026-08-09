import { assoc, list, member } from "./stage0.mts";
export default function OracleMain() {
    return list(member(2, [1, 2, 3]), assoc(2, [[1, "a"], [2, "b"]]));
}
