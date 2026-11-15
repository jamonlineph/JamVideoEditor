import { z } from "zod";
import {
  BeatDensitySchema,
  ExportSettingsSchema,
  addBeatMarker,
  gainToDb,
  removeBeatMarker,
  requireElement,
  setBeatDensity,
  setDucking,
  setExportSettings,
  setFade,
  setSound,
  setVoiceEnhance,
} from "@openedits/core";
import { defineTool } from "../defineTool.js";
import { expectedVersion, mutate, resolveElementId, round } from "./common.js";

export const audioTools = [
  defineTool({
    name: "setSound",
    title: "Set sound",
    category: "audio",
    description: "Set volume as linear gain 0..10 (1 = 0 dB, 10 = +20 dB) or volumeDb, and/or mute a video/audio element.",
    input: z.object({ elementId: z.string().optional(), volume: z.number().min(0).max(10).optional(), volumeDb: z.number().min(-120).max(20).optional(), muted: z.boolean().optional(), expectedVersion }),
    handler: ({ elementId, expectedVersion: ev, ...opts }, ctx) => {
      const id = resolveElementId(ctx, elementId);
      return mutate(ctx, "Volume", (c) => setSound(c, requireElement(c.draft, id), opts), { expectedVersion: ev }, () => {
        const el = ctx.host.project.elements[id] as { volume: number; muted: boolean };
        return { volume: el.volume, volumeDb: round(gainToDb(el.volume), 3), muted: el.muted };
      });
    },
  }),
  defineTool({
    name: "setVoiceEnhance",
    title: "Set voice enhance",
    category: "audio",
    description: "AI voice enhance: reduceNoise 0..100 and enhanceVoice 0..100 (applied by the audio pipeline at preview/export).",
    input: z.object({ elementId: z.string().optional(), enabled: z.boolean().optional(), reduceNoise: z.number().min(0).max(100).optional(), enhanceVoice: z.number().min(0).max(100).optional(), expectedVersion }),
    handler: ({ elementId, expectedVersion: ev, ...opts }, ctx) => {
      const id = resolveElementId(ctx, elementId);
      return mutate(ctx, "Voice enhance", (c) => setVoiceEnhance(c, requireElement(c.draft, id), opts), { expectedVersion: ev });
    },
  }),
  defineTool({
    name: "setDucking",
    title: "Set ducking",
    category: "audio",
    description: "Auto-duck this element (usually music) under speech by amountDb with attack/release.",
    input: z.object({ elementId: z.string().optional(), enabled: z.boolean().optional(), amountDb: z.number().min(-60).max(0).optional(), attackSeconds: z.number().min(0).max(5).optional(), releaseSeconds: z.number().min(0).max(5).optional(), expectedVersion }),
    handler: ({ elementId, expectedVersion: ev, ...opts }, ctx) => {
      const id = resolveElementId(ctx, elementId);
      return mutate(ctx, "Ducking", (c) => setDucking(c, requireElement(c.draft, id), { enabled: true, ...opts }), { expectedVersion: ev });
    },
  }),
  defineTool({
    name: "setFade",
    title: "Set fade",
    category: "audio",
    description: "Audio fade in / out durations in seconds.",
    input: z.object({ elementId: z.string().optional(), fadeInSeconds: z.number().min(0).optional(), fadeOutSeconds: z.number().min(0).optional(), expectedVersion }),
    handler: ({ elementId, expectedVersion: ev, ...opts }, ctx) => {
      const id = resolveElementId(ctx, elementId);
      return mutate(ctx, "Fade", (c) => setFade(c, requireElement(c.draft, id), opts), { expectedVersion: ev });
    },
  }),
  defineTool({
    name: "beatMarkers",
    title: "Beat markers",
    category: "audio",
    description: "Beat markers (manual and auto-detected) and the display density. Move/trim snapping uses them.",
    input: z.object({}),
    readOnly: true,
    handler: (_a, ctx) => ({ density: ctx.host.project.beatDensity, markers: ctx.host.project.beatMarkers }),
  }),
  defineTool({
    name: "addBeatMarker",
    title: "Add beat marker",
    category: "audio",
    description: "Add a manual beat marker at a timeline time (default: the playhead).",
    input: z.object({ time: z.number().min(0).optional(), strength: z.number().min(0).max(1).optional(), expectedVersion }),
    handler: (a, ctx) => mutate(ctx, "Add beat marker", (c) => addBeatMarker(c, a.time ?? ctx.host.appState.playheadSeconds, a.strength), { expectedVersion: a.expectedVersion, skipFinalize: true }, (m) => ({ marker: m })),
  }),
  defineTool({
    name: "removeBeatMarker",
    title: "Remove beat marker",
    category: "audio",
    description: "Remove a beat marker by id.",
    input: z.object({ markerId: z.string(), expectedVersion }),
    handler: (a, ctx) => mutate(ctx, "Remove beat marker", (c) => removeBeatMarker(c, a.markerId), { expectedVersion: a.expectedVersion, skipFinalize: true }),
  }),
  defineTool({
    name: "setBeatDensity",
    title: "Set beat density",
    category: "audio",
    description: "Beat marker density: off, lowest, low, medium, high, extreme.",
    input: z.object({ density: BeatDensitySchema, expectedVersion }),
    handler: (a, ctx) => mutate(ctx, "Beat density", (c) => setBeatDensity(c, a.density), { expectedVersion: a.expectedVersion, skipFinalize: true }),
  }),
];

export const exportTools = [
  defineTool({
    name: "setExportSettings",
    title: "Set export settings",
    category: "export",
    description: "Export resolution, fps, codec (h264/hevc/prores), quality, container, audio bitrate, caption burn-in and output location. Used by export and render (quality final).",
    input: ExportSettingsSchema.partial().extend({ expectedVersion }),
    handler: ({ expectedVersion: ev, ...patch }, ctx) => mutate(ctx, "Export settings", (c) => setExportSettings(c, patch), { expectedVersion: ev, skipFinalize: true }, () => ({ exportSettings: ctx.host.project.exportSettings })),
  }),
];
