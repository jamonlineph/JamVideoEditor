import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { EditError } from "@openedits/core";
import { runFfmpeg } from "./ffmpeg.js";

const execFileAsync = promisify(execFile);

export interface Voice {
  name: string;
  locale: string;
}

let voiceCache: Voice[] | undefined;

/** Voices installed on this Mac (`say -v ?`). */
export async function listVoices(): Promise<Voice[]> {
  if (voiceCache) return voiceCache;
  if (process.platform !== "darwin") throw new EditError("NOT_IMPLEMENTED", "Text to speech uses macOS voices; it is not available on this platform");
  const { stdout } = await execFileAsync("say", ["-v", "?"]);
  voiceCache = stdout
    .split("\n")
    .map((l) => /^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})\s/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ name: m[1].trim(), locale: m[2] }));
  return voiceCache;
}

/** Speak `text` with a macOS voice into an AAC file. `rate` is words per minute. */
export async function synthesize(text: string, out: string, opts: { voice?: string; rate?: number } = {}): Promise<string> {
  if (!text.trim()) throw new EditError("INVALID_ARGUMENT", "Nothing to say: the text is empty");
  if (opts.voice) {
    const voices = await listVoices();
    if (!voices.some((v) => v.name === opts.voice)) {
      throw new EditError("INVALID_ARGUMENT", `Voice "${opts.voice}" is not installed`, { voices: voices.filter((v) => v.locale.startsWith("en")).map((v) => v.name).slice(0, 40) });
    }
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const aiff = out.replace(/\.[^.]+$/, ".aiff");
  // `say` reads the text from a file so it never reaches a shell or the argument list.
  const textFile = out.replace(/\.[^.]+$/, ".txt");
  fs.writeFileSync(textFile, text.replace(/\[\[/g, "[ ["));
  try {
    await execFileAsync("say", [...(opts.voice ? ["-v", opts.voice] : []), ...(opts.rate ? ["-r", String(Math.round(opts.rate))] : []), "-o", aiff, "-f", textFile]);
    await runFfmpeg(["-y", "-v", "error", "-i", aiff, "-c:a", "aac", "-b:a", "160k", out]);
  } finally {
    fs.rmSync(aiff, { force: true });
    fs.rmSync(textFile, { force: true });
  }
  return out;
}
