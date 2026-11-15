import type { Speed, SpeedPoint } from "./schema.js";
import { SPEED_PRESETS } from "./schema.js";
import { EPS, cleanTime } from "./units.js";

export type SpeedPreset = (typeof SPEED_PRESETS)[number];

/**
 * Speed ramp presets. Rate is piecewise-linear over the normalized source position.
 * These shapes are original to OpenEdits.
 */
export const SPEED_CURVE_PRESETS: Record<SpeedPreset, { name: string; description: string; points: SpeedPoint[] }> = {
  MONTAGE: {
    name: "Montage",
    description: "Alternating fast and slow beats for energetic sequences.",
    points: [
      { position: 0, rate: 1 },
      { position: 0.2, rate: 3 },
      { position: 0.4, rate: 0.6 },
      { position: 0.6, rate: 3 },
      { position: 0.8, rate: 0.6 },
      { position: 1, rate: 1 },
    ],
  },
  HERO: {
    name: "Hero",
    description: "Normal speed into a dramatic slow-motion moment, then back.",
    points: [
      { position: 0, rate: 1 },
      { position: 0.35, rate: 1 },
      { position: 0.45, rate: 0.3 },
      { position: 0.65, rate: 0.3 },
      { position: 0.75, rate: 1 },
      { position: 1, rate: 1 },
    ],
  },
  BULLET: {
    name: "Bullet",
    description: "Fast, then a sudden near-freeze at the midpoint, then fast again.",
    points: [
      { position: 0, rate: 2 },
      { position: 0.4, rate: 2 },
      { position: 0.5, rate: 0.2 },
      { position: 0.6, rate: 2 },
      { position: 1, rate: 2 },
    ],
  },
  JUMP_CUT: {
    name: "Jump Cut",
    description: "Short bursts of high speed that read like jump cuts.",
    points: [
      { position: 0, rate: 1 },
      { position: 0.24, rate: 1 },
      { position: 0.26, rate: 6 },
      { position: 0.44, rate: 6 },
      { position: 0.46, rate: 1 },
      { position: 0.7, rate: 1 },
      { position: 0.72, rate: 6 },
      { position: 1, rate: 6 },
    ],
  },
  FLASH_IN: {
    name: "Flash In",
    description: "Whips in fast and settles to normal speed.",
    points: [
      { position: 0, rate: 5 },
      { position: 0.3, rate: 5 },
      { position: 0.4, rate: 1 },
      { position: 1, rate: 1 },
    ],
  },
  FLASH_OUT: {
    name: "Flash Out",
    description: "Normal speed that accelerates out of the clip.",
    points: [
      { position: 0, rate: 1 },
      { position: 0.6, rate: 1 },
      { position: 0.7, rate: 5 },
      { position: 1, rate: 5 },
    ],
  },
  RAMP: {
    name: "Ramp",
    description: "Continuous acceleration from half speed to triple speed.",
    points: [
      { position: 0, rate: 0.5 },
      { position: 1, rate: 3 },
    ],
  },
  STROBE: {
    name: "Strobe",
    description: "Rapid pulses between normal and fast speed.",
    points: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((position, i) => ({ position, rate: i % 2 === 0 ? 1 : 4 })),
  },
};

export function normalizeSpeedPoints(points: SpeedPoint[]): SpeedPoint[] {
  const sorted = [...points].sort((a, b) => a.position - b.position);
  if (sorted[0].position > EPS) sorted.unshift({ position: 0, rate: sorted[0].rate });
  else sorted[0] = { ...sorted[0], position: 0 };
  const last = sorted[sorted.length - 1];
  if (last.position < 1 - EPS) sorted.push({ position: 1, rate: last.rate });
  else sorted[sorted.length - 1] = { ...last, position: 1 };
  return sorted;
}

/** ∫ dp / r(p) over a linear rate segment from rate a to rate b spanning `dp`. */
function segmentTime(a: number, b: number, dp: number): number {
  if (dp <= 0) return 0;
  if (Math.abs(b - a) < 1e-12) return dp / a;
  return (dp * Math.log(b / a)) / (b - a);
}

/** Normalized timeline time (in units of source span) for the whole curve: ∫0..1 dp / r(p). */
export function curveTimeIntegral(points: SpeedPoint[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += segmentTime(points[i].rate, points[i + 1].rate, points[i + 1].position - points[i].position);
  }
  return total;
}

/** Timeline duration for a source span played at `speed`. */
export function timelineDurationFor(sourceDurationSourceSeconds: number, speed: Speed): number {
  if (speed.mode === "constant") return cleanTime(sourceDurationSourceSeconds / speed.rate);
  return cleanTime(sourceDurationSourceSeconds * curveTimeIntegral(speed.points));
}

/** Rate at normalized source position p. */
export function rateAt(points: SpeedPoint[], p: number): number {
  if (p <= points[0].position) return points[0].rate;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (p <= b.position) {
      const span = b.position - a.position;
      if (span <= 0) return b.rate;
      return a.rate + ((b.rate - a.rate) * (p - a.position)) / span;
    }
  }
  return points[points.length - 1].rate;
}

/**
 * Map an element-local timeline offset to a normalized source position (0..1)
 * along the playback direction (before `reversed` is applied).
 */
export function sourcePositionAtTime(localSeconds: number, timelineDuration: number, speed: Speed): number {
  if (timelineDuration <= 0) return 0;
  const frac = Math.min(1, Math.max(0, localSeconds / timelineDuration));
  if (speed.mode === "constant") return frac;
  const pts = speed.points;
  const total = curveTimeIntegral(pts);
  let target = frac * total;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dp = b.position - a.position;
    const segT = segmentTime(a.rate, b.rate, dp);
    if (target <= segT + 1e-15 || i === pts.length - 2) {
      if (dp <= 0) return b.position;
      const ra = a.rate;
      const rb = b.rate;
      let u: number;
      if (Math.abs(rb - ra) < 1e-12) u = target * ra;
      else {
        // r(u) = ra * exp(target * (rb - ra) / dp);  u = (r(u) - ra) * dp / (rb - ra)
        const r = ra * Math.exp((target * (rb - ra)) / dp);
        u = ((r - ra) * dp) / (rb - ra);
      }
      return Math.min(1, Math.max(0, a.position + Math.min(dp, Math.max(0, u))));
    }
    target -= segT;
  }
  return 1;
}

/** Slice a curve to the normalized source range [p0, p1] and renormalize to 0..1. */
export function sliceSpeedPoints(points: SpeedPoint[], p0: number, p1: number): SpeedPoint[] {
  const span = p1 - p0;
  if (span <= EPS) return [
    { position: 0, rate: rateAt(points, p0) },
    { position: 1, rate: rateAt(points, p0) },
  ];
  const out: SpeedPoint[] = [{ position: 0, rate: rateAt(points, p0) }];
  for (const pt of points) {
    if (pt.position > p0 + EPS && pt.position < p1 - EPS) {
      out.push({ position: (pt.position - p0) / span, rate: pt.rate });
    }
  }
  out.push({ position: 1, rate: rateAt(points, p1) });
  return out;
}

/** Slice a speed definition to a sub-range of its source span. Constant speeds are unchanged. */
export function sliceSpeed(speed: Speed, p0: number, p1: number): Speed {
  if (speed.mode === "constant") return { ...speed };
  return { mode: "curve", preset: speed.preset, points: sliceSpeedPoints(speed.points, p0, p1) };
}
