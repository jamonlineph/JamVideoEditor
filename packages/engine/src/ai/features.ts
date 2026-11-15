import fs from "node:fs";
import { z } from "zod";
import { EditError, formatTranscript, type TimelineWord, type TranscriptWord } from "@openedits/core";
import type { AiClient } from "./claude.js";
import { imageBlock } from "./claude.js";
import type { Box } from "../vision/helper.js";

export const ClipDescriptionSchema = z.object({
  summary: z.string().describe("One or two sentences on what happens"),
  setting: z.string(),
  peopleCount: z.number().int().min(0),
  shotType: z.enum(["talking_head", "b_roll", "product", "screen_recording", "landscape", "action", "group", "other"]),
  topics: z.array(z.string()).max(8),
  vibes: z.array(z.string()).max(6),
  suggestedCaption: z.string().describe("A short social caption for this clip"),
  hookIdeas: z.array(z.string()).max(3).describe("On-screen hook titles, 6 words max each"),
  aestheticScore: z.number().int().min(1).max(10),
  aestheticNotes: z.string().describe("Lighting, framing, focus, stability"),
});
export type ClipDescription = z.infer<typeof ClipDescriptionSchema>;

/** Describe footage from a contact sheet of its frames (and its words, when transcribed). */
export async function describeClip(ai: AiClient, sheetPath: string, info: { name: string; durationSeconds?: number; times: number[]; transcript?: string }) {
  const content = [
    imageBlock(fs.readFileSync(sheetPath)),
    {
      type: "text" as const,
      text: [
        `Contact sheet of "${info.name}"${info.durationSeconds ? ` (${info.durationSeconds.toFixed(1)} s)` : ""}: frames at ${info.times.map((t) => `${t.toFixed(1)}s`).join(", ")}, left to right, top to bottom.`,
        info.transcript ? `Spoken words:\n${info.transcript.slice(0, 6000)}` : "No transcript is available.",
        "Describe the clip for a short-form video editor deciding how to use it.",
      ].join("\n\n"),
    },
  ];
  return ai.structured({
    schema: ClipDescriptionSchema,
    system: "You are an assistant editor reviewing footage for vertical short-form videos. Be concrete and brief. Base every field on what is visible or audible; do not invent details.",
    content,
    effort: "low",
    maxTokens: 4000,
  });
}

const RetakeSchema = z.object({
  retakes: z.array(z.object({ fromId: z.number().int(), toId: z.number().int(), reason: z.string() })),
});

/**
 * Word id ranges to remove as retakes, false starts and abandoned sentences (keeping the best,
 * usually last, take). Ranges are validated against the words that were sent.
 */
export async function findRetakesWithAi(ai: AiClient, words: TimelineWord[]): Promise<{ ranges: [number, number][]; reasons: string[]; model: string }> {
  if (!words.length) return { ranges: [], reasons: [], model: "" };
  const r = await ai.structured({
    schema: RetakeSchema,
    system:
      "You edit spoken-word videos. Find retakes: a sentence or phrase the speaker repeats or restarts, false starts, and abandoned sentences. For each, return the word id range to REMOVE (inclusive), keeping the best take (usually the last complete one). Never remove the only take of an idea. Ignore filler words and pauses; other steps handle those. Return an empty list when there are no retakes.",
    content: [{ type: "text", text: `Transcript (each word is #id text):\n${formatTranscript(words)}` }],
    effort: "medium",
    maxTokens: 8000,
  });
  const ids = new Set(words.map((w) => w.id));
  const ranges: [number, number][] = [];
  const reasons: string[] = [];
  for (const t of r.value.retakes) {
    if (t.fromId > t.toId || !ids.has(t.fromId) || !ids.has(t.toId)) continue;
    // Refuse ranges that would remove most of the video: that is not a retake.
    const span = words.filter((w) => w.id >= t.fromId && w.id <= t.toId).length;
    if (span > words.length * 0.5) continue;
    ranges.push([t.fromId, t.toId]);
    reasons.push(t.reason);
  }
  return { ranges, reasons, model: r.model };
}

const LocateSchema = z.object({
  found: z.boolean(),
  label: z.string(),
  box: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) }).nullable(),
});

/** Find the object a text prompt describes in one frame (normalized box, top-left origin). */
export async function locateObject(ai: AiClient, framePath: string, prompt: string, size: { width: number; height: number }): Promise<{ box: Box; label: string }> {
  const r = await ai.structured({
    schema: LocateSchema,
    system: "You locate objects in video frames. Return a tight bounding box normalized to the image (x, y = top-left corner; w, h = size; all 0..1). If the object is not visible, set found to false and box to null.",
    content: [imageBlock(fs.readFileSync(framePath)), { type: "text", text: `Image size ${size.width}x${size.height}. Find: ${prompt}` }],
    effort: "low",
    maxTokens: 2000,
  });
  if (!r.value.found || !r.value.box || r.value.box.w < 0.005 || r.value.box.h < 0.005) throw new EditError("INVALID_ARGUMENT", `Could not find "${prompt}" in the first frame; pass a box instead`);
  const b = r.value.box;
  return { box: { x: b.x, y: b.y, w: Math.min(b.w, 1 - b.x), h: Math.min(b.h, 1 - b.y) }, label: r.value.label };
}

/** Plain transcript text of the words inside a source window (for describeClip). */
export function transcriptText(words: TranscriptWord[], from = 0, to = Infinity): string {
  return words
    .filter((w) => w.startSourceSeconds >= from && w.startSourceSeconds < to)
    .map((w) => w.text)
    .join(" ");
}
