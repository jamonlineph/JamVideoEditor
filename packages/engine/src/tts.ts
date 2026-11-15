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

/**
 * Text to speech with the voices the operating system already has:
 * macOS `say`, Windows SAPI (through PowerShell), and eSpeak NG on Linux.
 */
type Backend = "say" | "sapi" | "espeak-ng" | "espeak";

const POWERSHELL = "powershell.exe";
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

let backendCache: Backend | null | undefined;
let voiceCache: Voice[] | undefined;

async function works(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, { windowsHide: true, timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

async function backend(): Promise<Backend> {
  if (backendCache === undefined) {
    if (process.platform === "darwin") backendCache = "say";
    else if (process.platform === "win32") backendCache = (await works(POWERSHELL, [...PS_ARGS, "Add-Type -AssemblyName System.Speech"])) ? "sapi" : null;
    else backendCache = (await works("espeak-ng", ["--version"])) ? "espeak-ng" : (await works("espeak", ["--version"])) ? "espeak" : null;
  }
  if (!backendCache) {
    const hint = process.platform === "win32" ? "Windows speech (System.Speech) could not be loaded" : "install eSpeak NG (for example: sudo apt install espeak-ng)";
    throw new EditError("NOT_IMPLEMENTED", `Text to speech is not available on this computer: ${hint}`);
  }
  return backendCache;
}

/** Whether a system voice is available for text to speech. */
export async function speechAvailable(): Promise<boolean> {
  try {
    await backend();
    return true;
  } catch {
    return false;
  }
}

/** Parse `say -v ?`: "Samantha            en_US    # Hello…". */
export function parseSayVoices(stdout: string): Voice[] {
  return stdout
    .split("\n")
    .map((l) => /^(.+?)\s{2,}([a-z]{2,3}[_-][A-Za-z0-9]{2,})\s/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ name: m[1].trim(), locale: m[2].replace("-", "_") }));
}

/** Parse `espeak-ng --voices`: "Pty Language Age/Gender VoiceName File Other Languages". */
export function parseEspeakVoices(stdout: string): Voice[] {
  const out: Voice[] = [];
  for (const line of stdout.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || !/^\d+$/.test(cols[0])) continue;
    // The language code doubles as the name `-v` accepts; the display name may contain spaces or underscores.
    out.push({ name: cols[1], locale: cols[1].replace("-", "_") });
  }
  return out;
}

/** Parse "Name|culture" lines printed by the SAPI listing script. */
export function parseSapiVoices(stdout: string): Voice[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim().split("|"))
    .filter((p) => p.length === 2 && p[0])
    .map(([name, culture]) => ({ name, locale: culture.replace("-", "_") }));
}

/** Voices installed on this computer. */
export async function listVoices(): Promise<Voice[]> {
  if (voiceCache) return voiceCache;
  const b = await backend();
  if (b === "say") voiceCache = parseSayVoices((await execFileAsync("say", ["-v", "?"])).stdout);
  else if (b === "sapi") {
    const script = "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }";
    voiceCache = parseSapiVoices((await execFileAsync(POWERSHELL, [...PS_ARGS, script], { windowsHide: true })).stdout);
  } else voiceCache = parseEspeakVoices((await execFileAsync(b, ["--voices"])).stdout);
  return voiceCache;
}

/** SAPI rate (-10..10, where 10 is three times as fast) for a words-per-minute target. */
export function sapiRate(wordsPerMinute: number): number {
  return Math.max(-10, Math.min(10, Math.round((10 * Math.log(wordsPerMinute / 175)) / Math.log(3))));
}

/** Speak `text` with a system voice into an AAC file. `rate` is words per minute. */
export async function synthesize(text: string, out: string, opts: { voice?: string; rate?: number } = {}): Promise<string> {
  if (!text.trim()) throw new EditError("INVALID_ARGUMENT", "Nothing to say: the text is empty");
  const b = await backend();
  if (opts.voice) {
    const voices = await listVoices();
    if (!voices.some((v) => v.name === opts.voice)) {
      throw new EditError("INVALID_ARGUMENT", `Voice "${opts.voice}" is not installed`, { voices: voices.filter((v) => v.locale.startsWith("en")).map((v) => v.name).slice(0, 40) });
    }
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const stem = out.replace(/\.[^.]+$/, "");
  const raw = `${stem}.${b === "say" ? "aiff" : "wav"}`;
  // The text goes through a file so it never reaches a shell or the argument list.
  const textFile = `${stem}.txt`;
  fs.writeFileSync(textFile, b === "say" ? text.replace(/\[\[/g, "[ [") : text);
  const rate = opts.rate ? Math.round(opts.rate) : undefined;
  try {
    if (b === "say") await execFileAsync("say", [...(opts.voice ? ["-v", opts.voice] : []), ...(rate ? ["-r", String(rate)] : []), "-o", raw, "-f", textFile]);
    else if (b === "sapi") {
      const script = [
        "Add-Type -AssemblyName System.Speech",
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
        "if ($env:OPENEDITS_TTS_VOICE) { $s.SelectVoice($env:OPENEDITS_TTS_VOICE) }",
        "if ($env:OPENEDITS_TTS_RATE) { $s.Rate = [int]$env:OPENEDITS_TTS_RATE }",
        "$s.SetOutputToWaveFile($env:OPENEDITS_TTS_OUT)",
        "$s.Speak([System.IO.File]::ReadAllText($env:OPENEDITS_TTS_TEXT, [System.Text.Encoding]::UTF8))",
        "$s.Dispose()",
      ].join("; ");
      const env = { ...process.env, OPENEDITS_TTS_OUT: raw, OPENEDITS_TTS_TEXT: textFile, OPENEDITS_TTS_VOICE: opts.voice ?? "", OPENEDITS_TTS_RATE: rate ? String(sapiRate(rate)) : "" };
      await execFileAsync(POWERSHELL, [...PS_ARGS, script], { windowsHide: true, env });
    } else await execFileAsync(b, [...(opts.voice ? ["-v", opts.voice] : []), ...(rate ? ["-s", String(rate)] : []), "-w", raw, "-f", textFile]);
    if (!fs.existsSync(raw) || fs.statSync(raw).size < 64) throw new EditError("INTERNAL", "The system voice produced no audio");
    await runFfmpeg(["-y", "-v", "error", "-i", raw, "-ar", "48000", "-c:a", "aac", "-b:a", "160k", out]);
  } catch (e) {
    if (e instanceof EditError) throw e;
    throw new EditError("INTERNAL", `Text to speech failed: ${(e as Error).message.split("\n")[0]}`);
  } finally {
    fs.rmSync(raw, { force: true });
    fs.rmSync(textFile, { force: true });
  }
  return out;
}
