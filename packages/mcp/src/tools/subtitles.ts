import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { EditError, addCaptions, captionText, getCatalogItem, type CaptionElement, type CaptionSegmentInput } from "@openedits/core";
import { defineTool } from "../defineTool.js";
import { expectedVersion, mutate } from "./common.js";

function readTime(stamp: string): number {
  const [h, m, s, ms] = stamp.split(/[:,.]/).map(Number);
  if (m > 59 || s > 59) throw new EditError("INVALID_ARGUMENT", `Invalid SRT time: ${stamp}`);
  return h * 3600 + m * 60 + s + ms / 1000;
}

function readSubRip(text: string): CaptionSegmentInput[] {
  const blocks = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim().split(/\n[ \t]*\n+/);
  return blocks.map((block, i) => {
    const lines = block.split("\n");
    if (/^\d+$/.test(lines[0].trim())) lines.shift();
    const timing = /^(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s+-->\s+(\d{2,}:\d{2}:\d{2}[,.]\d{3})(?:\s+.*)?$/.exec(lines.shift()?.trim() ?? "");
    const tokens = lines.join(" ").replace(/<\/?(?:b|i|u|font)(?:\s+[^>]*)?>/gi, "").trim().split(/\s+/).filter(Boolean);
    if (!timing || !tokens.length) throw new EditError("INVALID_ARGUMENT", `Invalid or empty SRT cue ${i + 1}.`);
    const start = readTime(timing[1]), end = readTime(timing[2]);
    if (end <= start) throw new EditError("INVALID_RANGE", `SRT cue ${i + 1} must end after it starts.`);
    const step = (end - start) / tokens.length;
    return { start, end, words: tokens.map((word, index) => ({
      text: word, start: start + index * step, end: start + (index + 1) * step,
    })) };
  });
}

function writeTime(seconds: number) {
  const ms = Math.round(seconds * 1000);
  const clock = [Math.floor(ms / 3_600_000), Math.floor(ms / 60_000) % 60, Math.floor(ms / 1000) % 60];
  return clock.map((n) => String(n).padStart(2, "0")).join(":") + "," + String(ms % 1000).padStart(3, "0");
}

export const subtitleTools = [
  defineTool({
    name: "importSubtitles",
    title: "Import SRT subtitles",
    category: "text",
    description: "Import a UTF-8 SubRip file as editable caption segments on the timeline.",
    input: z.object({ path: z.string(), styleId: z.string().optional(), projectId: z.string().optional(), expectedVersion }),
    handler: (a, ctx) => {
      if (a.projectId !== undefined && a.projectId !== ctx.host.projectId) {
        throw new EditError("VERSION_CONFLICT", "The open project changed while choosing subtitles.");
      }
      const file = fs.statSync(a.path, { throwIfNoEntry: false });
      if (!file?.isFile()) throw new EditError("FILE_NOT_FOUND", "The subtitle file is unavailable.");
      if (file.size > 2 * 1024 * 1024) throw new EditError("INVALID_ARGUMENT", "The SRT file must be under 2 MB.");
      const segments = readSubRip(fs.readFileSync(a.path, "utf8"));
      const style = getCatalogItem("captionStyles", a.styleId ?? ctx.host.project.preferredCaptionStyle ?? ctx.host.settings.defaultCaptionStyle);
      return mutate(ctx, "Import subtitles", (c) => addCaptions(c, segments, { styleId: style.id, highlightColor: (style.data as { highlightColor: string }).highlightColor }).map((el) => el.id),
        { expectedVersion: a.expectedVersion }, (elementIds) => ({ elementIds }));
    },
  }),
  defineTool({
    name: "exportSubtitles",
    title: "Export SRT subtitles",
    category: "text",
    description: "Write visible caption tracks as an SRT file in the outbox.",
    input: z.object({}),
    handler: (_a, ctx) => {
      const p = ctx.host.project;
      const captions = p.tracks.filter((t) => t.kind === "caption" && !t.hidden)
        .flatMap((t) => t.elementIds.map((id) => p.elements[id]))
        .filter((el): el is CaptionElement => el?.type === "caption")
        .sort((a, b) => a.start - b.start);
      if (!captions.length) throw new EditError("INVALID_ARGUMENT", "Add a visible caption before exporting subtitles.");
      const base = p.name.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 100) || "Captions";
      const content = captions.map((el, i) => `${i + 1}\n${writeTime(el.start)} --> ${writeTime(Math.max(el.start + 0.001, el.start + el.duration))}\n${captionText(el).replace(/\s+/g, " ").trim()}\n`).join("\n");
      for (let number = 1; ; number++) {
        const file = path.join(ctx.host.paths.outbox, `${base}${number === 1 ? "" : ` (${number})`}.srt`);
        try {
          fs.writeFileSync(file, content, { flag: "wx" });
          return { path: file, captions: captions.length };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
    },
  }),
];
