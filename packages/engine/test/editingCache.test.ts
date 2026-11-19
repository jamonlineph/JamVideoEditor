import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { clearEditingCache, editingCacheStatus, EngineHost, generateEditingProxies } from "../src/index.js";
import { tempWorkspace } from "./media.js";

function timestamps(file: string) {
  const probe = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time",
    "-of", "json", file,
  ], { encoding: "utf8" });
  return JSON.parse(probe).frames.map((frame: { best_effort_timestamp_time: string }) => Number(frame.best_effort_timestamp_time));
}

it("generates timestamp-preserving proxies and clears only the requested generated files", async () => {
  const workspace = tempWorkspace("editing-cache");
  const host = EngineHost.create({ workspaceRoot: workspace, restoreLastProject: false });
  try {
    const source = path.join(workspace, "camera.mp4");
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=10:duration=2",
      "-vf", "select='lt(n,3)+eq(n,15)+eq(n,16)'", "-fps_mode", "passthrough",
      "-c:v", "libx264", "-preset", "ultrafast", source,
    ]);
    host.newProject({ name: "Camera footage" });
    const { assets: [{ id }] } = await host.importMedia([source]);
    const job = generateEditingProxies(host, [id]);
    expect((await host.jobs.wait(job.id, 10000)).status).toBe("done");
    const cache = editingCacheStatus(host);
    expect(cache.proxies[id]).toMatchObject({ width: 960, height: 540 });
    expect(timestamps(cache.proxies[id].path)).toEqual(timestamps(source));

    const previews = path.join(host.projectDirPath, "cache", "previews");
    const thumbnails = path.join(host.projectDirPath, "cache", "thumbnails");
    fs.mkdirSync(previews, { recursive: true });
    fs.mkdirSync(thumbnails, { recursive: true });
    fs.writeFileSync(path.join(previews, "preview-test.mp4"), Buffer.alloc(5));
    fs.writeFileSync(path.join(thumbnails, "ca0e.jpg"), Buffer.alloc(10));
    fs.writeFileSync(path.join(previews, "original.mp4"), Buffer.alloc(20));
    expect(editingCacheStatus(host)).toMatchObject({ previewBytes: 5, thumbnailBytes: 10 });
    expect(clearEditingCache(host, "previews")).toMatchObject({
      previewBytes: 0, thumbnailBytes: 0, proxyBytes: cache.proxyBytes, removedBytes: 15,
    });
    expect(clearEditingCache(host, "proxies")).toMatchObject({ proxyBytes: 0, proxies: {}, removedBytes: cache.proxyBytes });
    expect(fs.existsSync(path.join(previews, "original.mp4"))).toBe(true);
    expect(fs.existsSync(source)).toBe(true);
  } finally {
    host.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
