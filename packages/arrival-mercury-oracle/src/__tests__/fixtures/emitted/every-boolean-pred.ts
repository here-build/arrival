import { every, odd } from "./stage0.mts";
export default function OracleMain() {
    return every(odd, [1, 3, 5]);
}
