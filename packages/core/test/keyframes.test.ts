import { describe, expect, it } from "vitest";
import {
  applyEasing,
  cubicBezier,
  curveTimeIntegral,
  evaluateKeyframes,
  sourcePositionAtTime,
  splitKeyframes,
  timelineDurationFor,
  SPEED_CURVE_PRESETS,
  rateAt,
  type Keyframe,
} from "../src/index.js";

describe("easing", () => {
  it("cubic bezier endpoints and symmetry", () => {
    expect(cubicBezier(0.42, 0, 0.58, 1, 0)).toBe(0);
    expect(cubicBezier(0.42, 0, 0.58, 1, 1)).toBe(1);
    expect(cubicBezier(0.42, 0, 0.58, 1, 0.5)).toBeCloseTo(0.5, 5);
    expect(applyEasing({ type: "easeIn" }, 0.25)).toBeLessThan(0.25);
    expect(applyEasing({ type: "easeOut" }, 0.25)).toBeGreaterThan(0.25);
    expect(applyEasing({ type: "hold" }, 0.9)).toBe(0);
    expect(applyEasing({ type: "cubicBezier", bezier: [0, 0, 1, 1] }, 0.3)).toBeCloseTo(0.3, 5);
  });
});

describe("keyframes", () => {
  const kfs: Keyframe[] = [
    { offsetSeconds: 0, value: 0, easing: { type: "linear" } },
    { offsetSeconds: 2, value: 10, easing: { type: "easeInOut" } },
    { offsetSeconds: 4, value: 0, easing: { type: "linear" } },
  ];

  it("evaluates with clamping and easing", () => {
    expect(evaluateKeyframes(kfs, -1, 5)).toBe(0);
    expect(evaluateKeyframes(kfs, 1, 5)).toBeCloseTo(5);
    expect(evaluateKeyframes(kfs, 3, 5)).toBeCloseTo(5, 4);
    expect(evaluateKeyframes(kfs, 9, 5)).toBe(0);
    expect(evaluateKeyframes([], 1, 7)).toBe(7);
  });

  it("splitting preserves the animation", () => {
    const { left, right } = splitKeyframes(kfs, 1, 0);
    for (const t of [0, 0.25, 0.5, 0.99, 1]) expect(evaluateKeyframes(left, t, 0)).toBeCloseTo(evaluateKeyframes(kfs, t, 0), 6);
    for (const t of [1, 2, 4, 5]) expect(evaluateKeyframes(right, t - 1, 0)).toBeCloseTo(evaluateKeyframes(kfs, t, 0), 6);
    // linear segment is exact everywhere
    expect(evaluateKeyframes(right, 0.5, 0)).toBeCloseTo(evaluateKeyframes(kfs, 1.5, 0), 6);
  });
});

describe("speed curves", () => {
  it("constant speed duration", () => {
    expect(timelineDurationFor(10, { mode: "constant", rate: 2 })).toBe(5);
    expect(timelineDurationFor(10, { mode: "constant", rate: 0.5 })).toBe(20);
  });

  it("curve integral matches numeric integration", () => {
    for (const preset of Object.values(SPEED_CURVE_PRESETS)) {
      const n = 200_000;
      let sum = 0;
      for (let i = 0; i < n; i++) sum += 1 / rateAt(preset.points, (i + 0.5) / n) / n;
      expect(curveTimeIntegral(preset.points)).toBeCloseTo(sum, 5);
    }
  });

  it("time -> source mapping is monotonic and consistent with the integral", () => {
    const speed = { mode: "curve" as const, points: SPEED_CURVE_PRESETS.HERO.points };
    const dur = timelineDurationFor(10, speed);
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const p = sourcePositionAtTime((dur * i) / 100, dur, speed);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = p;
    }
    expect(sourcePositionAtTime(0, dur, speed)).toBe(0);
    expect(sourcePositionAtTime(dur, dur, speed)).toBeCloseTo(1, 9);
    // Time to reach p equals the partial integral.
    const p = sourcePositionAtTime(dur / 3, dur, speed);
    const n = 100_000;
    let t = 0;
    for (let i = 0; i < n; i++) t += (p / n) / rateAt(speed.points, ((i + 0.5) / n) * p);
    expect(t * 10).toBeCloseTo(dur / 3, 4);
  });
});
