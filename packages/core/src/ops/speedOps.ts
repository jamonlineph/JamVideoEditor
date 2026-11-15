import type { Element, SourcedElement, SpeedPoint } from "../schema.js";
import { EditError } from "../errors.js";
import { assertUnlocked, isOnMain } from "../timeline/query.js";
import { SPEED_CURVE_PRESETS, normalizeSpeedPoints, timelineDurationFor, type SpeedPreset } from "../speed.js";
import { scaleKeyframes } from "../keyframes.js";
import type { EditContext } from "./context.js";

function requireSourced(el: Element): asserts el is SourcedElement {
  if (el.type !== "video" && el.type !== "audio") throw new EditError("INVALID_ELEMENT_TYPE", `Speed applies to video or audio elements; ${el.id} is ${el.type}`);
}

function applyDurationChange(ctx: EditContext, el: SourcedElement) {
  const before = el.duration;
  el.duration = timelineDurationFor(el.sourceDurationSourceSeconds, el.speed);
  if (before > 0 && Math.abs(before - el.duration) > 1e-9) {
    el.keyframes = scaleKeyframes(el.keyframes, el.duration / before);
    el.fadeInSeconds = Math.min(el.fadeInSeconds, el.duration);
    el.fadeOutSeconds = Math.min(el.fadeOutSeconds, el.duration);
  }
  if (!isOnMain(ctx.draft, el)) ctx.positioned.add(el.id);
  ctx.touch(el.id);
}

export function setSpeed(ctx: EditContext, el: Element, rate: number) {
  requireSourced(el);
  assertUnlocked(ctx.draft, el);
  if (!(rate >= 0.1 && rate <= 100)) throw new EditError("INVALID_RANGE", "rate must be between 0.1 and 100");
  el.speed = { mode: "constant", rate };
  applyDurationChange(ctx, el);
}

export function setSpeedCurve(ctx: EditContext, el: Element, opts: { preset?: SpeedPreset; points?: SpeedPoint[] }) {
  requireSourced(el);
  assertUnlocked(ctx.draft, el);
  let points: SpeedPoint[];
  if (opts.points?.length) points = normalizeSpeedPoints(opts.points);
  else if (opts.preset) points = SPEED_CURVE_PRESETS[opts.preset].points.map((p) => ({ ...p }));
  else throw new EditError("INVALID_ARGUMENT", "Provide preset or points");
  el.speed = { mode: "curve", ...(opts.preset ? { preset: opts.preset } : {}), points };
  applyDurationChange(ctx, el);
}

export function setReversed(ctx: EditContext, el: Element, reversed: boolean) {
  requireSourced(el);
  assertUnlocked(ctx.draft, el);
  el.reversed = reversed;
  // The renderer decodes reversed clips in chunks, so no transcode is needed.
  if (el.type === "video") el.reverseStatus = reversed ? "ready" : "none";
  ctx.touch(el.id);
}
