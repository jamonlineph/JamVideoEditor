import type { Project } from "../schema.js";
import { ProjectSchema } from "../schema.js";
import { EPS } from "../units.js";
import { compatibleKinds, mainTrack } from "./query.js";
import { timelineDurationFor } from "../speed.js";

/** Returns a list of invariant violations (empty when the project is consistent). */
export function validateProject(project: Project): string[] {
  const problems: string[] = [];
  const parsed = ProjectSchema.safeParse(project);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 20)) problems.push(`schema: ${issue.path.join(".")}: ${issue.message}`);
  }
  if (project.tracks[0]?.kind !== "main") problems.push("tracks[0] must be the main track");
  const seen = new Set<string>();
  for (const track of project.tracks) {
    for (const id of track.elementIds) {
      const el = project.elements[id];
      if (!el) problems.push(`track ${track.id} references missing element ${id}`);
      else if (el.trackId !== track.id) problems.push(`element ${id} trackId ${el.trackId} != ${track.id}`);
      else if (!compatibleKinds(el).includes(track.kind)) problems.push(`element ${id} (${el.type}) on incompatible ${track.kind} track`);
      if (seen.has(id)) problems.push(`element ${id} appears on more than one track`);
      seen.add(id);
    }
  }
  for (const id of Object.keys(project.elements)) if (!seen.has(id)) problems.push(`element ${id} is not on any track`);

  const main = mainTrack(project);
  let cursor = 0;
  for (const id of main.elementIds) {
    const el = project.elements[id];
    if (!el) continue;
    if (project.rippleSettings.magnetEnabled && Math.abs(el.start - cursor) > 1e-5) problems.push(`main track gap/overlap at ${id}: start ${el.start} expected ${cursor}`);
    if (!project.rippleSettings.magnetEnabled && el.start < cursor - 1e-5) problems.push(`main track overlap at ${id}`);
    cursor = el.start + el.duration;
  }
  for (const track of project.tracks) {
    if (track.behavior !== "free") continue;
    const els = track.elementIds.map((id) => project.elements[id]).filter(Boolean).sort((a, b) => a.start - b.start);
    for (let i = 1; i < els.length; i++) {
      if (els[i].start < els[i - 1].start + els[i - 1].duration - 1e-5) problems.push(`overlap on ${track.id}: ${els[i - 1].id} / ${els[i].id}`);
    }
  }
  for (const el of Object.values(project.elements)) {
    if (el.type === "video" || el.type === "audio") {
      const expected = timelineDurationFor(el.sourceDurationSourceSeconds, el.speed);
      if (Math.abs(expected - el.duration) > 1e-4) problems.push(`element ${el.id} duration ${el.duration} != speed-derived ${expected}`);
      const media = project.media[el.mediaId];
      if (!media) problems.push(`element ${el.id} references missing media ${el.mediaId}`);
      else if (media.durationSourceSeconds !== undefined && el.sourceInSourceSeconds + el.sourceDurationSourceSeconds > media.durationSourceSeconds + 1e-4) {
        problems.push(`element ${el.id} source window exceeds media duration`);
      }
    }
    if (el.type === "image" && !project.media[el.mediaId]) problems.push(`element ${el.id} references missing media ${el.mediaId}`);
    if (el.start < -EPS) problems.push(`element ${el.id} starts before 0`);
  }
  const order = main.elementIds;
  for (const tr of project.transitions) {
    const i = order.indexOf(tr.fromElementId);
    if (i < 0 || order[i + 1] !== tr.toElementId) problems.push(`transition ${tr.id} is not between adjacent main clips`);
  }
  return problems;
}
