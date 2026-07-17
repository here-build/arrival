import { length_ } from "./stage0.mts";
export default function OracleMain() {
    const listOrString = flag => flag !== false ? [1, 2, 3] : "abc";
    return length_(listOrString(true));
}
