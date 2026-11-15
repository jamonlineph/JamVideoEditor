// Starts the desktop app with the installed Electron binary (after `npm run build`).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electron = createRequire(path.join(root, "package.json"))("electron");
// Chromium refuses to start as root with its sandbox on (containers, CI).
const flags = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(root, "apps", "desktop"), ...flags, ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
