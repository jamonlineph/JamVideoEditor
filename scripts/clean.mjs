// Removes build output (works on Windows too, unlike shell globs).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const empty = (dir) => {
  if (!fs.existsSync(dir)) return;
  // Keep the folder itself (it may be a symlink to a .nosync directory), remove what is inside.
  for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
};
for (const pkg of fs.readdirSync(path.join(root, "packages"))) {
  empty(path.join(root, "packages", pkg, "dist"));
  fs.rmSync(path.join(root, "packages", pkg, "tsconfig.tsbuildinfo"), { force: true });
}
empty(path.join(root, "apps", "desktop", "dist"));
console.log("Build output removed");
