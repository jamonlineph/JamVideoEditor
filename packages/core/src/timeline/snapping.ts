import type { Project } from "../schema.js";
import { clipBoundaries } from "./query.js";

export interface SnapOptions {
  /** Tolerance in project frames (default 3). */
  toleranceFrames?: number;
  playheadSeconds?: number;
  /** Elements whose own edges should be ignored (e.g. the element being moved). */
  excludeElementIds?: string[];
}

/** Candidate snap targets: element edges, beat markers, the playhead and 0. */
export function snapTargets(project: Project, opts: SnapOptions = {}): number[] {
  const exclude = new Set(opts.excludeElementIds ?? []);
  const set = new Set<number>([0]);
  for (const el of Object.values(project.elements)) {
    if (exclude.has(el.id)) continue;
    set.add(el.start);
    set.add(el.start + el.duration);
  }
  for (const m of project.beatMarkers) set.add(m.timeSeconds);
  if (opts.playheadSeconds !== undefined) set.add(opts.playheadSeconds);
  return [...set].sort((a, b) => a - b);
}

/** Snap `time` to the nearest target within tolerance. Returns the input when nothing is close. */
export function snapTime(project: Project, time: number, opts: SnapOptions = {}): { time: number; snapped: boolean } {
  const tol = (opts.toleranceFrames ?? 3) / project.canvas.fps;
  let best = time;
  let bestDist = Infinity;
  for (const t of snapTargets(project, opts)) {
    const d = Math.abs(t - time);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return bestDist <= tol ? { time: best, snapped: true } : { time, snapped: false };
}

export { clipBoundaries };
