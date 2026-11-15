import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  AspectRatioSchema,
  EditError,
  addMediaAssets,
  addMediaToTimeline,
  addSticker,
  applyEffect,
  baselineFit,
  canvasPixelSize,
  croppedSize,
  getCatalogItem,
  reframeElement,
  requireElement,
  setCanvas,
  setKeyframe,
  sourceToCanvas,
  splitAt,
  stackTwoSpeakers,
  timelineTimeOfSource,
  trimElement,
  type Element,
  type MediaAsset,
  type VideoElement,
} from "@openedits/core";
import { describeClip, detectBoundaries, visionHelperPath, frameSignatures, listVoices, locateObject, runFfmpeg, shotsFrom, synthesize, transcriptText, twoSpeakerSplit, type Box, type JobInfo, type SubjectFrame } from "@openedits/engine";
import { defineTool, type ToolContext } from "../defineTool.js";
import { expectedVersion, hexColor, mutate, round, transformInput } from "./common.js";

const box = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.001).max(1), h: z.number().min(0.001).max(1) });
const roundBox = (b: Box) => ({ x: round(b.x, 4), y: round(b.y, 4), w: round(b.w, 4), h: round(b.h, 4) });

function jobView(job: JobInfo) {
  return { jobId: job.id, kind: job.kind, status: job.status, progress: round(job.progress, 3), ...(job.message ? { message: job.message } : {}), ...(job.error ? { error: job.error } : {}), ...(job.result ? { result: job.result } : {}) };
}

/** Import a generated file (cutout, mask) as a media asset, reusing an existing one for the same path. */
async function generatedAsset(ctx: ToolContext, file: string, name: string): Promise<{ asset: MediaAsset; isNew: boolean }> {
  const existing = Object.values(ctx.host.project.media).find((m) => m.path === file);
  if (existing) return { asset: existing, isNew: false };
  const probe = await ctx.host.prober(file);
  return { asset: { id: ctx.host.ids("med"), name, path: file, importedAt: ctx.host.now(), ...probe }, isNew: true };
}

const target = {
  elementId: z.string().optional().describe("Analyze this clip's source window; times are timeline seconds"),
  mediaId: z.string().optional().describe("Analyze a whole media file; times are source seconds"),
};

/** Signatures for an element (its source window) or a whole media file, plus a time mapper. */
async function analyze(ctx: ToolContext, a: { elementId?: string; mediaId?: string }) {
  const project = ctx.host.project;
  let media: MediaAsset;
  let el: Element | undefined;
  if (a.elementId) {
    el = requireElement(project, a.elementId);
    if (el.type !== "video") throw new EditError("INVALID_ELEMENT_TYPE", `${el.id} is a ${el.type}; shot detection needs a video clip`);
    media = project.media[el.mediaId];
  } else if (a.mediaId) {
    media = project.media[a.mediaId];
    if (!media) throw new EditError("MEDIA_NOT_FOUND", `No media with id "${a.mediaId}"`);
  } else throw new EditError("INVALID_ARGUMENT", "Provide elementId or mediaId");
  if (media.kind !== "video") throw new EditError("UNSUPPORTED_MEDIA", `${media.name} is not a video`);
  const video = el?.type === "video" ? el : undefined;
  if (video && video.speed.mode !== "constant") throw new EditError("INVALID_ARGUMENT", "Shot detection on clips with speed curves is not supported; use mediaId for source times");
  const sig = await frameSignatures(media.path, media.fps ?? 30, video ? { startSeconds: video.sourceInSourceSeconds, durationSeconds: video.sourceDurationSourceSeconds } : {});
  const boundaries = detectBoundaries(sig);
  const map = (t: number) => (video ? timelineTimeOfSource(video, Math.min(t, video.sourceInSourceSeconds + video.sourceDurationSourceSeconds)) ?? t : t);
  return { sig, boundaries, map, timeBase: video ? "timeline" : "source", media, el: video };
}

export const visionTools = [
  defineTool({
    name: "detectShots",
    title: "Detect shots",
    category: "timeline",
    description: "Find shots in footage: hard cuts and dissolves (frame-accurate), with shots that look alike grouped into camera angles (same `angle` number). elementId reports timeline times; mediaId reports source times.",
    input: z.object(target),
    readOnly: true,
    handler: async (a, ctx) => {
      const r = await analyze(ctx, a);
      const shots = shotsFrom(r.sig, r.boundaries).map((s) => {
        const x = r.map(s.start);
        const y = r.map(s.end);
        return { ...s, start: round(Math.min(x, y), 3), end: round(Math.max(x, y), 3) };
      });
      return {
        timeBase: r.timeBase,
        media: r.media.name,
        shotCount: shots.length,
        angleCount: new Set(shots.map((s) => s.angle)).size,
        shots,
        dissolves: r.boundaries.dissolves.map((d) => ({ start: round(r.map(d.start), 3), end: round(r.map(d.end), 3), score: d.score })),
      };
    },
  }),
  defineTool({
    name: "detectCuts",
    title: "Detect cuts",
    category: "timeline",
    description: "Hard cuts in footage (e.g. a pre-edited clip). With splitAtCuts and an elementId, the clip is split at every cut in one undo step so each shot can be trimmed, moved or reframed on its own.",
    input: z.object({ ...target, splitAtCuts: z.boolean().optional(), expectedVersion }),
    handler: async (a, ctx) => {
      const r = await analyze(ctx, a);
      const cuts = r.boundaries.cuts.map((c) => ({ time: round(r.map(c.time), 4), score: c.score })).sort((x, y) => x.time - y.time);
      if (!a.splitAtCuts) return { timeBase: r.timeBase, media: r.media.name, cuts };
      if (!r.el) throw new EditError("INVALID_ARGUMENT", "splitAtCuts needs an elementId on the timeline");
      if (!cuts.length) return { timeBase: r.timeBase, cuts, splits: 0 };
      const id = r.el.id;
      return mutate(ctx, `Split at ${cuts.length} detected cut${cuts.length > 1 ? "s" : ""}`, (c) => splitAt(c, { times: cuts.map((x) => x.time), elementIds: [id], snap: "projectFrame" }), { expectedVersion: a.expectedVersion }, (res) => ({ timeBase: r.timeBase, cuts, splits: res.splits }));
    },
  }),
  defineTool({
    name: "applyTextToSpeech",
    title: "Text to speech",
    category: "text",
    description: "Speak a text element (or `text`) with a system voice (macOS, Windows or eSpeak NG on Linux) and place it as a voiceover clip at the text's start (or `start`), in one undo step. With a text element, its duration is extended to cover the speech when needed. Lists the installed voices if `voice` is unknown.",
    input: z.object({
      elementId: z.string().optional(),
      text: z.string().max(5000).optional(),
      start: z.number().min(0).optional(),
      voice: z.string().optional(),
      rate: z.number().min(80).max(400).optional().describe("Words per minute (default about 175)"),
      expectedVersion,
    }),
    handler: async (a, ctx) => {
      const project = ctx.host.project;
      const textEl = a.elementId ? requireElement(project, a.elementId) : undefined;
      if (textEl && textEl.type !== "text") throw new EditError("INVALID_ELEMENT_TYPE", `${textEl.id} is a ${textEl.type}; pass a text element or \`text\``);
      const text = a.text ?? (textEl?.type === "text" ? textEl.text : undefined);
      if (!text?.trim()) throw new EditError("INVALID_ARGUMENT", "Provide a text element or `text`");
      const start = a.start ?? textEl?.start ?? ctx.host.appState.playheadSeconds;
      const hash = createHash("sha1").update(JSON.stringify([text, a.voice ?? "", a.rate ?? 0])).digest("hex").slice(0, 12);
      const file = await synthesize(text, path.join(ctx.host.projectDirPath, "cache", "tts", `tts-${hash}.m4a`), { voice: a.voice, rate: a.rate });
      const probe = await ctx.host.prober(file);
      const existing = Object.values(project.media).find((m) => m.path === file);
      const asset: MediaAsset = existing ?? { id: ctx.host.ids("med"), name: `Voice: ${text.slice(0, 32)}${text.length > 32 ? "…" : ""}`, path: file, importedAt: ctx.host.now(), ...probe };
      return mutate(ctx, "Text to speech", (c) => {
        if (!existing) addMediaAssets(c, [asset]);
        const el = addMediaToTimeline(c, c.draft.media[asset.id], { start, role: "tts" });
        if (textEl?.type === "text") {
          const t = c.draft.elements[textEl.id];
          const needed = el.start + el.duration - (t.start + t.duration);
          if (needed > 0) trimElement(c, t, "right", -needed);
        }
        return el;
      }, { expectedVersion: a.expectedVersion }, (el) => ({ elementId: el.id, mediaId: asset.id, durationSeconds: round(el.duration, 3), voice: a.voice ?? "system default" }));
    },
  }),
  defineTool({
    name: "ttsVoices",
    title: "TTS voices",
    category: "text",
    description: "Voices installed on this computer for applyTextToSpeech, optionally filtered by locale prefix (e.g. en, es_ES).",
    input: z.object({ locale: z.string().optional() }),
    readOnly: true,
    handler: async (a) => {
      const voices = (await listVoices()).filter((v) => !a.locale || v.locale.startsWith(a.locale));
      return { count: voices.length, voices };
    },
  }),
  defineTool({
    name: "detectSubjects",
    title: "Detect subjects",
    category: "timeline",
    description: "Faces and people (Apple Vision, on-device) sampled across a clip or media file, with the primary subject per sample (largest face, else person, else salient region). Boxes are normalized to the source frame, top-left origin.",
    input: z.object({ ...target, perSecond: z.number().min(0.2).max(10).optional(), from: z.number().min(0).optional(), to: z.number().min(0).optional() }),
    readOnly: true,
    handler: async (a, ctx) => {
      const r = await ctx.host.vision.subjects(a);
      const faces = r.frames.map((f) => f.faces.length);
      return {
        timeBase: r.timeBase,
        media: r.media.name,
        samples: r.frames.length,
        maxFaces: Math.max(0, ...faces),
        framesWithFaces: faces.filter((n) => n > 0).length,
        framesWithPeople: r.frames.filter((f) => f.people.length).length,
        frames: r.frames.map((f) => ({
          time: round(f.time, 3),
          faces: f.faces.map((d) => ({ box: roundBox(d.box), confidence: round(d.confidence, 3) })),
          people: f.people.map((d) => ({ box: roundBox(d.box), confidence: round(d.confidence, 3) })),
          ...(f.salient ? { salient: { box: roundBox(f.salient.box), confidence: round(f.salient.confidence, 3) } } : {}),
          ...(f.primary ? { primary: { x: round(f.primary.x, 4), y: round(f.primary.y, 4), kind: f.primary.kind } } : {}),
        })),
      };
    },
  }),
  defineTool({
    name: "autoReframe",
    title: "Auto reframe",
    category: "transform",
    description: "Keep subjects in frame (optionally after changing aspectRatio, e.g. 16:9 footage to 9:16): each main-track video clip is framed on its primary subject, either one static position or keyframes that follow it (smoothed, with a dead zone). When two speakers are too far apart for one frame, the clip becomes a stacked split screen with each panel on one person. One undo step.",
    input: z.object({
      aspectRatio: AspectRatioSchema.optional(),
      elementIds: z.array(z.string()).optional(),
      mode: z.enum(["follow", "static"]).optional(),
      splitTwoSpeakers: z.boolean().optional(),
      perSecond: z.number().min(0.5).max(10).optional(),
      expectedVersion,
    }),
    handler: async (a, ctx) => {
      const clips = ctx.host.vision.reframeTargets(a.elementIds);
      if (!clips.length) throw new EditError("INVALID_ARGUMENT", "No video clips to reframe");
      const analyses: { id: string; frames: SubjectFrame[] }[] = [];
      for (const clip of clips) analyses.push({ id: clip.id, frames: (await ctx.host.vision.subjects({ elementId: clip.id, perSecond: a.perSecond ?? 2 })).frames });
      const mode = a.mode ?? "follow";
      return mutate(ctx, `Auto reframe${a.aspectRatio ? ` to ${a.aspectRatio}` : ""}`, (c) => {
        if (a.aspectRatio) setCanvas(c, { aspectRatio: a.aspectRatio });
        const canvas = canvasPixelSize(c.draft.canvas);
        return analyses.map(({ id, frames }) => {
          const el = c.draft.elements[id] as VideoElement;
          const samples = frames.filter((f) => f.primary).map((f) => ({ time: f.time, x: f.primary!.x, y: f.primary!.y }));
          if (!samples.length) return { elementId: id, result: "skipped", reason: "no face, person or salient subject found" };
          if (a.splitTwoSpeakers !== false) {
            const media = c.draft.media[el.mediaId];
            const cover = baselineFit(canvas, croppedSize({ width: media.width ?? canvas.width, height: media.height ?? canvas.height }, el.crop), "cover");
            const split = twoSpeakerSplit(frames, Math.min(1, canvas.width / (cover.width * el.transform.scale)));
            if (split) {
              const r = stackTwoSpeakers(c, el, split.a, split.b);
              return { elementId: id, result: "stack2", panels: r.panelIds, speakersAt: [round(split.a, 3), round(split.b, 3)] };
            }
          }
          const r = reframeElement(c, el, samples, mode);
          const kinds = frames.map((f) => f.primary?.kind).filter(Boolean);
          return { elementId: id, result: r.keyframes ? "follow" : "static", keyframes: r.keyframes, x: round(r.x, 4), y: round(r.y, 4), subject: kinds.includes("face") ? "face" : kinds.includes("person") ? "person" : "salient region" };
        });
      }, { expectedVersion: a.expectedVersion }, (results) => ({ clips: results, canvas: ctx.host.project.canvas }));
    },
  }),
  defineTool({
    name: "trackObject",
    title: "Track object",
    category: "timeline",
    description: "Follow something through footage with Apple Vision tracking. Start from `box` (normalized source frame, top-left origin), `target` face / person (largest at the start) / subject (most salient region), or a free-text `prompt` (\"the red mug\"), which Claude locates in the first frame when Claude features are enabled. With attachElementId (e.g. a sticker or text), that element gets x/y keyframes so it follows the object.",
    input: z.object({
      ...target,
      target: z.enum(["face", "person", "subject", "box"]).optional(),
      box: box.optional(),
      prompt: z.string().min(2).max(200).optional(),
      from: z.number().min(0).optional(),
      to: z.number().min(0).optional(),
      perSecond: z.number().min(2).max(30).optional(),
      attachElementId: z.string().optional(),
      offset: z.object({ x: z.number(), y: z.number() }).optional().describe("Canvas offset (normalized) from the object center for the attached element"),
      expectedVersion,
    }),
    handler: async (a, ctx) => {
      let start: Box | undefined = a.box;
      let label: string | undefined;
      if (!start && a.prompt) {
        const reason = ctx.host.ai.unavailableReason();
        if (reason) throw new EditError("NOT_IMPLEMENTED", `Text prompts need Claude: ${reason}. Use target face/person/subject or pass a box.`);
        const t = ctx.host.vision.target(a);
        const [first] = ctx.host.vision.sampleTimes(t, 1, a);
        const frameDir = path.join(ctx.host.projectDirPath, "cache", "frames");
        fs.mkdirSync(frameDir, { recursive: true });
        const frame = path.join(frameDir, `locate-${Date.now().toString(36)}.jpg`);
        await runFfmpeg(["-v", "error", "-y", ...(first > 0 ? ["-ss", first.toFixed(4)] : []), "-i", t.media.path, "-frames:v", "1", "-vf", "scale=-2:720", "-q:v", "3", frame]);
        const found = await locateObject(ctx.host.ai, frame, a.prompt, { width: t.media.width ?? 1280, height: t.media.height ?? 720 });
        start = found.box;
        label = found.label;
      }
      if (!start) {
        const kind = a.target ?? "subject";
        if (kind === "box") throw new EditError("INVALID_ARGUMENT", "target box needs `box`");
        const probe = await ctx.host.vision.subjects({ elementId: a.elementId, mediaId: a.mediaId, perSecond: 0.2, from: a.from, to: (a.from ?? 0) + 0.2 });
        const f = probe.frames[0];
        const pick = (list: { box: Box }[]) => [...list].sort((x, y) => y.box.w * y.box.h - x.box.w * x.box.h)[0]?.box;
        start = kind === "face" ? pick(f?.faces ?? []) : kind === "person" ? pick(f?.people ?? []) : f?.salient?.box ?? pick(f?.people ?? []) ?? pick(f?.faces ?? []);
        if (!start) throw new EditError("INVALID_ARGUMENT", `No ${kind} found at the start of the range; pass a box instead`);
      }
      const r = await ctx.host.vision.track({ elementId: a.elementId, mediaId: a.mediaId, box: start, perSecond: a.perSecond, from: a.from, to: a.to });
      const step = Math.max(1, Math.ceil(r.frames.length / 60));
      const summary = {
        timeBase: r.timeBase,
        lost: r.lost,
        samples: r.frames.length,
        startBox: roundBox(start),
        ...(label ? { located: label } : {}),
        path: r.frames.filter((_, i) => i % step === 0).map((f) => ({ time: round(f.time, 3), box: roundBox(f.box), confidence: round(f.confidence, 2) })),
      };
      if (!a.attachElementId) return summary;
      if (!r.el || r.el.type !== "video") throw new EditError("INVALID_ARGUMENT", "attachElementId needs an elementId target on the timeline");
      const clipId = r.el.id;
      return mutate(ctx, "Attach to tracked object", (c) => {
        const clip = c.draft.elements[clipId] as VideoElement;
        const follower = requireElement(c.draft, a.attachElementId!);
        if (!("transform" in follower)) throw new EditError("INVALID_ELEMENT_TYPE", `${follower.id} (${follower.type}) cannot be positioned`);
        let n = 0;
        for (const f of r.frames) {
          if (f.time < follower.start - 1e-6 || f.time > follower.start + follower.duration + 1e-6) continue;
          const p = sourceToCanvas(c.draft, clip, f.box.x + f.box.w / 2, f.box.y + f.box.h / 2, f.time);
          setKeyframe(c, follower, { property: "x", time: f.time, value: p.x + (a.offset?.x ?? 0) });
          setKeyframe(c, follower, { property: "y", time: f.time, value: p.y + (a.offset?.y ?? 0) });
          n++;
        }
        if (!n) throw new EditError("INVALID_RANGE", `The tracked range does not overlap ${follower.id} on the timeline`);
        return n;
      }, { expectedVersion: a.expectedVersion }, (n) => ({ ...summary, attachedKeyframes: n }));
    },
  }),
  defineTool({
    name: "addStickerFromCutout",
    title: "Sticker from cutout",
    category: "timeline",
    description: "Cut a person or the main subject out of one frame (Apple Vision, on-device) and add it as a sticker. By default it is placed where the subject was and at the same size, at the frame's time for 3 s. `point` (normalized source frame) picks one subject when there are several.",
    input: z.object({
      ...target,
      time: z.number().min(0).optional().describe("Timeline seconds for an element; source seconds for media"),
      kind: z.enum(["person", "subject"]).optional(),
      point: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
      start: z.number().min(0).optional(),
      duration: z.number().positive().max(600).optional(),
      transform: transformInput.optional(),
      expectedVersion,
    }),
    handler: async (a, ctx) => {
      const cut = await ctx.host.vision.cutout(a);
      const { asset, isNew } = await generatedAsset(ctx, cut.path, `Cutout: ${cut.media.name} @ ${cut.sourceSeconds.toFixed(2)}s`);
      const clip = cut.el?.type === "video" ? cut.el : undefined;
      const start = a.start ?? (clip ? timelineTimeOfSource(clip, cut.sourceSeconds) ?? clip.start : ctx.host.appState.playheadSeconds);
      return mutate(ctx, "Sticker from cutout", (c) => {
        if (isNew) addMediaAssets(c, [asset]);
        let placement: { x: number; y: number; scale: number } | undefined;
        if (clip && cut.box && !a.transform) {
          const el = c.draft.elements[clip.id] as VideoElement;
          const p = sourceToCanvas(c.draft, el, cut.box.x + cut.box.w / 2, cut.box.y + cut.box.h / 2, start);
          const canvas = canvasPixelSize(c.draft.canvas);
          const contain = baselineFit(canvas, { width: cut.width, height: cut.height }, "contain");
          placement = { x: p.x, y: p.y, scale: Math.max(0.05, (cut.box.w * p.pxPerSourceWidth) / contain.width) };
        }
        return addSticker(c, { cutoutMaskId: asset.id, start, duration: a.duration ?? 3, name: asset.name, transform: a.transform ?? placement ?? { scale: 0.5 } });
      }, { expectedVersion: a.expectedVersion }, (el) => ({ elementId: el.id, mediaId: asset.id, cutout: { width: cut.width, height: cut.height, ...(cut.box ? { sourceBox: roundBox(cut.box) } : {}) } }));
    },
  }),
  defineTool({
    name: "applySubjectEffect",
    title: "Subject effect",
    category: "color",
    description: "Effects that follow a person or the main subject frame by frame: background_blur (blur everything but the subject), subject_glow (halo around the subject) or outline (stroke around the subject). Masks are computed on-device with Apple Vision for the clip's source window (a background job; cached). One undo step when it lands.",
    input: z.object({
      elementId: z.string(),
      effectId: z.enum(["background_blur", "subject_glow", "outline"]),
      kind: z.enum(["person", "subject"]).optional(),
      intensity: z.number().min(0).max(100).optional(),
      color: hexColor.optional(),
      radius: z.number().min(0).max(100).optional(),
      width: z.number().min(0).max(50).optional(),
      waitSeconds: z.number().min(0).max(1800).optional(),
    }),
    handler: async (a, ctx) => {
      getCatalogItem("effects", a.effectId);
      const host = ctx.host;
      const el = requireElement(host.project, a.elementId);
      if (el.type !== "video") throw new EditError("INVALID_ELEMENT_TYPE", `${el.id} is a ${el.type}; subject effects need a video clip`);
      visionHelperPath(); // fail now, not in the background job, when subject masks cannot be computed here
      const kind = a.kind ?? "person";
      const job = host.jobs.start("subject_effect", async (j) => {
        const mask = await host.vision.subjectMask(host.project.elements[el.id] as VideoElement, kind, j);
        const { asset, isNew } = await generatedAsset(ctx, mask.path, `Subject mask (${kind}): ${host.project.media[el.mediaId].name}`);
        const params: Record<string, number | string> = { maskStartSourceSeconds: mask.startSourceSeconds };
        if (a.color) params.color = a.color;
        if (a.radius !== undefined) params.radius = a.radius;
        if (a.width !== undefined) params.width = a.width;
        const res = host.mutate(`Subject effect ${a.effectId}`, ctx.source, (c) => {
          if (isNew) addMediaAssets(c, [asset]);
          return applyEffect(c, c.draft.elements[el.id], { effectId: a.effectId, intensity: a.intensity ?? 100, params, subjectMaskId: asset.id });
        });
        return { elementId: el.id, effect: res.result, maskMediaId: asset.id, maskFrames: mask.frames, version: res.version, undoLabel: res.label };
      }, { projectId: host.projectId });
      return jobView(await host.jobs.wait(job.id, (a.waitSeconds ?? 120) * 1000));
    },
  }),
  defineTool({
    name: "describeClip",
    title: "Describe clip",
    category: "timeline",
    description: "Ask Claude what is in footage (a contact sheet of frames plus the transcript when there is one): summary, setting, people, shot type, topics, vibes, a suggested caption, hook ideas and an aesthetic score 1-10. Needs Claude features enabled (sends the frames and words to the Claude API).",
    input: z.object({ ...target, count: z.number().int().min(3).max(16).optional() }),
    readOnly: true,
    handler: async (a, ctx) => {
      const reason = ctx.host.ai.unavailableReason();
      if (reason) throw new EditError("NOT_IMPLEMENTED", reason);
      const t = ctx.host.vision.target(a);
      const range = t.video ? { start: t.video.sourceInSourceSeconds, end: t.video.sourceInSourceSeconds + t.video.sourceDurationSourceSeconds } : undefined;
      const sheet = await ctx.host.render.sourceFrames({ mediaId: t.media.id, count: a.count ?? 9, startSourceSeconds: range?.start, endSourceSeconds: range?.end, tileShortSide: 216 });
      const transcript = ctx.host.transcripts.get(t.media.id);
      const r = await describeClip(ctx.host.ai, sheet.path, {
        name: t.media.name,
        durationSeconds: range ? range.end - range.start : t.media.durationSourceSeconds,
        times: sheet.times,
        ...(transcript ? { transcript: transcriptText(transcript.words, range?.start, range?.end) } : {}),
      });
      return { ...(t.el ? { elementId: t.el.id } : {}), mediaId: t.media.id, ...r.value, model: r.model, usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens } };
    },
  }),
];
