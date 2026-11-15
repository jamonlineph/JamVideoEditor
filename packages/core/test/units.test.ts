import { describe, expect, it } from "vitest";
import {
  canvasPixelSize,
  centerCropToAspect,
  dbToGain,
  gainToDb,
  mediaElementPixelRect,
  snapProjectFrame,
  sourceFrameCeil,
  toFrame,
  defaultTransform,
  parseHex,
  toHex,
  HexColor,
} from "../src/index.js";

describe("units", () => {
  it("converts gain and dB (10x = +20 dB)", () => {
    expect(gainToDb(1)).toBeCloseTo(0);
    expect(gainToDb(10)).toBeCloseTo(20);
    expect(gainToDb(0)).toBe(-Infinity);
    expect(dbToGain(20)).toBeCloseTo(10);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
    expect(dbToGain(40)).toBe(10);
  });

  it("snaps to frames", () => {
    expect(toFrame(1.0166, 30)).toBe(30);
    expect(snapProjectFrame(1.02, 30)).toBeCloseTo(1.0333333, 6);
    expect(sourceFrameCeil(1.01, 24)).toBeCloseTo(25 / 24, 9);
    expect(sourceFrameCeil(1, 24)).toBe(1);
  });

  it("validates colors", () => {
    expect(HexColor.parse("#ff00aa")).toBe("#ff00aa");
    expect(() => HexColor.parse("red")).toThrow();
    expect(parseHex("#FF000080").a).toBeCloseTo(0.5, 2);
    expect(toHex({ r: 255, g: 0, b: 0, a: 1 })).toBe("#FF0000");
  });
});

describe("canvas", () => {
  it("derives pixel sizes from aspect and short-side resolution", () => {
    expect(canvasPixelSize({ aspectRatio: "9:16", resolution: "1080p" })).toEqual({ width: 1080, height: 1920 });
    expect(canvasPixelSize({ aspectRatio: "16:9", resolution: "1080p" })).toEqual({ width: 1920, height: 1080 });
    expect(canvasPixelSize({ aspectRatio: "4:5", resolution: "1080p" })).toEqual({ width: 1080, height: 1350 });
    expect(canvasPixelSize({ aspectRatio: "1:1", resolution: "4K" })).toEqual({ width: 2160, height: 2160 });
  });

  it("preserves normalized placement across aspect/resolution changes", () => {
    const t = defaultTransform({ x: 0.25, y: 0.8, scale: 0.5, fit: "contain" });
    const media = { width: 1920, height: 1080 };
    for (const aspectRatio of ["9:16", "16:9", "1:1", "4:5"] as const) {
      for (const resolution of ["720p", "1080p", "4K"] as const) {
        const c = canvasPixelSize({ aspectRatio, resolution });
        const r = mediaElementPixelRect({ aspectRatio, resolution }, t, media);
        expect(r.cx / c.width).toBeCloseTo(0.25, 9);
        expect(r.cy / c.height).toBeCloseTo(0.8, 9);
        // contain at scale 0.5 => element fits within half the canvas in at least one axis
        expect(Math.max(r.width / c.width, r.height / c.height)).toBeCloseTo(0.5, 9);
      }
    }
  });

  it("center-crops to a target aspect", () => {
    const crop = centerCropToAspect({ width: 1920, height: 1080 }, 1);
    expect(crop.left).toBeCloseTo((1 - 1080 / 1920) / 2, 9);
    expect(crop.top).toBe(0);
  });
});
