/**
 * Global unit conventions.
 *
 * - Timeline time is float64 seconds; 0 = start of composition.
 * - Source asset timestamps are always named `*SourceSeconds`.
 * - Audio volume is a linear gain fraction in [0, 10] (1 = unity / 0 dB, 10 = +20 dB).
 */

/** Tolerance used for all time comparisons (1 microsecond). */
export const EPS = 1e-6;

/** Maximum linear gain (+20 dB). */
export const MAX_GAIN = 10;

/** Minimum element duration on the timeline (seconds). */
export const MIN_DURATION = 1 / 240;

export function approxEq(a: number, b: number, eps = EPS): boolean {
  return Math.abs(a - b) <= eps;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rounds away binary floating noise (nanosecond resolution) without changing meaningful precision. */
export function cleanTime(seconds: number): number {
  const r = Math.round(seconds * 1e9) / 1e9;
  return Object.is(r, -0) ? 0 : r;
}

/** Linear gain -> decibels. Gain 0 returns -Infinity. */
export function gainToDb(gain: number): number {
  if (gain <= 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(gain);
}

/** Decibels -> linear gain, clamped to [0, MAX_GAIN]. */
export function dbToGain(db: number): number {
  if (!Number.isFinite(db)) return db < 0 ? 0 : MAX_GAIN;
  return clamp(Math.pow(10, db / 20), 0, MAX_GAIN);
}

/** Nearest frame index for a time at a given frame rate. */
export function toFrame(seconds: number, fps: number): number {
  return Math.round(seconds * fps + 1e-9);
}

export function frameToSeconds(frame: number, fps: number): number {
  return cleanTime(frame / fps);
}

/** Snap a timeline time to the nearest project frame boundary. */
export function snapProjectFrame(seconds: number, fps: number): number {
  return frameToSeconds(toFrame(seconds, fps), fps);
}

/** Round a source time up to the next source frame boundary (no-op when already on a boundary). */
export function sourceFrameCeil(sourceSeconds: number, sourceFps: number): number {
  return cleanTime(Math.ceil(sourceSeconds * sourceFps - 1e-6) / sourceFps);
}

/** Duration of one frame at the given rate. */
export function frameDuration(fps: number): number {
  return 1 / fps;
}
