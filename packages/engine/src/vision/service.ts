import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { EditError, mainTrack, requireElement, sourceTimeAt, timelineTimeOfSource, type Element, type MediaAsset, type VideoElement, type ImageElement } from "@openedits/core";
import type { EngineHost } from "../host.js";
import type { JobContext } from "../jobs.js";
import { ffmpegPath } from "../ffmpeg.js";
import { visionCutout, visionMasks, visionSaliency, visionSubjects, visionTrack, type Box, type Detection } from "./helper.js";

export interface SubjectFrame {
  /** Timeline seconds for an element target, source seconds for a media target. */
  time: number;
  sourceSeconds: number;
  faces: Detection[];
  people: Detection[];
  /** Salient region when no face or person is visible. */
  salient?: Detection;
  /** The subject chosen for framing (largest face, else largest person, else salient region). */
  primary?: { x: number; y: number; kind: "face" | "person" | "salient" };
}

const area = (b: Box) => b.w * b.h;
const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Where the subject is in frame: the largest face, else the largest person, else the salient region. */
export function primarySubject(f: Pick<SubjectFrame, "faces" | "people" | "salient">): SubjectFrame["primary"] {
  const face = [...f.faces].sort((a, b) => area(b.box) - area(a.box))[0];
  if (face) {
    // Frame a little below the face so heads are not cut by the top edge.
    const c = center(face.box);
    return { x: c.x, y: Math.min(1, c.y + face.box.h * 0.35), kind: "face" };
  }
  const person = [...f.people].sort((a, b) => area(b.box) - area(a.box))[0];
  if (person) return { ...center(person.box), y: person.box.y + person.box.h * 0.35, kind: "person" };
  if (f.salient) return { ...center(f.salient.box), kind: "salient" };
  return undefined;
}

/**
 * Two speakers who cannot both fit one vertical frame: in at least half the samples there are two
 * faces whose centers are farther apart than the visible width allows.
 */
export function twoSpeakerSplit(frames: SubjectFrame[], visibleWidth: number): { a: number; b: number } | null {
  const pairs = frames
    .map((f) => [...f.faces].sort((x, y) => area(y.box) - area(x.box)).slice(0, 2))
    .filter((p) => p.length === 2 && area(p[1].box) > area(p[0].box) * 0.35)
    .map((p) => p.map((d) => center(d.box).x).sort((x, y) => x - y) as [number, number]);
  if (frames.length === 0 || pairs.length < frames.length / 2) return null;
  const median = (v: number[]) => [...v].sort((x, y) => x - y)[v.length >> 1];
  const a = median(pairs.map((p) => p[0]));
  const b = median(pairs.map((p) => p[1]));
  return b - a > visibleWidth * 0.75 ? { a, b } : null;
}

export class VisionService {
  constructor(private readonly host: EngineHost) {}

  private cacheDir(sub: string) {
    const dir = path.join(this.host.projectDirPath, "cache", sub);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** The media file and source window to analyze, and how to map source times back. */
  target(a: { elementId?: string; mediaId?: string }) {
    const project = this.host.project;
    let el: Element | undefined;
    let media: MediaAsset;
    if (a.elementId) {
      el = requireElement(project, a.elementId);
      if (el.type !== "video" && el.type !== "image") throw new EditError("INVALID_ELEMENT_TYPE", `${el.id} is a ${el.type}; vision needs a video or image`);
      media = project.media[el.mediaId];
    } else if (a.mediaId) {
      media = project.media[a.mediaId];
      if (!media) throw new EditError("MEDIA_NOT_FOUND", `No media with id "${a.mediaId}"`);
    } else throw new EditError("INVALID_ARGUMENT", "Provide elementId or mediaId");
    if (media.kind === "audio") throw new EditError("UNSUPPORTED_MEDIA", `${media.name} has no picture`);
    const video = el?.type === "video" ? el : undefined;
    const toOutput = (src: number) => (video ? timelineTimeOfSource(video, src) ?? video.start : src);
    return { el: el as VideoElement | ImageElement | undefined, video, media, toOutput, timeBase: el ? "timeline" : "source" };
  }

  /** Source times to sample: across the clip's source window (or the whole file). */
  sampleTimes(t: ReturnType<VisionService["target"]>, perSecond: number, range?: { from?: number; to?: number }): number[] {
    if (t.media.kind === "image") return [0];
    const project = this.host.project;
    let s0: number;
    let s1: number;
    if (t.video) {
      const from = Math.max(t.video.start, range?.from ?? t.video.start);
      const to = Math.min(t.video.start + t.video.duration, range?.to ?? Infinity);
      const a = sourceTimeAt(project, t.video, from);
      const b = sourceTimeAt(project, t.video, Math.max(from, to - 1e-3));
      s0 = Math.min(a, b);
      s1 = Math.max(a, b);
    } else {
      s0 = range?.from ?? 0;
      s1 = Math.min(range?.to ?? Infinity, (t.media.durationSourceSeconds ?? 1) - 0.02);
    }
    const n = Math.max(1, Math.min(600, Math.ceil((s1 - s0) * perSecond)));
    return Array.from({ length: n }, (_, i) => (n === 1 ? (s0 + s1) / 2 : s0 + ((s1 - s0) * i) / (n - 1)));
  }

  async subjects(a: { elementId?: string; mediaId?: string; perSecond?: number; from?: number; to?: number }, signal?: AbortSignal): Promise<{ frames: SubjectFrame[]; timeBase: string; media: MediaAsset }> {
    const t = this.target(a);
    const times = this.sampleTimes(t, a.perSecond ?? 2, a);
    const r = await visionSubjects(t.media.path, times, signal);
    const frames: SubjectFrame[] = r.frames.map((f) => ({ time: t.toOutput(f.time), sourceSeconds: f.time, faces: f.faces ?? [], people: f.people ?? [] }));
    const empty = frames.filter((f) => !f.faces.length && !f.people.length);
    if (empty.length) {
      const sal = await visionSaliency(t.media.path, empty.map((f) => f.sourceSeconds), signal);
      sal.frames.forEach((s, i) => {
        const best = [...(s.objects ?? [])].sort((x, y) => y.confidence - x.confidence)[0];
        if (best) empty[i].salient = best;
      });
    }
    for (const f of frames) f.primary = primarySubject(f);
    frames.sort((x, y) => x.time - y.time);
    return { frames, timeBase: t.timeBase, media: t.media };
  }

  /** Main-track video clips (or the given ones) for auto reframe. */
  reframeTargets(elementIds?: string[]): VideoElement[] {
    const project = this.host.project;
    const ids = elementIds?.length ? elementIds : mainTrack(project).elementIds;
    return ids.map((id) => requireElement(project, id)).filter((e): e is VideoElement => e.type === "video");
  }

  /** Cut a subject out of one frame into a transparent PNG. */
  async cutout(a: { elementId?: string; mediaId?: string; time?: number; kind?: "person" | "subject"; point?: [number, number] }) {
    const t = this.target(a);
    const project = this.host.project;
    const sourceTime = t.video ? sourceTimeAt(project, t.video, a.time ?? t.video.start + t.video.duration / 2) : a.time ?? 0;
    const out = path.join(this.cacheDir("cutouts"), `cutout-${t.media.id}-${Math.round(sourceTime * 1000)}-${a.kind ?? "subject"}${a.point ? `-${a.point.map((v) => Math.round(v * 100)).join("_")}` : ""}.png`);
    const r = await visionCutout(t.media.path, sourceTime, out, { kind: a.kind, point: a.point });
    return { ...r, sourceSeconds: sourceTime, media: t.media, el: t.el };
  }

  /** Per-frame subject masks for a clip's source window, encoded as a small grayscale video. */
  async subjectMask(el: VideoElement, kind: "person" | "subject", job: JobContext): Promise<{ path: string; startSourceSeconds: number; fps: number; width: number; height: number; frames: number }> {
    const media = this.host.project.media[el.mediaId];
    if (!media.width || !media.height) throw new EditError("UNSUPPORTED_MEDIA", `No dimensions for ${media.name}`);
    const fps = Math.min(30, media.fps ?? 30);
    const start = el.sourceInSourceSeconds;
    const count = Math.max(1, Math.round(el.sourceDurationSourceSeconds * fps));
    const times = Array.from({ length: count }, (_, i) => start + i / fps);
    const scale = Math.min(1, 360 / Math.min(media.width, media.height));
    const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);
    const width = even(media.width * scale);
    const height = even(media.height * scale);
    const out = path.join(this.cacheDir("masks"), `mask-${el.mediaId}-${kind}-${Math.round(start * 1000)}-${count}.mp4`);
    if (!fs.existsSync(out)) {
      const tmp = `${out}.part.mp4`;
      const enc = spawn(ffmpegPath(), ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${width}x${height}`, "-r", String(fps), "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-color_range", "pc", tmp], { stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      enc.stderr.on("data", (d: Buffer) => (err += d.toString()));
      const closed = new Promise<number | null>((resolve) => enc.on("close", resolve));
      try {
        await visionMasks(media.path, times, width, height, kind, (mask, i) => {
          enc.stdin.write(mask);
          if (i % 10 === 0) job.progress(i / count, `Masked ${i}/${count} frames`);
        }, job.signal);
        enc.stdin.end();
        if ((await closed) !== 0) throw new EditError("INTERNAL", `Mask encode failed: ${err.trim()}`);
        fs.renameSync(tmp, out);
      } catch (e) {
        enc.kill("SIGKILL");
        fs.rmSync(tmp, { force: true });
        throw e;
      }
    }
    return { path: out, startSourceSeconds: start, fps, width, height, frames: count };
  }

  /** Follow a box through the footage (Apple Vision object tracking at `perSecond` samples). */
  async track(a: { elementId?: string; mediaId?: string; box: Box; perSecond?: number; from?: number; to?: number }, signal?: AbortSignal) {
    const t = this.target(a);
    const times = this.sampleTimes(t, a.perSecond ?? 15, a);
    const r = await visionTrack(t.media.path, a.box, times, signal);
    const frames = r.frames.filter((f) => f.box).map((f) => ({ time: t.toOutput(f.time), sourceSeconds: f.time, box: f.box!, confidence: f.confidence ?? 0 }));
    frames.sort((x, y) => x.time - y.time);
    return { frames, lost: r.lost, timeBase: t.timeBase, media: t.media, el: t.el };
  }
}
