import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EditError, type EditingProxy, type MediaAsset, type Project } from "@openedits/core";
import { runFfmpeg } from "../ffmpeg.js";
import type { EngineHost } from "../host.js";

export const PROXY_JOB_KIND = "editing-proxies";
const PROXY_LONG_SIDE = 960;
const PROXY_CODECS = new Set(["h264", "hevc", "av1", "mpeg4", "mpeg2video"]);
const isProxy = (name: string) => /^[\da-f]{32}\.mp4$/.test(name);
const isPreview = (name: string) => /^preview-[\da-z]+\.mp4$/.test(name);
const isThumbnail = (name: string) => /^[\da-f]+\.jpg$/.test(name);

type CacheScope = "proxies" | "previews" | "all";
type ProxyPlan = EditingProxy & { source: string; name: string; gop: number };

function proxyPlan(media: MediaAsset, dir: string): ProxyPlan | undefined {
  // Restrict the proxy path to formats that can safely be represented as ordinary SDR H.264.
  if (media.kind !== "video" || !media.width || !media.height || !PROXY_CODECS.has(media.videoCodec ?? "")) return;
  if (media.colorTransfer === "smpte2084" || media.colorTransfer === "arib-std-b67") return;
  const stat = fs.statSync(media.path, { throwIfNoEntry: false });
  if (!stat?.isFile()) return;
  const scale = Math.min(1, PROXY_LONG_SIDE / Math.max(media.width, media.height));
  const width = Math.max(2, Math.round((media.width * scale) / 2) * 2);
  const height = Math.max(2, Math.round((media.height * scale) / 2) * 2);
  const gop = Math.max(1, Math.min(120, Math.round((media.fps ?? 30) / 2)));
  const key = createHash("sha256").update(JSON.stringify(["v1", media.path, stat.size, stat.mtimeMs, width, height, gop])).digest("hex").slice(0, 32);
  return { path: path.join(dir, `${key}.mp4`), width, height, source: media.path, name: media.name, gop };
}

function proxyPlans(project: Project, dir: string) {
  const masks = new Set(Object.values(project.elements).flatMap((element) =>
    "effects" in element ? element.effects.flatMap((effect) => effect.subjectMaskId ? [effect.subjectMaskId] : []) : []));
  const plans = new Map<string, ProxyPlan>();
  for (const media of Object.values(project.media)) {
    if (masks.has(media.id)) continue;
    const plan = proxyPlan(media, dir);
    if (plan) plans.set(media.id, plan);
  }
  return plans;
}

function entries(dir: string, matches: (name: string) => boolean) {
  const files: { path: string; bytes: number }[] = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !matches(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat) files.push({ path: file, bytes: stat.size });
  }
  return files;
}

export function editingCacheStatus(host: EngineHost) {
  const root = path.join(host.projectDirPath, "cache");
  const dir = path.join(root, "proxies");
  const files = entries(dir, isProxy);
  const ready = new Set(files.filter((file) => file.bytes > 0).map((file) => file.path));
  const plans = proxyPlans(host.project, dir);
  const proxies: Record<string, EditingProxy> = {};
  for (const [id, plan] of plans) {
    if (ready.has(plan.path)) proxies[id] = { path: plan.path, width: plan.width, height: plan.height };
  }
  const bytes = (items: { bytes: number }[]) => items.reduce((total, item) => total + item.bytes, 0);
  return {
    projectId: host.projectId,
    proxies,
    eligibleVideos: plans.size,
    proxyBytes: bytes(files),
    previewBytes: bytes(entries(path.join(root, "previews"), isPreview)),
    thumbnailBytes: bytes(entries(path.join(root, "thumbnails"), isThumbnail)),
  };
}

export function clearEditingCache(host: EngineHost, scope: CacheScope) {
  const root = path.join(host.projectDirPath, "cache");
  const candidates = [];
  if (scope !== "previews") {
    if (host.jobs.latest(PROXY_JOB_KIND, host.projectId)?.status === "running") {
      throw new EditError("INVALID_ARGUMENT", "Wait for proxy generation to finish or cancel it before clearing proxies");
    }
    candidates.push(...entries(path.join(root, "proxies"), isProxy));
  }
  if (scope !== "proxies") {
    if (host.jobs.list("preview").some((job) => job.projectId === host.projectId && job.status === "running")) {
      throw new EditError("INVALID_ARGUMENT", "Wait for preview renders to finish before clearing previews");
    }
    candidates.push(...entries(path.join(root, "previews"), isPreview), ...entries(path.join(root, "thumbnails"), isThumbnail));
  }
  for (const file of candidates) fs.rmSync(file.path, { force: true });
  return { ...editingCacheStatus(host), removedBytes: candidates.reduce((total, file) => total + file.bytes, 0) };
}

export function generateEditingProxies(host: EngineHost, mediaIds?: string[]) {
  const projectId = host.projectId;
  const active = host.jobs.list(PROXY_JOB_KIND).find((job) => job.status === "running");
  if (active) {
    if (active.projectId === projectId) return active;
    throw new EditError("INVALID_ARGUMENT", "Editing proxies are already being generated for another project");
  }
  const dir = path.join(host.projectDirPath, "cache", "proxies");
  const all = proxyPlans(host.project, dir);
  const requested = mediaIds ? [...new Set(mediaIds)] : [...all.keys()];
  const eligible = requested.flatMap((id) => {
    const plan = all.get(id);
    return plan ? [plan] : [];
  });
  if (!eligible.length) throw new EditError("INVALID_ARGUMENT", "No eligible SDR videos are available to create editing proxies");
  return host.jobs.start(PROXY_JOB_KIND, async (job) => {
    fs.mkdirSync(dir, { recursive: true });
    let ready = 0;
    const warnings: string[] = [];
    for (const [index, plan] of eligible.entries()) {
      job.signal.throwIfAborted();
      job.progress(index / eligible.length, `Processing ${plan.name} (${index + 1}/${eligible.length})`);
      if ((fs.statSync(plan.path, { throwIfNoEntry: false })?.size ?? 0) > 0) {
        ready++;
        continue;
      }
      const temp = path.join(dir, `.${randomUUID()}.part.mp4`);
      try {
        await runFfmpeg([
          "-v", "error", "-y", "-copyts", "-start_at_zero", "-i", plan.source, "-map", "0:V:0", "-an", "-sn", "-dn",
          "-vf", `scale=${plan.width}:${plan.height}:flags=bilinear`, "-fps_mode", "passthrough",
          "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p", "-threads", "2", "-g", String(plan.gop),
          "-enc_time_base", "1:1000000", "-video_track_timescale", "1000000", temp,
        ], { signal: job.signal });
        job.signal.throwIfAborted();
        fs.renameSync(temp, plan.path);
        ready++;
      } catch (error) {
        job.signal.throwIfAborted();
        warnings.push(`${plan.name}: ${(error as Error).message}`);
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }
    if (!ready && warnings.length) throw new EditError("INTERNAL", warnings[0]);
    return { ready, warnings };
  }, { projectId });
}
