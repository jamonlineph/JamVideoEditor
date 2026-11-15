import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { EditError, type MediaAsset } from "@openedits/core";

const execFileAsync = promisify(execFile);

export const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mts", ".m2ts", ".3gp", ".hevc", ".mxf"]);
export const AUDIO_EXTS = new Set([".mp3", ".m4a", ".aac", ".wav", ".aif", ".aiff", ".flac", ".ogg", ".opus", ".caf"]);
export const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".heic", ".heif", ".webp", ".gif", ".tif", ".tiff", ".bmp"]);

export function mediaKindFromExt(file: string): MediaAsset["kind"] | undefined {
  const ext = path.extname(file).toLowerCase();
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (IMAGE_EXTS.has(ext)) return "image";
  return undefined;
}

export interface ProbeResult {
  kind: MediaAsset["kind"];
  durationSourceSeconds?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
  sampleRate?: number;
  sizeBytes: number;
  createdAt?: number;
  colorSpace?: string;
  colorTransfer?: string;
  videoStartSourceSeconds?: number;
}

interface FfStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
  duration?: string;
  nb_frames?: string;
  color_space?: string;
  color_transfer?: string;
  start_time?: string;
  disposition?: { attached_pic?: number };
  side_data_list?: { rotation?: number }[];
  tags?: { rotate?: string };
}

function parseRate(r?: string): number | undefined {
  if (!r || r === "0/0") return undefined;
  const [n, d] = r.split("/").map(Number);
  if (!d) return n || undefined;
  const v = n / d;
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : undefined;
}

export type Prober = (file: string) => Promise<ProbeResult>;

/** Probe a media file with ffprobe. */
export function createFfprobe(ffprobePath = process.env.OPENEDITS_FFPROBE ?? "ffprobe"): Prober {
  return async (file) => {
    if (!fs.existsSync(file)) throw new EditError("FILE_NOT_FOUND", `File not found: ${file}`, { path: file });
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new EditError("FILE_NOT_FOUND", `Not a file: ${file}`, { path: file });
    let json: { streams?: FfStream[]; format?: { duration?: string; format_name?: string; tags?: { creation_time?: string } } };
    try {
      const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { maxBuffer: 16 * 1024 * 1024 });
      json = JSON.parse(stdout);
    } catch (e) {
      throw new EditError("PROBE_FAILED", `ffprobe could not read ${path.basename(file)}: ${(e as Error).message.split("\n")[0]}`, { path: file });
    }
    const streams = json.streams ?? [];
    const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
    const a = streams.find((s) => s.codec_type === "audio");
    const formatName = json.format?.format_name ?? "";
    const extKind = mediaKindFromExt(file);
    const isImage =
      extKind === "image" ||
      /image2|_pipe|png|jpeg|webp_pipe|tiff/.test(formatName) && !a && (!json.format?.duration || Number(v?.nb_frames ?? 1) <= 1);
    if (!v && !a) throw new EditError("UNSUPPORTED_MEDIA", `${path.basename(file)} has no audio or video streams`, { path: file });
    let width = v?.width;
    let height = v?.height;
    const rotation = Math.abs(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? Number(v?.tags?.rotate ?? 0)) % 180;
    if (rotation === 90 && width && height) [width, height] = [height, width];
    const duration = Number(json.format?.duration ?? v?.duration ?? a?.duration);
    const created = json.format?.tags?.creation_time ? Date.parse(json.format.tags.creation_time) : undefined;
    const kind: MediaAsset["kind"] = isImage ? "image" : v ? "video" : "audio";
    return {
      kind,
      ...(kind !== "image" && Number.isFinite(duration) && duration > 0 ? { durationSourceSeconds: duration } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(kind === "video" ? { fps: parseRate(v?.avg_frame_rate) ?? parseRate(v?.r_frame_rate) } : {}),
      hasVideo: !!v,
      hasAudio: !!a,
      ...(v?.codec_name ? { videoCodec: v.codec_name } : {}),
      ...(a?.codec_name ? { audioCodec: a.codec_name } : {}),
      ...(a?.channels ? { audioChannels: a.channels } : {}),
      ...(a?.sample_rate ? { sampleRate: Number(a.sample_rate) } : {}),
      sizeBytes: stat.size,
      ...(created && Number.isFinite(created) ? { createdAt: created } : {}),
      ...(v?.color_space && v.color_space !== "unknown" ? { colorSpace: v.color_space } : {}),
      ...(v?.color_transfer && v.color_transfer !== "unknown" ? { colorTransfer: v.color_transfer } : {}),
      ...(kind === "video" && Number(v?.start_time) > 0 ? { videoStartSourceSeconds: Number(v!.start_time) } : {}),
    };
  };
}
