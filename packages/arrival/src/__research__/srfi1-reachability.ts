import { initBridge } from "../bridge.js";
const WHITELIST = ["take-while","drop-while","span","break","partition","find-tail","last-pair","last","list-tabulate","fold-right","reduce-right","concatenate","append-reverse","delete","length+"];
await initBridge();
const { sandboxedEnv } = await import("../sandbox-env.js");
const live: string[] = [], dead: string[] = [];
for (const n of WHITELIST) {
  const v = sandboxedEnv.get(n, { throwError: false });
  (typeof v === "function" ? live : dead).push(n);
}
console.log("LIVE :", live.join(", "), `(${live.length})`);
console.log("DEAD :", dead.join(", "), `(${dead.length})`);
