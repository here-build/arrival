export default function OracleMain() {
    return ([["guilty", 42]].find(([__k]) => __k === "missing") ?? [undefined, []])[1];
}
