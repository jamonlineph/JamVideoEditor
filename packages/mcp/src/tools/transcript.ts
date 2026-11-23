import { z } from "zod";
import { EditError, formatTranscript, mainTrack, timelineWords, type TranscriptOp } from "@openedits/core";
import { captionSetup, type JobInfo } from "@openedits/engine";
import { defineTool, type ToolContext } from "../defineTool.js";
import { expectedVersion, round } from "./common.js";

const pad = z.number().min(0).max(1).optional().describe("Silence kept next to neighbouring words (default from settings, 0.08 s)");
const wordId = z.number().int().positive();

const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("remove_silences"), minSilenceSeconds: z.number().min(0.05).max(10).optional(), paddingSeconds: pad }),
  z.object({ op: z.literal("remove_fillers"), paddingSeconds: pad }),
  z.object({ op: z.literal("remove_retakes"), paddingSeconds: pad, method: z.enum(["auto", "heuristic", "ai"]).optional().describe("auto (default): Claude when enabled, else the local heuristic") }),
  z.object({ op: z.literal("cut"), from: wordId, to: wordId, paddingSeconds: pad }),
  z.object({ op: z.literal("move_to_start"), from: wordId, to: wordId }),
  z.object({ op: z.literal("auto_zoom"), scale: z.number().min(1.01).max(1.5).optional() }),
  z.object({ op: z.literal("captions"), style: z.string().optional(), maxWords: z.number().int().min(1).max(12).optional(), y: z.number().min(0).max(1).optional() }),
  z.object({ op: z.literal("title"), text: z.string().min(1).max(80), durationSeconds: z.number().min(0.5).max(10).optional(), presetId: z.string().optional() }),
  z.object({ op: z.literal("brief"), text: z.string() }),
]);

function jobView(job: JobInfo) {
  return { jobId: job.id, kind: job.kind, status: job.status, progress: round(job.progress, 3), ...(job.message ? { message: job.message } : {}), ...(job.error ? { error: job.error } : {}), ...(job.result ? { result: job.result } : {}) };
}

function mediaTargets(ctx: ToolContext, a: { mediaIds?: string[]; elementId?: string }): string[] {
  const project = ctx.host.project;
  if (a.mediaIds?.length) return a.mediaIds;
  if (a.elementId) {
    const el = project.elements[a.elementId];
    if (!el) throw new EditError("ELEMENT_NOT_FOUND", `No element with id "${a.elementId}"`);
    if (el.type !== "video" && el.type !== "audio") throw new EditError("INVALID_ELEMENT_TYPE", `${el.id} (${el.type}) has no audio`);
    return [el.mediaId];
  }
  const ids = new Set<string>();
  for (const id of mainTrack(project).elementIds) {
    const el = project.elements[id];
    if ((el?.type === "video" || el?.type === "audio") && project.media[el.mediaId]?.hasAudio) ids.add(el.mediaId);
  }
  if (!ids.size) throw new EditError("INVALID_ARGUMENT", "No main-track clip with audio to transcribe");
  return [...ids];
}

function transcriptSummary(ctx: ToolContext) {
  const { words, skipped } = timelineWords(ctx.host.project, ctx.host.transcripts.all());
  return { words, skipped, missing: ctx.host.transcripts.missingForTimeline() };
}

export const transcriptTools = [
  defineTool({
    name: "captionSetup",
    title: "Set up local captions",
    category: "text",
    description: "Check the local caption runtime and model. With download, install the verified base Whisper model if the runtime is available.",
    input: z.object({ download: z.boolean().optional() }),
    handler: (a, ctx) => captionSetup(ctx.host, a.download ?? false),
  }),
  defineTool({
    name: "planRoughCut",
    title: "Find suggested cuts",
    category: "text",
    description: "Find silences, fillers and retakes without changing the edit. Returns a versioned list for review.",
    input: z.object({}),
    handler: (_a, ctx) => ctx.host.transcripts.planRoughCut(),
  }),
  defineTool({
    name: "applyRoughCut",
    title: "Apply reviewed cuts",
    category: "text",
    description: "Apply selected timeline ranges from planRoughCut as one undo step.",
    input: z.object({
      projectId: z.string(),
      version: z.number().int().min(0),
      ranges: z.array(z.object({ start: z.number().min(0), end: z.number().min(0) }).refine((r) => r.end > r.start)).min(1).max(2000),
    }),
    handler: (a, ctx) => ctx.host.transcripts.applyRoughCut(a.projectId, a.version, a.ranges, ctx.source),
  }),
  defineTool({
    name: "transcribeClip",
    title: "Transcribe",
    category: "text",
    description: "Transcribe media with whisper.cpp (local), giving every word a stable #id plus timing aligned to the audio. Default: every main-track clip without a transcript. Long media is split at quiet points and transcribed in parallel. Returns a job; waitSeconds (default 120) blocks until done.",
    input: z.object({ mediaIds: z.array(z.string()).optional(), elementId: z.string().optional(), force: z.boolean().optional(), language: z.string().optional().describe("e.g. en, es; default from settings (auto)"), waitSeconds: z.number().min(0).max(1800).optional() }),
    handler: async (a, ctx) => {
      const job = ctx.host.transcripts.start(mediaTargets(ctx, a), { force: a.force, language: a.language });
      return jobView(await ctx.host.jobs.wait(job.id, (a.waitSeconds ?? 120) * 1000));
    },
  }),
  defineTool({
    name: "get_transcript",
    title: "Get transcript",
    category: "text",
    description: "Numbered words (#id) as they currently play on the main track, with timeline times, [pause] and [cut] markers and (filler) tags. Edit with `edit` using these ids. mediaId shows a whole source transcript instead (including words already cut).",
    input: z.object({ format: z.enum(["text", "json"]).optional(), mediaId: z.string().optional(), from: z.number().min(0).optional(), to: z.number().min(0).optional() }),
    readOnly: true,
    handler: (a, ctx) => {
      if (a.mediaId) {
        const t = ctx.host.transcripts.get(a.mediaId);
        if (!t) throw new EditError("INVALID_ARGUMENT", `No transcript for ${a.mediaId}; run transcribeClip`);
        const onTimeline = new Set(transcriptSummary(ctx).words.map((w) => w.id));
        return { mediaId: t.mediaId, language: t.language, model: t.model, wordCount: t.words.length, words: t.words.map((w) => ({ ...w, onTimeline: onTimeline.has(w.id) })) };
      }
      const { words, skipped, missing } = transcriptSummary(ctx);
      if (!words.length && missing.length) throw new EditError("INVALID_ARGUMENT", "The main-track clips are not transcribed yet: run transcribeClip (or auto_edit)", { missingMediaIds: missing });
      const shown = words.filter((w) => (a.from === undefined || w.end > a.from) && (a.to === undefined || w.start < a.to));
      const meta = {
        wordCount: shown.length,
        durationSeconds: round(shown.length ? shown[shown.length - 1].end - shown[0].start : 0, 3),
        fillers: shown.filter((w) => w.isFiller).map((w) => w.id),
        ...(missing.length ? { untranscribedMediaIds: missing } : {}),
        ...(skipped.length ? { skippedElementIds: skipped, note: "Clips with speed curves are not mapped to words" } : {}),
      };
      if (a.format === "json") return { ...meta, words: shown.map((w) => ({ id: w.id, text: w.text, start: round(w.start, 3), end: round(w.end, 3), elementId: w.elementId, ...(w.isFiller ? { filler: true } : {}), confidence: w.confidence })) };
      return { ...meta, transcript: formatTranscript(shown) };
    },
  }),
  defineTool({
    name: "edit",
    title: "Edit by transcript",
    category: "text",
    description:
      "Apply transcript ops in order, as ONE undo step (a revision is saved first, so `revert` restores the pre-edit cut). Ops: remove_silences, remove_fillers, remove_retakes (keeps the last take), cut {from,to} word ids, move_to_start {from,to} (hook first), auto_zoom {scale} (alternating punch-in), captions {style,maxWords,y}, title {text} (hook title), brief {text}. Cuts land in the pauses between words with padding; generated captions re-sync after cuts.",
    input: z.object({ ops: z.array(opSchema).min(1).max(100), expectedVersion }),
    handler: async (a, ctx) => {
      const res = await ctx.host.transcripts.edit(a.ops as TranscriptOp[], ctx.source, { expectedVersion: a.expectedVersion });
      const { words } = transcriptSummary(ctx);
      return {
        ok: true,
        version: res.version,
        undoLabel: res.label,
        revisionBefore: res.revisionBefore,
        results: res.result,
        ...(res.warnings.length ? { warnings: res.warnings } : {}),
        ...(res.notes.length ? { notes: res.notes } : {}),
        wordsOnTimeline: words.length,
        durationSeconds: round(mainTrack(ctx.host.project).elementIds.reduce((s, id) => s + ctx.host.project.elements[id].duration, 0), 3),
      };
    },
  }),
  defineTool({
    name: "auto_edit",
    title: "Auto edit",
    category: "text",
    description:
      "Hands-free first pass that follows STYLE.md: transcribes what is missing, then removes retakes, fillers and silences, adds alternating punch-in zoom and captions in the guide's style, as one undo step. Returns the plan, per-op results and `notes`: style rules that need judgment (hook, B-roll, music, ending) for you to apply next. Overrides take precedence over STYLE.md.",
    input: z.object({
      removeRetakes: z.boolean().optional(),
      removeFillers: z.boolean().optional(),
      removeSilences: z.boolean().optional(),
      minSilenceSeconds: z.number().min(0.05).max(10).optional(),
      zoomScale: z.number().min(1.01).max(1.5).nullable().optional(),
      captions: z.object({ style: z.string(), maxWords: z.number().int().min(1).max(12).optional() }).nullable().optional(),
      render: z.enum(["preview", "final"]).optional(),
      wait_seconds: z.number().min(0).max(1800).optional(),
    }),
    handler: async ({ render, wait_seconds, ...overrides }, ctx) => {
      const clean = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
      const job = ctx.host.transcripts.startAutoEdit(ctx.source, clean, { render });
      return jobView(await ctx.host.jobs.wait(job.id, (wait_seconds ?? 300) * 1000));
    },
  }),
  defineTool({
    name: "generateCaptions",
    title: "Generate captions",
    category: "text",
    description: "Caption the main track from its transcript (transcribing first if needed): segments of up to maxWords words, carrying the transcript word ids so they re-sync after transcript edits. Replaces previously generated captions; manual captions are kept.",
    input: z.object({ style: z.string().optional(), maxWords: z.number().int().min(1).max(12).optional(), y: z.number().min(0).max(1).optional(), expectedVersion }),
    handler: async (a, ctx) => {
      await ctx.host.transcripts.ensure(ctx.host.transcripts.missingForTimeline(), 300_000);
      const res = await ctx.host.transcripts.edit([{ op: "captions", ...(a.style ? { style: a.style } : {}), ...(a.maxWords ? { maxWords: a.maxWords } : {}), ...(a.y !== undefined ? { y: a.y } : {}) }], ctx.source, { expectedVersion: a.expectedVersion, label: "Generate captions" });
      return { ok: true, version: res.version, undoLabel: res.label, ...(res.result as Record<string, unknown>[])[0] };
    },
  }),
];
