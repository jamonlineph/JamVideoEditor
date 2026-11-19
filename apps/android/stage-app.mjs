#!/usr/bin/env node
// Stages the JavaScript half of the Android app as APK assets:
//   assets/app/engine/cli.mjs   the engine (runs on the bundled Node.js)
//   assets/app/web/             the editor UI and the compositor page (run in WebViews)
//
//   node apps/android/stage-app.mjs [stage-dir]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleEngine } from "../../scripts/bundle-engine.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const stage = path.resolve(process.argv[2] ?? path.join(here, "build", "stage"));
const app = path.join(stage, "assets", "app");

execFileSync(process.execPath, [path.join(root, "scripts", "build.mjs")], { cwd: root, stdio: "inherit" });

for (const dir of ["engine", "web"]) fs.rmSync(path.join(app, dir), { recursive: true, force: true });
await bundleEngine(path.join(app, "engine", "cli.mjs"));
fs.rmSync(path.join(app, "engine", "cli.mjs.map"), { force: true });

// Source maps stay out of the APK.
const web = path.join(root, "apps", "desktop", "dist", "web");
fs.mkdirSync(path.join(app, "web"), { recursive: true });
for (const f of fs.readdirSync(web)) if (!f.endsWith(".map")) fs.cpSync(path.join(web, f), path.join(app, "web", f), { recursive: true });

const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
fs.writeFileSync(path.join(app, "VERSION"), `${version}\n`);
console.log(`app staged in ${app}`);
