import { current, isDraft } from "immer";
import type { AudioElement, Element, ImageElement, MediaAsset, Transform, VideoElement } from "../schema.js";
import { defaultAudioProps, defaultVisualProps } from "../defaults.js";
import { EditError } from "../errors.js";
import type { EditContext } from "./context.js";
import { cleanTime } from "../units.js";

export const DEFAULT_IMAGE_DURATION = 3;

/** Deep-copies any value, including immer drafts. */
export function plainClone<T>(value: T): T {
  const plain = isDraft(value) ? current(value as never) : value;
  return structuredClone(plain) as T;
}

/** Deep-copies an element (works on immer drafts). */
export function cloneElement<T extends Element>(el: T): T {
  return plainClone(el);
}

export interface MediaElementOptions {
  trackId: string;
  start: number;
  sourceInSourceSeconds?: number;
  sourceDurationSourceSeconds?: number;
  /** For images (and as an upper bound for sourced media). */
  durationSeconds?: number;
  transform?: Partial<Transform>;
  role?: AudioElement["role"];
  name?: string;
}

/** Build a timeline element for a media asset (not yet attached to a track). */
export function buildMediaElement(ctx: EditContext, media: MediaAsset, opts: MediaElementOptions): VideoElement | ImageElement | AudioElement {
  const id = ctx.ids("el");
  const name = opts.name ?? media.name;
  if (media.kind === "image") {
    const el: ImageElement = {
      type: "image",
      id,
      trackId: opts.trackId,
      name,
      start: cleanTime(opts.start),
      duration: opts.durationSeconds ?? DEFAULT_IMAGE_DURATION,
      ...defaultVisualProps(opts.transform),
      mediaId: media.id,
      flip: { horizontal: false, vertical: false },
    };
    return el;
  }
  const total = media.durationSourceSeconds;
  if (total === undefined) throw new EditError("UNSUPPORTED_MEDIA", `Media "${media.name}" has no duration`, { mediaId: media.id });
  const sourceIn = Math.max(0, opts.sourceInSourceSeconds ?? 0);
  if (sourceIn >= total) throw new EditError("INVALID_RANGE", `sourceInSourceSeconds ${sourceIn} is past the end of "${media.name}" (${total}s)`);
  let span = opts.sourceDurationSourceSeconds ?? total - sourceIn;
  if (opts.durationSeconds !== undefined) span = Math.min(span, opts.durationSeconds);
  span = Math.min(span, total - sourceIn);
  if (span <= 0) throw new EditError("INVALID_RANGE", "Source window is empty");
  const sourced = {
    mediaId: media.id,
    sourceInSourceSeconds: cleanTime(sourceIn),
    sourceDurationSourceSeconds: cleanTime(span),
    speed: { mode: "constant" as const, rate: 1 },
    reversed: false,
  };
  if (media.kind === "audio" || !media.hasVideo) {
    const el: AudioElement = {
      type: "audio",
      id,
      trackId: opts.trackId,
      name,
      start: cleanTime(opts.start),
      duration: cleanTime(span),
      ...sourced,
      ...defaultAudioProps(),
      keyframes: {},
      role: opts.role ?? "music",
    };
    return el;
  }
  const el: VideoElement = {
    type: "video",
    id,
    trackId: opts.trackId,
    name,
    start: cleanTime(opts.start),
    duration: cleanTime(span),
    ...defaultVisualProps(opts.transform),
    ...sourced,
    ...defaultAudioProps(),
    flip: { horizontal: false, vertical: false },
    audioDetached: false,
    reverseStatus: "none",
  };
  if (!media.hasAudio) el.muted = false;
  return el;
}
