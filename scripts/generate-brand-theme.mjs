import { writeFileSync, readFileSync } from "node:fs";
import { generateThemeCSS } from "../src/branding/theme.ts";
const path = new URL("../src/branding/generated.css", import.meta.url);
const css = generateThemeCSS() + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== css)
    throw new Error("Run node scripts/generate-brand-theme.mjs");
} else writeFileSync(path, css);
