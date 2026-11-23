// Build the pinned whisper.cpp CLI that ships with the desktop editor. The speech model is
// separate, so users can choose whether to download it from inside Captions.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const revision = "d1be6fde11ac6e0407606b4e42fe72d34add8037"; // whisper.cpp v1.9.5
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const architectures = process.argv.slice(2);
if (!architectures.length) architectures.push(process.arch);
if (architectures.some((arch) => arch !== "arm64" && arch !== "x64")) throw new Error("Use x64 or arm64.");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openedits-whisper-"));
const src = path.join(temp, "source");
const run = (cmd, args, cwd = temp) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
try {
  run("git", ["init", src]);
  run("git", ["fetch", "--depth", "1", "https://github.com/ggml-org/whisper.cpp.git", revision], src);
  run("git", ["checkout", "--detach", "FETCH_HEAD"], src);
  const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: src, encoding: "utf8" }).trim();
  if (actual !== revision) throw new Error("Unexpected whisper.cpp revision.");
  for (const arch of architectures) {
    const build = path.join(temp, arch);
    const win = process.platform === "win32";
    const args = [
      "-S", src, "-B", build, "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF",
      "-DWHISPER_BUILD_EXAMPLES=ON", "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_SERVER=OFF",
      "-DGGML_NATIVE=OFF", "-DGGML_OPENMP=OFF", "-DGGML_METAL=OFF",
    ];
    if (arch === "x64") args.push("-DGGML_AVX=OFF", "-DGGML_AVX2=OFF", "-DGGML_BMI2=OFF", "-DGGML_F16C=OFF", "-DGGML_FMA=OFF");
    if (win) args.push("-A", arch === "x64" ? "x64" : "ARM64", "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded");
    if (process.platform === "darwin") {
      args.push(`-DCMAKE_OSX_ARCHITECTURES=${arch === "x64" ? "x86_64" : "arm64"}`, "-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0");
    }
    if (process.platform === "linux" && arch !== process.arch) {
      if (arch !== "arm64") throw new Error("Cross-building on Linux currently supports arm64 output.");
      args.push("-DCMAKE_SYSTEM_NAME=Linux", "-DCMAKE_SYSTEM_PROCESSOR=aarch64",
        "-DCMAKE_C_COMPILER=aarch64-linux-gnu-gcc", "-DCMAKE_CXX_COMPILER=aarch64-linux-gnu-g++");
    }
    if (process.platform === "linux") args.push("-DCMAKE_EXE_LINKER_FLAGS=-static-libstdc++ -static-libgcc");
    run("cmake", args);
    run("cmake", ["--build", build, "--config", "Release", "--target", "whisper-cli", "--parallel", "2"]);
    const filename = win ? "whisper-cli.exe" : "whisper-cli";
    const binary = path.join(build, "bin", ...(win ? ["Release"] : []), filename);
    const vendor = path.join(root, "build", "vendor", arch);
    fs.mkdirSync(vendor, { recursive: true });
    fs.copyFileSync(binary, path.join(vendor, filename));
    fs.chmodSync(path.join(vendor, filename), 0o755);
    fs.copyFileSync(path.join(src, "LICENSE"), path.join(vendor, "whisper.cpp-LICENSE.txt"));
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
