import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { EditError } from "@openedits/core";
import { runFfmpeg } from "@openedits/engine";
import { defineTool } from "../defineTool.js";

const pending = new Map<string, Promise<void>>();
let queue = Promise.resolve();

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

export const thumbnailTools = [
  defineTool({
    name: "mediaThumbnail",
    title: "Media thumbnail",
    category: "project",
    description: "Create or retrieve a small cached source thumbnail for the library or timeline.",
    input: z.object({ mediaId: z.string(), sourceSeconds: z.number().nonnegative().optional() }),
    readOnly: true,
    handler: async (args, { host }) => {
      const media = host.project.media[args.mediaId];
      if (!media) throw new EditError("MEDIA_NOT_FOUND", `No media with id "${args.mediaId}"`);
      if (media.kind === "audio") throw new EditError("UNSUPPORTED_MEDIA", "Audio has no picture to thumbnail");
      const dir = path.join(host.projectDirPath, "cache", "thumbnails");
      const stat = await fs.stat(media.path).catch(() => { throw new EditError("FILE_NOT_FOUND", `Cannot read ${media.name}`); });
      const lastTime = Math.max(0, (media.durationSourceSeconds ?? 0) - 1 / (media.fps ?? 30));
      const sourceSeconds = media.kind === "image" ? 0 : Math.min(lastTime, Math.floor((args.sourceSeconds ?? 0) * 4) / 4);
      const key = createHash("sha256").update(JSON.stringify([media.path, stat.size, stat.mtimeMs, sourceSeconds])).digest("hex").slice(0, 24);
      const output = path.join(dir, `${key}.jpg`);
      if (!(await exists(output))) {
        let work = pending.get(output);
        if (!work) {
          const generate = async () => {
            if (await exists(output)) return;
            await fs.mkdir(dir, { recursive: true });
            const temp = path.join(dir, `.${key}-${randomUUID()}.part.jpg`);
            try {
              const capture = (at: number) => runFfmpeg([
                "-v", "error", "-threads", "1", "-filter_threads", "1", "-ss", String(at), "-i", media.path,
                "-map", "0:V:0", "-an", "-frames:v", "1", "-vf", "scale=160:96:force_original_aspect_ratio=decrease:force_divisible_by=2",
                "-threads", "1", "-q:v", "5", temp,
              ]);
              await capture(sourceSeconds);
              if (sourceSeconds > 0 && !(await exists(temp))) await capture(Math.max(0, sourceSeconds - 1));
              if (!(await exists(temp))) throw new EditError("UNSUPPORTED_MEDIA", `Could not read a thumbnail from ${media.name}`);
              await fs.rename(temp, output);
            } finally {
              await fs.rm(temp, { force: true });
            }
          };
          work = queue.then(generate).finally(() => pending.delete(output));
          pending.set(output, work);
          // Keep thumbnail decoding from competing with playback on low-power devices.
          queue = work.catch(() => {});
        }
        await work;
      }
      return { path: output };
    },
  }),
];
