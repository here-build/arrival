import { length as length_ } from "ramda";
export default function OracleMain() {
    const listOrString = flag => flag !== false ? [1, 2, 3] : "abc";
    return length_(listOrString(true));
}
