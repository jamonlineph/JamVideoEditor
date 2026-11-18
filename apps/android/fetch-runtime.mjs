#!/usr/bin/env node
// Collects the native programs the editor runs inside the Android app: Node.js (the engine),
// FFmpeg and ffprobe (decoding, encoding, analysis) and eSpeak NG (text to speech), with every
// shared library they load. They come from Termux's package repository, which builds them for
// Android's own C library (bionic), for each processor the app supports.
//
//   node apps/android/fetch-runtime.mjs <stage-dir> [--abi arm64-v8a,x86_64]
//
// Android installs only files named lib*.so from an APK's lib/<abi>/ folder, and only those may be
// executed by an app. So each program and library is packaged as lib_<its name>.so, and
// assets/runtime/<abi>.json records the real names. At startup the app recreates those names as
// symlinks (runtime/lib, runtime/bin) and points LD_LIBRARY_PATH at them. Nothing is patched.
//
// Needs: ar, tar (with xz), readelf. Network: packages.termux.dev.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const REPO = process.env.TERMUX_REPO ?? "https://packages.termux.dev/apt/termux-main";
const ABIS = { "arm64-v8a": "aarch64", x86_64: "x86_64" };
/** Packages to install, and the programs from them that the engine runs. */
const ROOTS = ["nodejs-lts", "ffmpeg", "espeak"];
const PROGRAMS = { node: "node", ffmpeg: "ffmpeg", ffprobe: "ffprobe", "espeak-ng": "espeak-ng" };
/** Libraries every Android device has (the NDK's stable system libraries): never bundled. */
const SYSTEM_LIBS = new Set([
  "libc.so", "libm.so", "libdl.so", "liblog.so", "libandroid.so", "libz.so", "libmediandk.so", "libEGL.so", "libGLESv1_CM.so", "libGLESv2.so",
  "libGLESv3.so", "libvulkan.so", "libOpenSLES.so", "libOpenMAXAL.so", "libaaudio.so", "libamidi.so", "libjnigraphics.so", "libnativewindow.so",
  "libcamera2ndk.so", "libsync.so", "libbinder_ndk.so", "libneuralnetworks.so", "libstdc++.so", "libicu.so",
]);
const PREFIX = "data/data/com.termux/files/usr";

const args = process.argv.slice(2);
const stage = path.resolve(args.find((a) => !a.startsWith("--")) ?? "apps/android/build/stage");
const abiArg = args.includes("--abi") ? args[args.indexOf("--abi") + 1] : Object.keys(ABIS).join(",");
const abis = abiArg.split(",").filter((a) => a in ABIS);
const cache = path.join(stage, "..", "termux-cache");
fs.mkdirSync(cache, { recursive: true });

const sh = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });

async function download(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      fs.writeFileSync(file + ".part", Buffer.from(await res.arrayBuffer()));
      fs.renameSync(file + ".part", file);
      return file;
    } catch (e) {
      if (attempt >= 4) throw new Error(`Could not download ${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
}

/** The repository's package list for one architecture: name -> { depends, filename, version }. */
async function packageIndex(arch) {
  const base = `${REPO}/dists/stable/main/binary-${arch}/Packages`;
  let text;
  for (const [suffix, decode] of [["", (b) => b], [".gz", (b) => zlib.gunzipSync(b)], [".xz", (b, f) => sh("xz", ["-dc", f], { encoding: "buffer" })]]) {
    const file = path.join(cache, `Packages-${arch}${suffix}`);
    try {
      await download(base + suffix, file);
      text = decode(fs.readFileSync(file), file).toString("utf8");
      break;
    } catch (e) {
      fs.rmSync(file, { force: true });
      console.warn(`  (${base + suffix}: ${e.message})`);
    }
  }
  if (!text) throw new Error(`No package index for ${arch} at ${base}`);
  const index = new Map();
  for (const stanza of text.split(/\n\n+/)) {
    const field = (name) => new RegExp(`^${name}: (.*)$`, "m").exec(stanza)?.[1]?.trim();
    const name = field("Package");
    if (!name) continue;
    const deps = [field("Depends"), field("Pre-Depends")].filter(Boolean).join(", ");
    index.set(name, {
      name,
      version: field("Version"),
      filename: field("Filename"),
      // "a (>= 1), b | c" -> [["a"], ["b", "c"]]
      depends: deps ? deps.split(",").map((alt) => alt.split("|").map((d) => d.trim().split(/\s/)[0]).filter(Boolean)) : [],
    });
    for (const p of (field("Provides") ?? "").split(",").map((s) => s.trim().split(/\s/)[0]).filter(Boolean)) if (!index.has(p)) index.set(p, index.get(name));
  }
  return index;
}

function closure(index, roots) {
  const want = new Map();
  const visit = (name) => {
    const pkg = index.get(name);
    if (!pkg) throw new Error(`Package ${name} is not in the repository`);
    if (want.has(pkg.name)) return;
    want.set(pkg.name, pkg);
    for (const alts of pkg.depends) {
      const pick = alts.find((a) => index.has(a));
      if (pick) visit(pick);
      else console.warn(`  ${pkg.name} depends on ${alts.join(" | ")}, which is not in the repository; skipped`);
    }
  };
  roots.forEach(visit);
  return [...want.values()];
}

/** Shared libraries an ELF file asks for. */
function needed(file) {
  const out = sh("readelf", ["-d", "-W", file]);
  return [...out.matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g)].map((m) => m[1]);
}

const pool = async (items, limit, worker) => {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
};

let espeakData = null;
for (const abi of abis) {
  const arch = ABIS[abi];
  console.log(`== ${abi} (${arch})`);
  const index = await packageIndex(arch);
  const pkgs = closure(index, ROOTS);
  console.log(`  ${pkgs.length} packages: ${pkgs.map((p) => p.name).join(" ")}`);
  for (const r of ROOTS) console.log(`  ${r} ${index.get(r).version}`);

  // Unpack every package into one prefix.
  const root = path.join(cache, `root-${arch}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  await pool(pkgs, 8, async (p) => {
    const deb = path.join(cache, path.basename(p.filename));
    await download(`${REPO}/${p.filename}`, deb);
  });
  for (const p of pkgs) {
    const deb = path.join(cache, path.basename(p.filename));
    const tmp = fs.mkdtempSync(path.join(cache, "deb-"));
    sh("ar", ["x", deb], { cwd: tmp });
    const data = fs.readdirSync(tmp).find((f) => f.startsWith("data.tar"));
    if (data) sh("tar", ["-xf", path.join(tmp, data), "-C", root]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const usr = path.join(root, PREFIX);
  const libDir = path.join(usr, "lib");

  // Library name (as programs ask for it) -> the real file.
  const libFiles = new Map();
  for (const name of fs.readdirSync(libDir)) {
    const full = path.join(libDir, name);
    if (!/\.so(\.|$)/.test(name)) continue;
    let real;
    try {
      real = fs.realpathSync(full);
    } catch {
      continue;
    }
    if (fs.statSync(real).isFile()) libFiles.set(name, real);
  }

  const out = path.join(stage, "lib", abi);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const manifest = { abi, versions: Object.fromEntries(ROOTS.map((r) => [r, index.get(r).version])), bin: {}, lib: {} };
  const packaged = new Map(); // real file -> packaged name
  const pack = (real, packagedName) => {
    if (!packaged.has(real)) {
      fs.copyFileSync(real, path.join(out, packagedName));
      fs.chmodSync(path.join(out, packagedName), 0o755);
      packaged.set(real, packagedName);
    }
    return packaged.get(real);
  };

  const queue = [];
  for (const [name, program] of Object.entries(PROGRAMS)) {
    const file = path.join(usr, "bin", program);
    if (!fs.existsSync(file)) throw new Error(`${program} is not in the ${abi} packages`);
    manifest.bin[name] = pack(fs.realpathSync(file), `lib_bin_${name}.so`);
    queue.push(fs.realpathSync(file));
  }
  const seen = new Set();
  const missing = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const lib of needed(file)) {
      const real = libFiles.get(lib);
      if (real) {
        manifest.lib[lib] = pack(real, packaged.get(real) ?? `lib_${lib.replace(/[^A-Za-z0-9._+-]/g, "_")}.so`);
        queue.push(real);
      } else if (!SYSTEM_LIBS.has(lib)) missing.add(lib);
    }
  }
  if (missing.size) throw new Error(`${abi}: these libraries are neither in the packages nor on Android: ${[...missing].join(", ")}`);

  const assets = path.join(stage, "assets", "runtime");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, `${abi}.json`), JSON.stringify(manifest, null, 2) + "\n");
  const bytes = fs.readdirSync(out).reduce((n, f) => n + fs.statSync(path.join(out, f)).size, 0);
  console.log(`  ${Object.keys(manifest.bin).length} programs and ${packaged.size - Object.keys(manifest.bin).length} libraries, ${(bytes / 1e6).toFixed(1)} MB`);

  // eSpeak's voice data is the same for every processor: ship it once, as assets.
  if (!espeakData) {
    const data = path.join(usr, "share", "espeak-ng-data");
    if (fs.existsSync(data)) {
      espeakData = path.join(stage, "assets", "app", "espeak-ng-data");
      fs.rmSync(espeakData, { recursive: true, force: true });
      fs.cpSync(data, espeakData, { recursive: true, dereference: true });
    } else console.warn("  no espeak-ng-data in the espeak package; text to speech will not work");
  }
}
console.log(`runtime staged in ${stage}`);
