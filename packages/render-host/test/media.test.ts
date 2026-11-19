import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RenderContext } from "@openedits/core";
import type { Compositor } from "@openedits/renderer";
import { VideoReader } from "../src/media.js";

const W = 64;
const H = 48;
const frameBytes = W * H * 4;
let dir: string;
let file: string;
let delayed: string;
let reference: Buffer;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "openedits-vfr-"));
  file = path.join(dir, "vfr.mp4");
  delayed = path.join(dir, "delayed.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", `testsrc2=size=${W}x${H}:rate=10:duration=2`,
    "-vf", "select='lt(n,3)+eq(n,15)+eq(n,16)'", "-fps_mode", "passthrough",
    "-c:v", "libx264", "-preset", "ultrafast", file,
  ]);
  reference = execFileSync("ffmpeg", [
    "-v", "error", "-i", file, "-fps_mode", "passthrough", "-pix_fmt", "rgba", "-f", "rawvideo", "-",
  ]);
  execFileSync("ffmpeg", ["-v", "error", "-copyts", "-itsoffset", "1", "-i", file, "-c", "copy", delayed]);
});

afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

function sampleReader(file: string, proxy = false) {
  let uploaded: Uint8Array | undefined;
  const texture = {};
  const compositor = {
    uploadPixels(_: unknown, pixels: Uint8Array) {
      uploaded = pixels;
      return texture;
    },
    deleteTexture() {},
  } as unknown as Compositor;
  const reader = new VideoReader(compositor, { ffmpeg: "ffmpeg", hwaccel: false } as RenderContext,
    { path: file, kind: "video", width: W, height: H, fps: 10, fpsExpr: "10",
      ...(proxy ? { editingProxy: { path: file, width: W, height: H } } : {}) }, W, H);
  const frame = async (time: number, index: number, before = false) => {
    expect(await reader.textureAt(time, before)).toBe(texture);
    expect(uploaded && Buffer.from(uploaded).equals(reference.subarray(index * frameBytes, (index + 1) * frameBytes))).toBe(true);
  };
  return { reader, frame };
}

describe("presentation-timestamp frame selection", () => {
  it("holds a frame through a VFR gap when seeking and playing in either direction", async () => {
    const { reader, frame } = sampleReader(file);
    try {
      await frame(1.2, 2);
      await frame(1.4, 2);
      await frame(1.5, 3);
      await frame(1.6, 4);
      await frame(1.5, 2, true);
      await frame(0.1, 0, true);
      await frame(0.1, 1);
    } finally {
      reader.dispose();
    }
  });

  it("preserves a video-only proxy's offset in the original file timeline", async () => {
    const { reader, frame } = sampleReader(delayed, true);
    try {
      await frame(1.4, 2);
      await frame(1.0, 0);
      await frame(2.5, 3);
    } finally {
      reader.dispose();
    }
  });
});
