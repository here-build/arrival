export default function OracleMain() {
    const pick = (a, b) => {
        const __or = a;
        return __or !== false ? __or : b;
    };
    return pick(0, 9);
}
