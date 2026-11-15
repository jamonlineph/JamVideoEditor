import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface WorkspacePaths {
  root: string;
  inbox: string;
  autoEdit: string;
  projects: string;
  outbox: string;
  brand: string;
  fonts: string;
  music: string;
  cache: string;
  trash: string;
  models: string;
  settingsFile: string;
  styleGuideFile: string;
  libraryDb: string;
  engineFile: string;
  sessionFile: string;
}

export interface Settings {
  whisperModelPath: string;
  language: string;
  minSilenceSeconds: number;
  cutPaddingSeconds: number;
  defaultCaptionStyle: string;
  httpPort: number;
  shortcutMap: "edits" | "capcut" | "premiere" | "finalcut" | "resolve";
  /** Optional Claude features (describeClip, AI retake detection, text-prompted tracking). */
  claude: { model: string; apiKeyEnv: string; enabled?: boolean };
}

/**
 * ~/Movies/OpenEdits on macOS; ~/Videos/OpenEdits on Windows and Linux (their standard video
 * folder), unless a ~/Movies/OpenEdits workspace is already there.
 */
export function defaultWorkspaceRoot(): string {
  if (process.env.OPENEDITS_WORKSPACE) return process.env.OPENEDITS_WORKSPACE;
  const movies = path.join(os.homedir(), "Movies", "OpenEdits");
  if (process.platform === "darwin" || fs.existsSync(movies)) return movies;
  return path.join(os.homedir(), "Videos", "OpenEdits");
}

export function resolveWorkspace(root = defaultWorkspaceRoot()): WorkspacePaths {
  const r = path.resolve(root);
  return {
    root: r,
    inbox: path.join(r, "inbox"),
    autoEdit: path.join(r, "auto-edit"),
    projects: path.join(r, "projects"),
    outbox: path.join(r, "outbox"),
    brand: path.join(r, "brand"),
    fonts: path.join(r, "brand", "fonts"),
    music: path.join(r, "brand", "music"),
    cache: path.join(r, ".cache"),
    trash: path.join(r, ".trash"),
    models: path.join(r, "models"),
    settingsFile: path.join(r, "settings.json"),
    styleGuideFile: path.join(r, "STYLE.md"),
    libraryDb: path.join(r, "Project.db"),
    engineFile: path.join(r, ".engine.json"),
    sessionFile: path.join(r, ".session.json"),
  };
}

const WHISPER_MODEL = "ggml-large-v3-turbo-q5_0.bin";

/** Prefer the Whisper model OpenCut already downloaded, so we don't fetch another 547 MB copy. */
export function defaultWhisperModelPath(paths: WorkspacePaths): string {
  const shared = path.join(os.homedir(), "Movies", "OpenCut", "models", WHISPER_MODEL);
  if (fs.existsSync(shared)) return shared;
  return path.join(paths.models, WHISPER_MODEL);
}

export function defaultSettings(paths: WorkspacePaths): Settings {
  return {
    whisperModelPath: defaultWhisperModelPath(paths),
    language: "auto",
    minSilenceSeconds: 0.35,
    cutPaddingSeconds: 0.08,
    defaultCaptionStyle: "bold",
    httpPort: 4417,
    shortcutMap: "edits",
    claude: { model: "claude-opus-5-5", apiKeyEnv: "ANTHROPIC_API_KEY" },
  };
}

export const DEFAULT_STYLE_GUIDE = `# Style Guide

Agents read this file before editing. Change it to change how your videos are cut.

## About
- Niche / topic:
- Audience:
- Tone: clear, direct, friendly
- Usual call to action:

## Format
- Vertical 1080x1920 at 30 fps unless a project says otherwise.
- Aim for 30-60 seconds.

## Pacing
- Remove silences longer than 0.35 s and filler words.
- When a sentence is repeated, keep the cleanest, final take.
- Never cut in the middle of a word.

## Hook
- The first 2 seconds must earn attention. Move the strongest line to the start if needed.
- Add a short on-screen hook title (6 words max) for the first 2-3 seconds.

## Captions
- Captions on, style "bold", up to 3 words at a time, active word highlighted.

## Visuals
- Subtle punch-in zooms (about 1.1x) between cuts to hide jump cuts.
- Place dropped images where the transcript mentions them, for 2-4 seconds each.

## Audio
- Dialogue around -14 LUFS integrated; music ducked under speech.
- Only add music when a track is provided or requested.
`;

export function ensureWorkspace(paths: WorkspacePaths) {
  for (const dir of [paths.root, paths.inbox, paths.autoEdit, paths.projects, paths.outbox, paths.brand, paths.fonts, paths.music, paths.cache, paths.trash]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(paths.settingsFile)) fs.writeFileSync(paths.settingsFile, JSON.stringify(defaultSettings(paths), null, 2) + "\n");
  if (!fs.existsSync(paths.styleGuideFile)) fs.writeFileSync(paths.styleGuideFile, DEFAULT_STYLE_GUIDE);
}

export function loadSettings(paths: WorkspacePaths): Settings {
  const defaults = defaultSettings(paths);
  try {
    const raw = JSON.parse(fs.readFileSync(paths.settingsFile, "utf8"));
    return { ...defaults, ...raw, claude: { ...defaults.claude, ...(raw.claude ?? {}) } };
  } catch {
    return defaults;
  }
}

export function saveSettings(paths: WorkspacePaths, settings: Settings) {
  fs.writeFileSync(paths.settingsFile, JSON.stringify(settings, null, 2) + "\n");
}
