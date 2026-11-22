import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppHarness } from "../apps/desktop/test/harness.js";

const [, , appPath, resources] = process.argv;
assert(appPath && resources, "Usage: smoke-packaged-app.ts <app executable> <resources directory>");

const suffix = process.platform === "win32" ? ".exe" : "";
const ffmpeg = path.resolve(resources, "vendor", `ffmpeg${suffix}`);
const ffprobe = path.resolve(resources, "vendor", `ffprobe${suffix}`);
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "openedits-packaged-"));
let app: AppHarness | undefined;

try {
  const clip = path.join(workspace, "input.mp4");
  execFileSync(ffmpeg, [
    "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", clip,
  ], { timeout: 30_000 });

  app = await AppHarness.launch(workspace, path.resolve(appPath));
  await app.waitFor('document.querySelector(".home") && window.openedits.live.state.connected');
  await app.call("newProject", { name: "Packaged smoke test", canvas: { aspectRatio: "16:9" } });
  const { addedIds } = await app.call<{ addedIds: string[] }>("importToMediaPanel", { paths: [clip] });
  assert.equal(addedIds.length, 1);
  await app.call("addMedia", { mediaId: addedIds[0] });
  await app.waitFor('!!document.querySelector(".lane.main .clip")');

  const job = await app.call<{ status: string; output?: { path: string }; error?: { message: string } }>(
    "export", { preset: "fast-720p", waitSeconds: 60 },
  );
  assert(job.status === "done" && job.output, job.error?.message ?? `Unexpected export status: ${job.status}`);
  const video = JSON.parse(execFileSync(ffprobe, [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,nb_frames",
    "-of", "json", job.output.path,
  ], { encoding: "utf8", timeout: 30_000 })).streams[0];
  assert.deepEqual(video, { codec_name: "h264", width: 1280, height: 720, nb_frames: "30" });
  console.log("Packaged app launched, imported a clip, and exported a valid H.264 video.");
} finally {
  await app?.quit();
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
