import { zeroP } from "./stage0.mts";
export default function OracleMain() {
    const numOrList = flag => flag !== false ? 0 : [8, 9];
    return zeroP(numOrList(true));
}
