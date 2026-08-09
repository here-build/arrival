export default function OracleMain() {
    const e = [["guilty", true]];
    return (e.find(([__k]) => __k === "guilty") ?? [undefined, []])[1];
}
