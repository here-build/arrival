export default function OracleMain() {
    return ([["guilty", 42]].find(([__k]) => __k === "guilty") ?? [undefined, []])[1] !== false ? "GUILTY" : "INNOCENT";
}
