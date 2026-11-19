import { describe, expect, it } from "vitest";
import { AdaptivePreviewQuality } from "../src/ui/adaptiveQuality.js";

describe("adaptive preview quality", () => {
  it("steps down after sustained render or scheduling delays and stops at Draft size", () => {
    const quality = new AdaptivePreviewQuality();
    for (let i = 0; i < 16; i++) quality.observe(42, 1000 / 30, false);
    expect(quality.shortSide).toBe(540);
    for (let i = 0; i < 30; i++) quality.observe(5, 1000 / 30, true);
    expect(quality.shortSide).toBe(360);
  });

  it("ignores occasional slow frames and cautiously recovers when rendering speeds up", () => {
    const quality = new AdaptivePreviewQuality();
    for (let i = 0; i < 32; i++) quality.observe(i % 8 === 0 ? 100 : 5, 33, false);
    expect(quality.shortSide).toBe(720);
    for (let i = 0; i < 16; i++) quality.observe(40, 33, false);
    expect(quality.shortSide).toBe(540);
    for (let i = 0; i < 239; i++) quality.observe(5, 33, false);
    expect(quality.shortSide).toBe(540);
    quality.observe(5, 33, false);
    expect(quality.shortSide).toBe(630);
  });

  it("honors a manual size and a viewport smaller than Draft", () => {
    const quality = new AdaptivePreviewQuality();
    quality.configure(1080, false);
    for (let i = 0; i < 100; i++) quality.observe(100, 16, true);
    expect(quality.shortSide).toBe(1080);
    quality.configure(270, true);
    for (let i = 0; i < 100; i++) quality.observe(100, 16, true);
    expect(quality.shortSide).toBe(270);
  });
});
