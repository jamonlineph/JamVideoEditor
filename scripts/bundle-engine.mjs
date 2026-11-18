// The engine (HTTP + MCP server, CLI) as one ES module, for the packaged desktop apps and the Android
// app. CommonJS dependencies inside it still call require(), so the bundle gets a real one.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function bundleEngine(outfile) {
  await build({
    entryPoints: [path.join(root, "packages/mcp/src/cli.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    conditions: ["@openedits/source"],
    external: ["electron", "bufferutil", "utf-8-validate"],
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    logLevel: "warning",
  });
}
