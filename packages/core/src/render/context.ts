import type { MediaAsset, Project } from "../schema.js";
import { isBuiltinLut } from "./luts.js";

/** What a compositor host needs to read each media file the project draws. */
export interface MediaRenderInfo {
  path: string;
  kind: "video" | "image";
  width: number;
  height: number;
  /** ffmpeg frame-rate expression, e.g. "30" or "30000/1001". */
  fpsExpr: string;
  fps: number;
  videoCodec?: string;
  colorTransfer?: string;
  /** Force a YUV->RGB matrix when the file is untagged (e.g. "bt709"). */
  inColorMatrix?: string;
  editingProxy?: EditingProxy;
}

export type EditingProxy = Pick<MediaRenderInfo, "path" | "width" | "height">;

export interface RenderContext {
  project: Project;
  media: Record<string, MediaRenderInfo>;
  /** LUT key (cubePath or catalog id) -> .cube file path. */
  luts: Record<string, string>;
  ffmpeg: string;
  hideCaptions?: boolean;
  hwaccel?: boolean;
}

/** Common broadcast rates as exact rationals so long clips do not drift. */
export function fpsExpression(fps: number | undefined): { expr: string; value: number } {
  if (!fps || !Number.isFinite(fps)) return { expr: "30", value: 30 };
  for (const base of [24, 30, 48, 60, 120]) {
    if (Math.abs(fps - (base * 1000) / 1001) < 0.02) return { expr: `${base * 1000}/1001`, value: (base * 1000) / 1001 };
  }
  const rounded = Math.round(fps * 1000) / 1000;
  return { expr: String(rounded), value: rounded };
}

/** Media, LUTs and warnings for drawing a project (shared by the export host and the desktop preview). */
export function renderContextFor(project: Project, opts: { ffmpeg: string; hideCaptions?: boolean; hwaccel?: boolean; editingProxies?: Record<string, EditingProxy> }): { ctx: RenderContext; warnings: string[] } {
  const media: Record<string, MediaRenderInfo> = {};
  const warnings: string[] = [];
  const used = new Set<string>();
  const luts: Record<string, string> = {};
  for (const el of Object.values(project.elements)) {
    if (el.type === "video" || el.type === "image") used.add(el.mediaId);
    if (el.type === "sticker" && el.cutoutMaskId) used.add(el.cutoutMaskId);
    if ("effects" in el) for (const fx of el.effects) if (fx.subjectMaskId) used.add(fx.subjectMaskId);
    if ("color" in el && el.color.lut) {
      if (el.color.lut.cubePath) luts[el.color.lut.cubePath] = el.color.lut.cubePath;
      else if (!isBuiltinLut(el.color.lut.id)) warnings.push(`LUT "${el.color.lut.id}" is unknown and was skipped; use lutId "custom" with a .cube file`);
    }
  }
  for (const id of used) {
    const m: MediaAsset | undefined = project.media[id];
    if (!m) continue;
    const fps = fpsExpression(m.fps);
    media[id] = {
      path: m.path,
      kind: m.kind === "image" ? "image" : "video",
      width: m.width ?? 1920,
      height: m.height ?? 1080,
      fpsExpr: fps.expr,
      fps: fps.value,
      ...(m.videoCodec ? { videoCodec: m.videoCodec } : {}),
      ...(m.colorTransfer ? { colorTransfer: m.colorTransfer } : {}),
      ...(!m.colorSpace && (m.height ?? 0) >= 720 && m.kind === "video" ? { inColorMatrix: "bt709" } : {}),
      ...(opts.editingProxies?.[id] ? { editingProxy: opts.editingProxies[id] } : {}),
    };
    if (m.colorTransfer === "arib-std-b67" || m.colorTransfer === "smpte2084") warnings.push(`${m.name} is HDR (${m.colorTransfer === "smpte2084" ? "PQ" : "HLG"}); it is rendered without tone mapping, so colors may look flat`);
  }
  return {
    ctx: { project, media, luts, ffmpeg: opts.ffmpeg, ...(opts.hideCaptions ? { hideCaptions: true } : {}), ...(opts.hwaccel === false ? { hwaccel: false } : {}) },
    warnings: [...new Set(warnings)],
  };
}
