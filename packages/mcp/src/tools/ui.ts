import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { EditError } from "@openedits/core";
import { decodePcm, renderAudioMix, speechAvailable, visionAvailable, whisperAvailable, writeWav } from "@openedits/engine";
import { defineTool } from "../defineTool.js";
import { round } from "./common.js";

const playbackMixes = new Map<string, Promise<void>>();

/** Tools the desktop app uses for playback and drawing (agents can use them too). */
export const uiTools = [
  defineTool({
    name: "previewAudio",
    title: "Preview audio",
    category: "audio",
    description: "Render the timeline's audio mix (volumes, fades, ducking, speed) to a WAV for playback, cached per project version. Returns the file path.",
    input: z.object({}),
    readOnly: true,
    handler: async (_a, ctx) => {
      const host = ctx.host;
      const dir = path.join(host.projectDirPath, "cache", "playback");
      fs.mkdirSync(dir, { recursive: true });
      const { project } = host;
      const { version } = host.session;
      const key = `${host.projectId}-${version}`;
      const file = path.join(dir, `mix-${key}.wav`);
      if (!fs.existsSync(file)) {
        let pending = playbackMixes.get(file);
        if (!pending) {
          pending = renderAudioMix(project).then((mix) => {
            const tmp = `${file}.part`;
            try {
              writeWav(tmp, mix.samples, mix.sampleRate, 2);
              fs.renameSync(tmp, file);
            } finally {
              fs.rmSync(tmp, { force: true });
            }
            // Keep the new mix and the three most recent previous mixes.
            const old = fs.readdirSync(dir).filter((f) => f.startsWith("mix-") && f.endsWith(".wav"))
              .map((f) => path.join(dir, f)).filter((f) => f !== file)
              .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(3);
            for (const f of old) fs.rmSync(f, { force: true });
          }).finally(() => playbackMixes.delete(file));
          playbackMixes.set(file, pending);
        }
        await pending;
      }
      const seconds = (fs.statSync(file).size - 44) / (48000 * 2 * 4);
      return { path: file, version, durationSeconds: round(seconds, 3) };
    },
  }),
  defineTool({
    name: "waveform",
    title: "Waveform",
    category: "audio",
    description: "Peak levels (0..1) of a media file's audio at pointsPerSecond, for drawing waveforms. Cached per media.",
    input: z.object({ mediaId: z.string(), pointsPerSecond: z.number().int().min(10).max(200).optional() }),
    readOnly: true,
    handler: async (a, ctx) => {
      const media = ctx.host.project.media[a.mediaId];
      if (!media) throw new EditError("MEDIA_NOT_FOUND", `No media with id "${a.mediaId}"`);
      if (!media.hasAudio) return { mediaId: a.mediaId, pointsPerSecond: a.pointsPerSecond ?? 50, peaks: [] };
      const pps = a.pointsPerSecond ?? 50;
      const dir = path.join(ctx.host.projectDirPath, "cache", "waveforms");
      fs.mkdirSync(dir, { recursive: true });
      const key = createHash("sha1").update(`${media.path}|${media.sizeBytes}|${pps}`).digest("hex").slice(0, 16);
      const file = path.join(dir, `${key}.json`);
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
      const rate = 8000;
      const pcm = await decodePcm(media.path, { sampleRate: rate, channels: 1 });
      const step = Math.max(1, Math.round(rate / pps));
      const peaks: number[] = [];
      for (let i = 0; i < pcm.length; i += step) {
        let m = 0;
        for (let j = i; j < Math.min(pcm.length, i + step); j++) m = Math.max(m, Math.abs(pcm[j]));
        peaks.push(Math.round(Math.min(1, m) * 1000) / 1000);
      }
      const result = { mediaId: a.mediaId, pointsPerSecond: pps, peaks };
      fs.writeFileSync(file, JSON.stringify(result));
      return result;
    },
  }),
];

export const voiceoverTools = [
  defineTool({
    name: "startVoiceoverRecording",
    title: "Start voiceover recording",
    category: "audio",
    description: "Start recording a voiceover in the desktop app (microphone), after a pre-roll countdown, from the playhead or `start`. The teleprompter scrolls while recording if it is open. Needs the desktop app open.",
    input: z.object({ start: z.number().min(0).optional(), preRollSeconds: z.number().int().min(0).max(10).optional() }),
    handler: async (a, ctx) => ({ ok: true, ...((await ctx.host.requestUi("startRecording", { start: a.start, preRollSeconds: a.preRollSeconds ?? 3 }, 20_000)) as Record<string, unknown>) }),
  }),
  defineTool({
    name: "stopVoiceoverRecording",
    title: "Stop voiceover recording",
    category: "audio",
    description: "Stop the voiceover recording; the take is imported and placed on a voiceover lane where recording started (one undo step).",
    input: z.object({}),
    handler: async (_a, ctx) => ({ ok: true, ...((await ctx.host.requestUi("stopRecording", {}, 60_000)) as Record<string, unknown>) }),
  }),
  defineTool({
    name: "getSettings",
    title: "Get settings",
    category: "project",
    description: "App settings: shortcut map, default caption style, silence and padding defaults, Whisper language, Claude opt-in, and which optional features this computer supports (features: transcription, speech, vision).",
    input: z.object({}),
    readOnly: true,
    handler: async (_a, ctx) => {
      const s = ctx.host.settings;
      const features = {
        transcription: (await whisperAvailable()) && fs.existsSync(s.whisperModelPath),
        speech: await speechAvailable(),
        vision: visionAvailable(),
      };
      return { shortcutMap: s.shortcutMap, defaultCaptionStyle: s.defaultCaptionStyle, minSilenceSeconds: s.minSilenceSeconds, cutPaddingSeconds: s.cutPaddingSeconds, language: s.language, claudeEnabled: ctx.host.ai.unavailableReason() === null, workspace: ctx.host.paths.root, features };
    },
  }),
  defineTool({
    name: "updateSettings",
    title: "Update settings",
    category: "project",
    description: "Change app settings: shortcutMap (edits, capcut, premiere, finalcut, resolve), defaultCaptionStyle, minSilenceSeconds, cutPaddingSeconds, language.",
    input: z.object({
      shortcutMap: z.enum(["edits", "capcut", "premiere", "finalcut", "resolve"]).optional(),
      defaultCaptionStyle: z.string().optional(),
      minSilenceSeconds: z.number().min(0.05).max(5).optional(),
      cutPaddingSeconds: z.number().min(0).max(1).optional(),
      language: z.string().optional(),
    }),
    handler: (a, ctx) => {
      const patch = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined));
      const s = ctx.host.updateSettings(patch);
      return { ok: true, shortcutMap: s.shortcutMap, defaultCaptionStyle: s.defaultCaptionStyle };
    },
  }),
];
