import fs from "node:fs";
import { spawn } from "node:child_process";
import type { MediaAsset } from "@openedits/core";

const FFMPEG = process.env.OPENEDITS_FFMPEG ?? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((p) => fs.existsSync(p)) ?? "ffmpeg";

/**
 * Small still frames of media files (timeline filmstrips, the media grid), decoded with FFmpeg and
 * kept as object URLs. Requests are queued so a long timeline never starts dozens of decoders at once.
 */
const cache = new Map<string, Promise<string | null>>();
const queue: (() => void)[] = [];
let running = 0;
const MAX_RUNNING = 3;

function next() {
  while (running < MAX_RUNNING && queue.length) {
    running++;
    queue.shift()!();
  }
}

function decode(file: string, seconds: number, height: number): Promise<string | null> {
  return new Promise((resolve) => {
    queue.push(() => {
      const args = ["-v", "error", "-nostdin"];
      if (seconds > 0) args.push("-ss", seconds.toFixed(3));
      args.push("-i", file, "-frames:v", "1", "-vf", `scale=-2:${height}`, "-q:v", "6", "-f", "image2pipe", "-c:v", "mjpeg", "-");
      const chunks: Uint8Array[] = [];
      let settled = false;
      const done = (url: string | null) => {
        if (settled) return;
        settled = true;
        running--;
        next();
        resolve(url);
      };
      try {
        const proc = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "ignore"] });
        proc.stdout!.on("data", (d: Uint8Array) => chunks.push(new Uint8Array(d)));
        proc.on("error", () => done(null));
        proc.on("close", () => {
          const size = chunks.reduce((n, c) => n + c.length, 0);
          if (!size) return done(null);
          done(URL.createObjectURL(new Blob(chunks as BlobPart[], { type: "image/jpeg" })));
        });
      } catch {
        done(null);
      }
    });
    next();
  });
}

/** A frame of `media` near `seconds` (rounded so nearby requests share one decode). */
export function mediaFrame(media: Pick<MediaAsset, "id" | "path" | "kind" | "durationSourceSeconds">, seconds: number, height = 96): Promise<string | null> {
  if (media.kind === "audio") return Promise.resolve(null);
  const step = media.kind === "image" ? Infinity : 0.5;
  const t = media.kind === "image" ? 0 : Math.max(0, Math.min(Math.round(seconds / step) * step, Math.max(0, (media.durationSourceSeconds ?? 0) - 0.1)));
  const key = `${media.id}@${t}@${height}`;
  let p = cache.get(key);
  if (!p) {
    p = decode(media.path, t, height);
    cache.set(key, p);
    void p.then((url) => url === null && cache.delete(key));
  }
  return p;
}
