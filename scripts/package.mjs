// Builds installable apps with electron-builder.
//
//   npm run dist -- --mac --arm64      macOS .dmg + .zip (must run on a Mac for the .dmg)
//   npm run dist -- --linux --x64      Linux / Chromebook .deb + .AppImage
//   npm run dist -- --win --x64        Windows installer
//
// The app is staged in release/app as a few self-contained files (no node_modules): the desktop
// window, the compositor window and the engine, each bundled with esbuild. The engine runs on the
// Node built into Electron, so users install nothing else. Helper binaries (FFmpeg, ffprobe, the
// Apple Vision helper) are picked up from build/vendor/<arch> when present (scripts/fetch-tools.mjs).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleEngine } from "./bundle-engine.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.join(root, "release", "app");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

execFileSync(process.execPath, [path.join(root, "scripts", "build.mjs")], { cwd: root, stdio: "inherit" });

fs.rmSync(stage, { recursive: true, force: true });
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(path.join(stage, to)), { recursive: true });
  fs.copyFileSync(path.join(root, from), path.join(stage, to));
};
for (const f of ["main.cjs", "app.js", "index.html", "styles.css"]) copy(`apps/desktop/dist/${f}`, `desktop/${f}`);
for (const f of ["main.cjs", "page.js", "page.html"]) copy(`packages/render-host/dist/${f}`, `render-host/${f}`);
// The same UI for a browser, served by the engine in `serve --web` (the openedits-web command on Linux).
for (const f of ["index.html", "app.js", "styles.css", "manifest.webmanifest", "icon-192.png", "icon-512.png", "render-host.html", "render-host.js"]) copy(`apps/desktop/dist/web/${f}`, `web/${f}`);

// The engine (HTTP + MCP server, CLI) as one ES module.
await bundleEngine(path.join(stage, "engine", "cli.mjs"));

// One binary, two roles: the editor window, or (with a flag) the hidden compositor the engine drives.
fs.writeFileSync(
  path.join(stage, "entry.cjs"),
  `// The packaged app's entry point. The engine starts this same binary with --openedits-render-host
// to get the hidden compositor window that renders previews and exports.
if (process.argv.includes("--openedits-render-host")) require("./render-host/main.cjs");
else require("./desktop/main.cjs");
`,
);
fs.writeFileSync(
  path.join(stage, "package.json"),
  JSON.stringify(
    {
      name: "openedits-studio",
      productName: "OpenEdits Studio",
      version: pkg.version,
      description: pkg.description,
      author: { name: "OpenEdits", email: "noreply@openedits.app" },
      homepage: "https://github.com/jamonlineph/JamVideoEditor",
      license: "UNLICENSED",
      main: "entry.cjs",
      // Linux desktops match the running window to its launcher entry by this name.
      desktopName: "openedits-studio.desktop",
    },
    null,
    2,
  ) + "\n",
);

const args = process.argv.slice(2);
const cli = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "electron-builder.cmd" : "electron-builder");
execFileSync(cli, ["--config", "electron-builder.yml", "--publish", "never", ...args], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
