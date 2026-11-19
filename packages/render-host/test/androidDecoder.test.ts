import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProject, sequentialIds, type MediaLayer } from "@openedits/core";
import type { Compositor } from "@openedits/renderer";
import { MediaManager } from "../src/media.js";

const fallback = vi.hoisted(() => ({ command: "", attempts: 0 }));
vi.mock("node:child_process", async (original) => {
  const child = await original<typeof import("node:child_process")>();
  return {
    ...child,
    spawn(file: string, args: string[], opts: Parameters<typeof spawn>[2]) {
      if (args.includes("h264_mediacodec")) {
        fallback.attempts++;
        return child.spawn(process.execPath, ["-e", fallback.command], opts);
      }
      return child.spawn(file, args, opts);
    },
  };
});

let dir: string;
let file: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "openedits-mediacodec-"));
  file = path.join(dir, "sample.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=10:duration=1", "-c:v", "libx264", file]);
});

afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

describe("experimental Android preview decoder", () => {
  it.each(["process.exit(1)", "setInterval(() => {}, 1000)"])("falls back if the decoder fails or stalls (%s)", async (command) => {
    fallback.command = command;
    fallback.attempts = 0;
    const texture = {};
    const compositor = { uploadPixels: () => texture, deleteTexture() {} } as unknown as Compositor;
    const media = new MediaManager(compositor, { downsizeReaders: true });
    const project = createProject({ id: "test", name: "Test", now: 0, ids: sequentialIds() });
    const layer = { kind: "media", mediaId: "source", mediaKind: "video", elementId: "clip", width: 64, height: 48, crop: { left: 0, right: 0, top: 0, bottom: 0 }, sourceSeconds: 0, subjectMasks: [] } as MediaLayer;
    media.use({
      project, ffmpeg: "ffmpeg", hwaccel: false, luts: {},
      media: { source: { path: file, kind: "video", width: 64, height: 48, videoCodec: "h264", fpsExpr: "10", fps: 10 } },
    });
    try {
      expect(await media.prepare([layer])).toEqual([]);
      expect(fallback.attempts).toBe(0);
      media.setAndroidMediaCodec(true);
      expect(await media.prepare([layer])).toEqual([]);
      expect(media.media(layer)).toBe(texture);
      expect(fallback.attempts).toBe(1);
      expect(await media.prepare([{ ...layer, sourceSeconds: 0.1 }])).toEqual([]);
      expect(fallback.attempts).toBe(1);
    } finally {
      media.reset();
    }
  });
});
