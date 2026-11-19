import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { EditError, compositionDuration } from "@openedits/core";
import { expandHome, type JobInfo, type RenderOutput } from "@openedits/engine";
import { IMAGES_KEY, defineTool, type ToolContext } from "../defineTool.js";
import { round } from "./common.js";

const returnImage = z.boolean().optional().describe("Attach the image to the result so you can look at it (default true). The file path is always returned.");
const jpeg = (file: string, include: boolean | undefined) => (include === false ? {} : { [IMAGES_KEY]: [{ path: file, mimeType: file.endsWith(".png") ? "image/png" : "image/jpeg" }] });

const RENDER_KINDS = ["preview", "export"];

function jobView(job: JobInfo) {
  const r = job.result as RenderOutput | undefined;
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    progress: round(job.progress, 3),
    ...(job.message ? { message: job.message } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(r ? { output: { ...r, durationSeconds: round(r.durationSeconds, 3) } } : {}),
  };
}

function findJob(ctx: ToolContext, kinds: string[], jobId?: string): JobInfo {
  if (jobId) return ctx.host.jobs.get(jobId);
  const projectId = ctx.host.isOpen ? ctx.host.projectId : undefined;
  const latest = kinds
    .map((k) => ctx.host.jobs.latest(k, projectId))
    .filter((j): j is JobInfo => !!j)
    .sort((a, b) => a.createdAt - b.createdAt)
    .at(-1);
  if (!latest) throw new EditError("INVALID_ARGUMENT", `No ${kinds.join(" or ")} render has been started yet`);
  return latest;
}

/** The newest finished render, for looking at its frames. */
function finishedRender(ctx: ToolContext, jobId?: string): { job: JobInfo; output: RenderOutput } {
  if (jobId) {
    const job = ctx.host.jobs.get(jobId);
    if (job.status !== "done") throw new EditError("INVALID_ARGUMENT", `Job ${jobId} is ${job.status}; wait for it to finish`, { status: job.status, progress: job.progress });
    return { job, output: job.result as RenderOutput };
  }
  const projectId = ctx.host.isOpen ? ctx.host.projectId : undefined;
  const done = RENDER_KINDS.flatMap((k) => ctx.host.jobs.list(k)).filter((j) => j.status === "done" && (!projectId || j.projectId === projectId)).sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0)).at(-1);
  if (!done) throw new EditError("INVALID_ARGUMENT", "No finished render yet. Run previewVideo, export or render first.");
  return { job: done, output: done.result as RenderOutput };
}

async function renderedFrames(ctx: ToolContext, a: { jobId?: string; count?: number; times?: number[]; columns?: number; tileShortSide?: number; returnImage?: boolean }) {
  const { job, output } = finishedRender(ctx, a.jobId);
  if (!fs.existsSync(output.path)) throw new EditError("FILE_NOT_FOUND", `The rendered file no longer exists: ${output.path}`);
  const sheet = await ctx.host.render.sourceFrames({ path: output.path, count: a.count ?? 12, timesSourceSeconds: a.times, columns: a.columns, tileShortSide: a.tileShortSide });
  return { jobId: job.id, kind: job.kind, video: output.path, sheet: sheet.path, times: sheet.times.map((t) => round(t, 3)), columns: sheet.columns, ...jpeg(sheet.path, a.returnImage) };
}

/** Resolve "a file to look at": a media id, an inbox file name, or a path. */
function resolveMediaRef(ctx: ToolContext, ref: string): { mediaId?: string; path?: string } {
  if (ctx.host.isOpen) {
    const media = ctx.host.project.media;
    if (media[ref]) return { mediaId: ref };
    const byName = Object.values(media).find((m) => m.name === ref);
    if (byName) return { mediaId: byName.id };
  }
  const expanded = expandHome(ref);
  const inInbox = path.join(ctx.host.paths.inbox, expanded);
  if (!path.isAbsolute(expanded) && fs.existsSync(inInbox)) return { path: inInbox };
  if (fs.existsSync(expanded)) return { path: path.resolve(expanded) };
  throw new EditError("FILE_NOT_FOUND", `"${ref}" is not a media id in this project, a file in the inbox, or an existing path`);
}

export const renderTools = [
  defineTool({
    name: "captureFrame",
    title: "Capture frame",
    category: "export",
    description: "Render one composited frame of the timeline (all layers, color, effects, text, captions) and return it as an image. Default time: the playhead.",
    input: z.object({ time: z.number().min(0).optional(), shortSide: z.number().int().min(120).max(2160).optional().describe("Output short side in pixels (default 540)"), format: z.enum(["jpeg", "png"]).optional(), returnImage }),
    readOnly: true,
    handler: async (a, ctx) => {
      const f = await ctx.host.render.captureFrame({ timeSeconds: a.time, shortSide: a.shortSide, format: a.format });
      return { path: f.path, width: f.width, height: f.height, timeSeconds: round(f.timeSeconds, 4), ...(f.warnings.length ? { warnings: f.warnings } : {}), ...jpeg(f.path, a.returnImage) };
    },
  }),
  defineTool({
    name: "frameSheet",
    title: "Frame sheet",
    category: "export",
    description: "Contact sheet of composited timeline frames with timestamps: `count` evenly spaced frames across [from, to], or explicit `times`. Use it to review pacing, framing and captions at a glance.",
    input: z.object({
      from: z.number().min(0).optional(),
      to: z.number().min(0).optional(),
      count: z.number().int().min(1).max(48).optional(),
      times: z.array(z.number().min(0)).max(48).optional(),
      columns: z.number().int().min(1).max(12).optional(),
      tileShortSide: z.number().int().min(90).max(540).optional(),
      returnImage,
    }),
    readOnly: true,
    handler: async (a, ctx) => {
      const s = await ctx.host.render.frameSheet({ startSeconds: a.from, endSeconds: a.to, count: a.count, times: a.times, columns: a.columns, tileShortSide: a.tileShortSide });
      return { path: s.path, width: s.width, height: s.height, columns: s.columns, times: s.times.map((t) => round(t, 3)), ...(s.warnings.length ? { warnings: s.warnings } : {}), ...jpeg(s.path, a.returnImage) };
    },
  }),
  defineTool({
    name: "captureSourceFrames",
    title: "Capture source frames",
    category: "export",
    description: "Contact sheet of raw frames from a media file (no timeline edits or effects), at explicit source times or `count` evenly spaced. With elementId, covers that element's source window.",
    input: z.object({
      mediaId: z.string().optional(),
      path: z.string().optional(),
      elementId: z.string().optional(),
      timesSourceSeconds: z.array(z.number().min(0)).max(48).optional(),
      count: z.number().int().min(1).max(48).optional(),
      startSourceSeconds: z.number().min(0).optional(),
      endSourceSeconds: z.number().min(0).optional(),
      columns: z.number().int().min(1).max(12).optional(),
      tileShortSide: z.number().int().min(90).max(1080).optional(),
      returnImage,
    }),
    readOnly: true,
    handler: async (a, ctx) => {
      let { mediaId, startSourceSeconds, endSourceSeconds } = a;
      if (a.elementId) {
        const el = ctx.host.project.elements[a.elementId];
        if (!el) throw new EditError("ELEMENT_NOT_FOUND", `No element with id "${a.elementId}"`);
        if (el.type !== "video" && el.type !== "image") throw new EditError("INVALID_ELEMENT_TYPE", `${el.id} (${el.type}) has no picture`);
        mediaId = el.mediaId;
        if (el.type === "video") {
          startSourceSeconds ??= el.sourceInSourceSeconds;
          endSourceSeconds ??= el.sourceInSourceSeconds + el.sourceDurationSourceSeconds;
        }
      }
      const s = await ctx.host.render.sourceFrames({ mediaId, path: a.path, timesSourceSeconds: a.timesSourceSeconds, count: a.count, startSourceSeconds, endSourceSeconds, columns: a.columns, tileShortSide: a.tileShortSide });
      return { path: s.path, name: s.name, kind: s.kind, durationSourceSeconds: s.durationSourceSeconds, columns: s.columns, timesSourceSeconds: s.times.map((t) => round(t, 3)), ...jpeg(s.path, a.returnImage) };
    },
  }),
  defineTool({
    name: "view_media",
    title: "View media",
    category: "export",
    description: "Look at footage or an image before using it: `file` is a media id, an inbox file name, or a path. Videos return a timestamped contact sheet; images return the image.",
    input: z.object({ file: z.string(), count: z.number().int().min(1).max(48).optional(), returnImage }),
    readOnly: true,
    handler: async (a, ctx) => {
      const s = await ctx.host.render.sourceFrames({ ...resolveMediaRef(ctx, a.file), count: a.count ?? 9 });
      return { path: s.path, name: s.name, kind: s.kind, durationSourceSeconds: s.durationSourceSeconds, timesSourceSeconds: s.times.map((t) => round(t, 3)), columns: s.columns, ...jpeg(s.path, a.returnImage) };
    },
  }),
  defineTool({
    name: "previewVideo",
    title: "Preview video",
    category: "export",
    description: "Start a fast low-resolution render of the timeline (or [from, to]) with audio. Returns a jobId immediately; poll previewVideoStatus, then inspect with previewVideoFrames.",
    input: z.object({ from: z.number().min(0).optional(), to: z.number().min(0).optional(), shortSide: z.number().int().min(180).max(1080).optional().describe("Default 540"), waitSeconds: z.number().min(0).max(600).optional() }),
    handler: async (a, ctx) => {
      const job = ctx.host.render.startRender({ mode: "preview", startSeconds: a.from, endSeconds: a.to, shortSide: a.shortSide });
      return jobView(a.waitSeconds ? await ctx.host.jobs.wait(job.id, a.waitSeconds * 1000) : job);
    },
  }),
  defineTool({
    name: "previewVideoStatus",
    title: "Preview status",
    category: "export",
    description: "Status and progress of a preview render (default: the latest). waitSeconds blocks until it finishes or the wait elapses.",
    input: z.object({ jobId: z.string().optional(), waitSeconds: z.number().min(0).max(600).optional() }),
    readOnly: true,
    handler: async (a, ctx) => {
      const job = findJob(ctx, ["preview"], a.jobId);
      return jobView(a.waitSeconds ? await ctx.host.jobs.wait(job.id, a.waitSeconds * 1000) : job);
    },
  }),
  defineTool({
    name: "previewVideoFrames",
    title: "Preview frames",
    category: "export",
    description: "Contact sheet of frames taken from a finished preview render (default: the latest), to check the result exactly as encoded.",
    input: z.object({ jobId: z.string().optional(), count: z.number().int().min(1).max(48).optional(), times: z.array(z.number().min(0)).max(48).optional(), columns: z.number().int().min(1).max(12).optional(), tileShortSide: z.number().int().min(90).max(540).optional(), returnImage }),
    readOnly: true,
    handler: (a, ctx) => renderedFrames(ctx, a),
  }),
  defineTool({
    name: "view_render",
    title: "View render",
    category: "export",
    description: "Look at frames of the most recent finished render (preview or final) to check captions, overlays and framing.",
    input: z.object({ count: z.number().int().min(1).max(48).optional(), returnImage }),
    readOnly: true,
    handler: (a, ctx) => renderedFrames(ctx, a),
  }),
  defineTool({
    name: "export",
    title: "Export",
    category: "export",
    description: "Start the final render using the project's export settings (setExportSettings). Fast presets export H.264 MP4 at 30 fps without changing project settings. Writes to the outbox folder unless outputDir is set; never overwrites an existing file. Returns a jobId; poll exportStatus.",
    input: z.object({
      from: z.number().min(0).optional(),
      to: z.number().min(0).optional(),
      waitSeconds: z.number().min(0).max(600).optional(),
      preset: z.enum(["fast-720p", "fast-1080p"]).optional(),
    }),
    handler: async (a, ctx) => {
      const job = ctx.host.render.startRender({ mode: "export", startSeconds: a.from, endSeconds: a.to, preset: a.preset });
      return jobView(a.waitSeconds ? await ctx.host.jobs.wait(job.id, a.waitSeconds * 1000) : job);
    },
  }),
  defineTool({
    name: "exportStatus",
    title: "Export status",
    category: "export",
    description: "Status, progress and output file of an export (default: the latest). waitSeconds blocks until it finishes or the wait elapses.",
    input: z.object({ jobId: z.string().optional(), waitSeconds: z.number().min(0).max(600).optional() }),
    readOnly: true,
    handler: async (a, ctx) => {
      const job = findJob(ctx, ["export"], a.jobId);
      return jobView(a.waitSeconds ? await ctx.host.jobs.wait(job.id, a.waitSeconds * 1000) : job);
    },
  }),
  defineTool({
    name: "render",
    title: "Render",
    category: "export",
    description: "Render the timeline and wait for it: quality \"preview\" (fast, low resolution) or \"final\" (export settings). Returns the output when done, or a jobId to keep polling if wait_seconds elapses.",
    input: z.object({ quality: z.enum(["preview", "final"]).optional(), wait_seconds: z.number().min(0).max(600).optional() }),
    handler: async (a, ctx) => {
      const job = ctx.host.render.startRender({ mode: a.quality === "final" ? "export" : "preview" });
      return { ...jobView(await ctx.host.jobs.wait(job.id, (a.wait_seconds ?? 120) * 1000)), timelineSeconds: round(compositionDuration(ctx.host.project), 3) };
    },
  }),
  defineTool({
    name: "cancelRender",
    title: "Cancel render",
    category: "export",
    description: "Cancel a running preview or export job. Its partial output file is removed.",
    input: z.object({ jobId: z.string() }),
    handler: async (a, ctx) => {
      ctx.host.jobs.cancel(a.jobId);
      return jobView(await ctx.host.jobs.wait(a.jobId, 5000));
    },
  }),
];
