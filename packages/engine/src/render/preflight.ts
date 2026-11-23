import fs from "node:fs";
import { EditError, buildAudioPlan, compositionDuration, type Element, type Project } from "@openedits/core";

export interface MediaIssue {
  mediaId: string;
  name: string;
  path: string;
}

export function checkExportMedia(project: Project, start = 0, end = compositionDuration(project)) {
  const used = new Set<string>();
  const overlaps = (from: number, to: number) => start < end && from < end && to > start;
  const addVisual = (element: Element) => {
    if (element.type === "video" || element.type === "image") used.add(element.mediaId);
    if (element.type === "sticker" && element.cutoutMaskId) used.add(element.cutoutMaskId);
    if ("effects" in element) for (const effect of element.effects) {
      if (effect.subjectMaskId) used.add(effect.subjectMaskId);
    }
  };

  for (const track of project.tracks) {
    if (track.hidden) continue;
    for (const id of track.elementIds) {
      const element = project.elements[id];
      if (element && overlaps(element.start, element.start + element.duration)) addVisual(element);
    }
  }
  if (!project.tracks[0]?.hidden) for (const transition of project.transitions) {
    const from = project.elements[transition.fromElementId];
    const to = project.elements[transition.toElementId];
    const half = transition.durationSeconds / 2;
    if (from && to && overlaps(to.start - half, to.start + half)) {
      addVisual(from);
      addVisual(to);
    }
  }
  for (const clip of buildAudioPlan(project)) {
    if (overlaps(clip.startSeconds, clip.startSeconds + clip.durationSeconds)) used.add(clip.mediaId);
  }

  const missing: MediaIssue[] = [];
  const hdr: MediaIssue[] = [];
  for (const mediaId of used) {
    const media = project.media[mediaId];
    const item = { mediaId, name: media?.name ?? mediaId, path: media?.path ?? "" };
    try {
      if (!media || !fs.statSync(media.path).isFile()) {
        missing.push(item);
        continue;
      }
      fs.accessSync(media.path, fs.constants.R_OK);
    } catch {
      missing.push(item);
      continue;
    }
    if (media.colorTransfer === "smpte2084" || media.colorTransfer === "arib-std-b67") hdr.push(item);
  }
  return { missing, hdr };
}

export function requireExportMedia(project: Project, start: number, end: number) {
  const { missing } = checkExportMedia(project, start, end);
  if (missing.length) {
    const names = missing.slice(0, 3).map(({ name }) => name).join(", ");
    const remaining = missing.length > 3 ? ` and ${missing.length - 3} more` : "";
    throw new EditError("FILE_NOT_FOUND", `Locate missing media before exporting: ${names}${remaining}.`, { missing });
  }
}
