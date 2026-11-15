import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const MEDIA_DIR = path.join(ROOT, ".test-media");

const RECIPES: Record<string, string[]> = {
  "clip_a.mp4": ["-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-c:a", "aac", "-shortest"],
  "clip_b.mp4": ["-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=660:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-c:a", "aac", "-shortest"],
  "music.m4a": ["-f", "lavfi", "-i", "sine=frequency=220:duration=12", "-c:a", "aac"],
  // Frame N encodes N in two flat gray halves: left = 16 + 25*(N mod 8), right = 16 + 25*floor(N/8).
  "counter2.mp4": ["-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=2,format=yuv420p,geq=lum='16+25*if(lt(X\\,W/2)\\,mod(N\\,8)\\,floor(N/8))':cb=128:cr=128", "-f", "lavfi", "-i", "sine=frequency=500:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "4", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"],
  // An orange 120x120 square moving right (x = 80 + 100t px) over a noisy blue background.
  "object.mp4": ["-f", "lavfi", "-i", "color=c=0x3A6B8C:s=640x360:r=30:d=3", "-f", "lavfi", "-i", "color=c=0xF0B020:s=120x120:r=30:d=3", "-filter_complex", "[0]noise=alls=12:allf=t,format=yuv420p[bg];[bg][1]overlay=x='80+t*100':y=120,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast"],
  "photo.png": ["-f", "lavfi", "-i", "testsrc2=size=800x800:rate=1:duration=1", "-frames:v", "1"],
};

/** Generate (once) small synthetic media files with FFmpeg. */
export function testMedia(): Record<"clipA" | "clipB" | "music" | "photo" | "counter" | "object", string> {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  for (const [name, args] of Object.entries(RECIPES)) {
    const out = path.join(MEDIA_DIR, name);
    if (fs.existsSync(out)) continue;
    // Write under a temporary name: test files run in parallel and must never read a half-written file.
    const tmp = path.join(MEDIA_DIR, `${process.pid}-${name}`);
    execFileSync("ffmpeg", ["-v", "error", "-y", ...args, tmp]);
    fs.renameSync(tmp, out);
  }
  return {
    clipA: path.join(MEDIA_DIR, "clip_a.mp4"),
    clipB: path.join(MEDIA_DIR, "clip_b.mp4"),
    music: path.join(MEDIA_DIR, "music.m4a"),
    photo: path.join(MEDIA_DIR, "photo.png"),
    counter: path.join(MEDIA_DIR, "counter2.mp4"),
    object: path.join(MEDIA_DIR, "object.mp4"),
  };
}

export function tempWorkspace(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `openedits-${label}-`));
}

export { ROOT };

export type Region = "left" | "right" | "center";

/** Mean red value (0..255) of a small patch of an image, or of a video frame at `timeSeconds`. */
export function level(file: string, region: Region = "center", timeSeconds?: number): number {
  const args = ["-v", "error"];
  if (timeSeconds !== undefined && timeSeconds > 0) args.push("-ss", timeSeconds.toFixed(4));
  const x = { left: "iw/4-iw/16", right: "3*iw/4-iw/16", center: "iw/2-iw/16" }[region];
  args.push("-i", file, "-frames:v", "1", "-vf", `crop=iw/8:ih/4:${x}:ih*3/8,scale=4:4`, "-pix_fmt", "rgb24", "-f", "rawvideo", "-");
  const buf = execFileSync("ffmpeg", args);
  let sum = 0;
  for (let i = 0; i < buf.length; i += 3) sum += buf[i];
  return sum / (buf.length / 3);
}

export const centerLevel = (file: string, timeSeconds?: number) => level(file, "center", timeSeconds);

/** Seek time that makes ffmpeg return exactly frame n of a 30 fps file (input seeking returns the first frame at or after the time). */
export const frameTime = (n: number) => Math.max(0, (n - 0.5) / 30);

/** RGB level of each counter step, measured from the file itself (no assumptions about color conversion). */
let steps: number[] | undefined;
function counterSteps(): number[] {
  if (steps) return steps;
  const file = testMedia().counter;
  // Frames 0..7 cover every step of the left patch.
  steps = Array.from({ length: 8 }, (_, n) => level(file, "left", frameTime(n)));
  return steps;
}

const nearestStep = (v: number) => {
  const s = counterSteps();
  let best = 0;
  for (let i = 1; i < s.length; i++) if (Math.abs(s[i] - v) < Math.abs(s[best] - v)) best = i;
  return best;
};

/** The counter frame number shown in an image (or in a video at `timeSeconds`). */
export function readCounter(file: string, timeSeconds?: number): number {
  return nearestStep(level(file, "left", timeSeconds)) + 8 * nearestStep(level(file, "right", timeSeconds));
}

/** Expected left-patch level of counter frame n. */
export const counterLeftLevel = (n: number) => counterSteps()[n % 8];

/** The script spoken in talk.mp4: pauses, two fillers and a retake. */
export const TALK_SCRIPT =
  "Here are three tips for better videos. [[slnc 1200]] Um, first, keep your hook short. [[slnc 900]] Second, cut the silences. [[slnc 400]] Second, cut every single silence. [[slnc 1000]] Uh, third, add captions. [[slnc 1500]]";

function has(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Whether this machine can synthesize the speech clip (macOS `say`, or eSpeak NG elsewhere). */
export const canSpeak = process.platform === "darwin" || has("espeak-ng", ["--version"]);

/** The whisper.cpp CLI and model the transcript tests need. */
export const haveWhisper = has(process.env.OPENEDITS_WHISPER ?? "whisper-cli", ["--help"]) && fs.existsSync(path.join(os.homedir(), "Movies", "OpenCut", "models", "ggml-large-v3-turbo-q5_0.bin"));

/** A talking-head style clip with real speech (macOS `say`, eSpeak NG elsewhere), generated once. */
export function speechClip(): string {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const out = path.join(MEDIA_DIR, "talk.mp4");
  if (fs.existsSync(out)) return out;
  const speech = path.join(MEDIA_DIR, `talk-${process.pid}.${process.platform === "darwin" ? "aiff" : "wav"}`);
  if (process.platform === "darwin") execFileSync("say", ["-v", "Samantha", "-o", speech, TALK_SCRIPT]);
  else {
    // eSpeak has no [[slnc]] command: speak each phrase and join them with the same pauses.
    const parts = TALK_SCRIPT.split(/\[\[slnc (\d+)\]\]/);
    const inputs: string[] = [];
    const chain: string[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      const phrase = parts[i].trim();
      if (!phrase) continue;
      const wav = path.join(MEDIA_DIR, `talk-${process.pid}-${i}.wav`);
      execFileSync("espeak-ng", ["-v", "en-us", "-s", "165", "-w", wav, phrase]);
      chain.push(`[${inputs.length / 2}:a]aresample=48000,apad=pad_dur=${Number(parts[i + 1] ?? 0) / 1000}[p${chain.length}]`);
      inputs.push("-i", wav);
    }
    execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", `${chain.join(";")};${chain.map((_, i) => `[p${i}]`).join("")}concat=n=${chain.length}:v=0:a=1[out]`, "-map", "[out]", speech]);
    for (let i = 1; i < inputs.length; i += 2) fs.rmSync(inputs[i], { force: true });
  }
  // Write under a temporary name so test files running in parallel never read a half-written clip.
  const tmp = path.join(MEDIA_DIR, `talk-${process.pid}.tmp.mp4`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=540x960:rate=30", "-i", speech, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest", tmp]);
  fs.renameSync(tmp, out);
  fs.rmSync(speech, { force: true });
  return out;
}
