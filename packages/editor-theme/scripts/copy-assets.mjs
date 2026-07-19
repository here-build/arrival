// Copy CSS + font binaries next to the tsc output so dist/fonts.css resolves
// its relative url(./fonts/*.woff2) in consumers' bundlers.
import { cpSync } from "node:fs";
cpSync("src/fonts.css", "dist/fonts.css");
cpSync("src/fonts", "dist/fonts", { recursive: true });
