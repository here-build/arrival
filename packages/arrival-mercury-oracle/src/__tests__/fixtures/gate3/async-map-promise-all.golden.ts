import { infer } from "./stage0.mts";
export default function OracleMain() {
    return Promise.all(["a", "b"].map(x => infer("fast", x)));
}
