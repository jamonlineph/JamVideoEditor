// Downloads the helper programs bundled inside the packaged app into build/vendor/<arch>:
//   ffmpeg   FFmpeg 6.1 static build (ffmpeg-static release, GPL; its license is copied alongside)
//   ffprobe  from the @ffprobe-installer npm package for the platform
//   openedits-vision (macOS only) the Apple Vision helper, compiled from packages/engine/native
//
//   node scripts/fetch-tools.mjs --platform darwin --arch arm64 [--only ffprobe]
//
// Used by the release workflow (.github/workflows/build-apps.yml) before `npm run dist`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const opt = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const platform = opt("platform", process.platform);
const arch = opt("arch", process.arch);
const only = opt("only", null);
const exe = platform === "win32" ? ".exe" : "";
const out = path.join(root, "build", "vendor", arch);
fs.mkdirSync(out, { recursive: true });

const FFMPEG_RELEASE = "b6.1.1";
const FFMPEG_BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_RELEASE}`;

async function download(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchFfmpeg() {
  const name = `ffmpeg-${platform}-${arch}`;
  const binary = zlib.gunzipSync(await download(`${FFMPEG_BASE}/${name}.gz`));
  const file = path.join(out, `ffmpeg${exe}`);
  fs.writeFileSync(file, binary, { mode: 0o755 });
  for (const [suffix, target] of [["LICENSE", "ffmpeg-LICENSE.txt"], ["README", "ffmpeg-README.txt"]]) {
    try {
      fs.writeFileSync(path.join(out, target), await download(`${FFMPEG_BASE}/${platform}-${arch}.${suffix}`));
    } catch {
      /* optional */
    }
  }
  console.log(`ffmpeg  -> ${path.relative(root, file)} (${(binary.length / 1e6).toFixed(1)} MB)`);
}

function fetchFfprobe() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ffprobe-"));
  const pkg = `@ffprobe-installer/${platform}-${arch}`;
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const tarball = execFileSync(npm, ["pack", pkg, "--silent"], { cwd: tmp, encoding: "utf8", shell: process.platform === "win32" }).trim().split("\n").pop();
  execFileSync("tar", ["-xzf", tarball], { cwd: tmp });
  const src = path.join(tmp, "package", `ffprobe${exe}`);
  const file = path.join(out, `ffprobe${exe}`);
  fs.copyFileSync(src, file);
  fs.chmodSync(file, 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`ffprobe -> ${path.relative(root, file)}`);
}

function buildVision() {
  if (platform !== "darwin" || process.platform !== "darwin") return;
  const src = path.join(root, "packages", "engine", "native", "vision.swift");
  const file = path.join(out, "openedits-vision");
  const target = arch === "arm64" ? "arm64-apple-macos12" : "x86_64-apple-macos12";
  execFileSync("swiftc", ["-O", "-target", target, "-o", file, src], { stdio: "inherit" });
  console.log(`vision  -> ${path.relative(root, file)}`);
}

if (!only || only === "ffmpeg") await fetchFfmpeg();
if (!only || only === "ffprobe") fetchFfprobe();
if (!only || only === "vision") buildVision();
