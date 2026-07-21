import { any, gt } from "./stage0.mts";
export default function OracleMain() {
    return any(x => gt(x, 1) ? x : false, [0, 2]);
}
