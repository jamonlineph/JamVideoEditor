// Builds the TypeScript packages (tsc) and bundles the Electron render host (esbuild).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = path.join(root, "node_modules", ".bin", "tsc");
execFileSync(tsc, ["-b", "packages/core", "packages/renderer", "packages/engine", "packages/mcp"], { cwd: root, stdio: "inherit" });
execFileSync(tsc, ["-p", "packages/render-host"], { cwd: root, stdio: "inherit" });

const host = path.join(root, "packages", "render-host");
const common = { bundle: true, platform: "node", format: "cjs", external: ["electron"], sourcemap: true, logLevel: "warning", conditions: ["@openedits/source"] };
await build({ ...common, entryPoints: [path.join(host, "src/main.ts")], outfile: path.join(host, "dist/main.cjs"), target: "node22" });
await build({ ...common, entryPoints: [path.join(host, "src/page.ts")], outfile: path.join(host, "dist/page.js"), target: "chrome130" });
fs.copyFileSync(path.join(host, "src/page.html"), path.join(host, "dist/page.html"));

// Desktop app: Electron main process + React UI (renderer has Node integration; engine runs in a child process).
const desktop = path.join(root, "apps", "desktop");
const define = { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"), __OPENEDITS_WEB__: "false" };
await build({ ...common, entryPoints: [path.join(desktop, "src/main/main.ts")], outfile: path.join(desktop, "dist/main.cjs"), target: "node22" });
await build({ ...common, define, jsx: "automatic", entryPoints: [path.join(desktop, "src/ui/index.tsx")], outfile: path.join(desktop, "dist/app.js"), target: "chrome130" });
for (const f of ["index.html", "styles.css"]) fs.copyFileSync(path.join(desktop, "src/ui", f), path.join(desktop, "dist", f));

// The same UI for a browser (`openedits serve --web`): Electron and Node modules are swapped for
// small stand-ins that talk to the engine (apps/desktop/src/web).
const web = path.join(desktop, "src/web");
const webOut = path.join(desktop, "dist/web");
await build({
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome120",
  jsx: "automatic",
  sourcemap: true,
  logLevel: "warning",
  conditions: ["@openedits/source"],
  define: { ...define, __OPENEDITS_WEB__: "true" },
  alias: {
    electron: path.join(web, "electron.ts"),
    "node:child_process": path.join(web, "child_process.ts"),
    "node:fs": path.join(web, "fs.ts"),
    "node:path": path.join(web, "path.ts"),
    "node:url": path.join(web, "url.ts"),
  },
  inject: [path.join(web, "globals.ts")],
  entryPoints: [path.join(desktop, "src/ui/index.tsx")],
  outfile: path.join(webOut, "app.js"),
});
fs.copyFileSync(path.join(desktop, "src/ui/styles.css"), path.join(webOut, "styles.css"));
for (const f of ["index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png"]) fs.copyFileSync(path.join(web, f), path.join(webOut, f));

// Apple Vision helper (macOS only): rebuild when the Swift source is newer than the binary.
if (process.platform === "darwin") {
  const src = path.join(root, "packages/engine/native/vision.swift");
  const bin = path.join(root, "packages/engine/bin/openedits-vision");
  const stale = !fs.existsSync(bin) || fs.statSync(bin).mtimeMs < fs.statSync(src).mtimeMs;
  if (stale) {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    try {
      execFileSync("swiftc", ["-O", "-o", bin, src], { stdio: "inherit" });
    } catch {
      console.warn("warning: could not build the Vision helper (install the Xcode command line tools); vision tools will be unavailable");
    }
  }
}
