// Bundles the main process and preloads with esbuild into dist/, and copies the static files.
//
// Which site the app opens: VOXA_APP_URL if set, else "voxaAppUrl" from package.json
// (the production site). `--dev` builds for a local server (http://localhost:3001).

import { build } from "esbuild";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron", "uiohook-napi"],
  sourcemap: true,
  logLevel: "warning",
};

await Promise.all([
  build({ ...common, entryPoints: [path.join(root, "src/main.ts")], outfile: path.join(dist, "main.js") }),
  // Sandboxed preloads can only require("electron"); everything else must be bundled in.
  build({ ...common, entryPoints: [path.join(root, "src/preload.ts")], outfile: path.join(dist, "preload.js") }),
  build({ ...common, entryPoints: [path.join(root, "src/picker-preload.ts")], outfile: path.join(dist, "picker-preload.js") }),
]);

for (const f of ["src/picker.html", "src/offline.html", "assets/icon.png"]) {
  copyFileSync(path.join(root, f), path.join(dist, path.basename(f)));
}

// The global push-to-talk hook is native code: ship the package (and its loader) as files
// next to main.js, with only the prebuilt binaries we use. They stay outside the asar
// archive (see electron-builder.yml) so the .node file can load.
const modules = path.join(path.dirname(root), "node_modules");
const copyDir = (from, to, filter = () => true) => cpSync(from, to, { recursive: true, filter });
copyDir(path.join(modules, "uiohook-napi"), path.join(dist, "node_modules", "uiohook-napi"), (src) => {
  const rel = path.relative(path.join(modules, "uiohook-napi"), src);
  return rel === "" || rel === "package.json" || /^dist([\\/]index\.js)?$/.test(rel) || /^prebuilds([\\/](win32-x64|linux-x64)([\\/]|$)|$)/.test(rel);
});
copyDir(path.join(modules, "node-gyp-build"), path.join(dist, "node_modules", "node-gyp-build"));

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const appUrl = process.argv.includes("--dev") ? "" : process.env.VOXA_APP_URL || pkg.voxaAppUrl || "";
if (appUrl && !/^https?:\/\//.test(appUrl)) throw new Error(`VOXA_APP_URL must start with http(s)://, got "${appUrl}"`);
writeFileSync(path.join(dist, "app-config.json"), JSON.stringify({ appUrl }, null, 2));
console.log(`desktop built -> dist/ (site: ${appUrl || "http://localhost:3001 (padrão)"})`);
