// Package one verified embedded build for every host; never rebuild per client.
import {
  rmSync,
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
const manifest = JSON.parse(readFileSync("dist/call-branding.json", "utf8"));
if (manifest.version !== 1 || !manifest.brands.includes("letro"))
  throw new Error("Missing Letro brand contract");
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const version = process.env.LETRO_CALL_VERSION || "0.25.0-letro.4";
if (!/^\d+\.\d+\.\d+-letro\.\d+$/.test(version))
  throw new Error("Expected a Letro prerelease version");
rmSync("letro-packages", { recursive: true, force: true });
mkdirSync("letro-packages", { recursive: true });
cpSync("embedded/ios", "letro-packages/swift", { recursive: true });
cpSync("dist", "letro-packages/swift/Sources/dist", { recursive: true });
const swift =
  "letro-packages/swift/Sources/EmbeddedElementCall/EmbeddedElementCall.swift";
writeFileSync(
  swift,
  readFileSync(swift, "utf8").replace('"0.0.0"', JSON.stringify(version)),
);
cpSync("embedded/web", "letro-packages/web", { recursive: true });
cpSync("dist", "letro-packages/web/dist", { recursive: true });
const pkg = JSON.parse(readFileSync("embedded/web/package.json", "utf8"));
pkg.name = "@p-num/element-call-embedded";
pkg.version = version;
pkg.repository.url = "git+https://github.com/p-num/element-call.git";
writeFileSync(
  "letro-packages/web/package.json",
  JSON.stringify(pkg, null, 2) + "\n",
);
execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", ".."], {
  cwd: "letro-packages/web",
  stdio: "inherit",
});
cpSync("dist", "letro-packages/android/assets/element-call", {
  recursive: true,
});
writeFileSync(
  "letro-packages/source.json",
  JSON.stringify({ revision, version, contract: manifest }, null, 2),
);

execFileSync("zip", ["-qr", "../../element-call-assets.zip", "element-call"], {
  cwd: "letro-packages/android/assets",
});
