// Rolldown renames the expressive-code stylesheet (`ec.w36nc.css` → `ec.[hash].css`)
// and leaves the link in the page pointing at the original name.
import fs from "node:fs";
import path from "node:path";

const dist = path.resolve(import.meta.dirname, "../dist");
const assets = path.join(dist, "_astro");
const wanted = new Set();

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.name.endsWith(".html")) continue;
    const html = fs.readFileSync(full, "utf8");
    for (const match of html.matchAll(/\/_astro\/(ec\.[^"]+\.css)/g)) wanted.add(match[1]);
  }
}

walk(dist);
const emitted = fs.readdirSync(assets).filter((name) => /^ec\..+\.css$/.test(name));
if (wanted.size === 0 && emitted.length === 0) process.exit(0);
if (wanted.size !== 1 || emitted.length !== 1) {
  console.error("expressive-code css names diverged", { wanted: [...wanted], emitted });
  process.exit(1);
}
const [from] = emitted;
const [to] = wanted;
if (from === to) process.exit(0);
fs.copyFileSync(path.join(assets, from), path.join(assets, to));
fs.unlinkSync(path.join(assets, from));
