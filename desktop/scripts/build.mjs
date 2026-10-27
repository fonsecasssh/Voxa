// Bundles the main process and preloads with esbuild into dist/, and copies the static files.
//
// VOXA_APP_URL sets which site the packaged app opens (e.g. https://voxa.app);
// without it the app opens http://localhost:3001.

import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  external: ["electron"],
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

const appUrl = process.env.VOXA_APP_URL || "";
if (appUrl && !/^https?:\/\//.test(appUrl)) throw new Error(`VOXA_APP_URL must start with http(s)://, got "${appUrl}"`);
writeFileSync(path.join(dist, "app-config.json"), JSON.stringify({ appUrl }, null, 2));
console.log(`desktop built -> dist/ (site: ${appUrl || "http://localhost:3001 (padrão)"})`);
