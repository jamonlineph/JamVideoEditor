import type { Element } from "../schema.js";
import { EditError } from "../errors.js";
import { EPS, cleanTime, dbToGain } from "../units.js";
import { assertUnlocked } from "../timeline/query.js";
import type { EditContext } from "./context.js";

type AudioCapable = Extract<Element, { type: "video" | "audio" }>;

function requireAudio(el: Element): asserts el is AudioCapable {
  if (el.type !== "video" && el.type !== "audio") throw new EditError("INVALID_ELEMENT_TYPE", `Element ${el.id} (${el.type}) has no audio`);
}

export function setSound(ctx: EditContext, el: Element, opts: { volume?: number; volumeDb?: number; muted?: boolean }) {
  requireAudio(el);
  assertUnlocked(ctx.draft, el);
  if (opts.volume !== undefined && opts.volumeDb !== undefined) throw new EditError("INVALID_ARGUMENT", "Pass volume or volumeDb, not both");
  if (opts.volume !== undefined) el.volume = opts.volume;
  if (opts.volumeDb !== undefined) el.volume = dbToGain(opts.volumeDb);
  if (opts.muted !== undefined) el.muted = opts.muted;
  if (el.keyframes.volume?.length && (opts.volume !== undefined || opts.volumeDb !== undefined)) ctx.warn(`volume on ${el.id} is keyframed; keyframes still drive it`);
  ctx.touch(el.id);
}

export function setVoiceEnhance(ctx: EditContext, el: Element, opts: { enabled?: boolean; reduceNoise?: number; enhanceVoice?: number }) {
  requireAudio(el);
  assertUnlocked(ctx.draft, el);
  Object.assign(el.voiceEnhance, opts);
  if (opts.enabled === undefined && (opts.reduceNoise !== undefined || opts.enhanceVoice !== undefined)) el.voiceEnhance.enabled = true;
  ctx.touch(el.id);
}

export function setDucking(ctx: EditContext, el: Element, opts: { enabled?: boolean; amountDb?: number; attackSeconds?: number; releaseSeconds?: number }) {
  requireAudio(el);
  assertUnlocked(ctx.draft, el);
  Object.assign(el.ducking, opts);
  ctx.touch(el.id);
}

export function setFade(ctx: EditContext, el: Element, opts: { fadeInSeconds?: number; fadeOutSeconds?: number }) {
  requireAudio(el);
  assertUnlocked(ctx.draft, el);
  const fi = opts.fadeInSeconds ?? el.fadeInSeconds;
  const fo = opts.fadeOutSeconds ?? el.fadeOutSeconds;
  if (fi + fo > el.duration + EPS) throw new EditError("INVALID_RANGE", `Fades (${fi}s + ${fo}s) are longer than the element (${el.duration}s)`);
  el.fadeInSeconds = cleanTime(fi);
  el.fadeOutSeconds = cleanTime(fo);
  ctx.touch(el.id);
}
