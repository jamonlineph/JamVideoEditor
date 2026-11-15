import type { Element, Project } from "../schema.js";
import type { EditContext } from "../ops/context.js";
import { EPS, cleanTime } from "../units.js";
import { compatibleKinds, defaultKindFor, mainTrack } from "./query.js";
import { attachToTrack, findOrCreateLane, hasRoom } from "./tracks.js";
import { maxTransitionDuration } from "./handles.js";

export interface MainSnapshot {
  /** element id -> old start */
  starts: Map<string, number>;
  end: number;
}

function sameIds(a: readonly string[], b: readonly string[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Assign a track's element ids only when they differ (keeps immer from recording no-op patches). */
function setIds(track: { elementIds: string[] }, ids: string[]) {
  if (!sameIds(track.elementIds, ids)) track.elementIds = ids;
}

export function snapshotMain(project: Project): MainSnapshot {
  const starts = new Map<string, number>();
  let end = 0;
  for (const id of mainTrack(project).elementIds) {
    const el = project.elements[id];
    if (!el) continue;
    starts.set(id, el.start);
    end = Math.max(end, el.start + el.duration);
  }
  return { starts, end };
}

/** Lay out the main track: gapless when the magnet is on, otherwise sorted with overlaps pushed later. */
export function layoutMainTrack(project: Project) {
  const main = mainTrack(project);
  setIds(main, main.elementIds.filter((id) => project.elements[id]));
  if (project.rippleSettings.magnetEnabled) {
    let t = 0;
    for (const id of main.elementIds) {
      const el = project.elements[id];
      el.start = cleanTime(t);
      t += el.duration;
    }
    return;
  }
  const els = main.elementIds.map((id) => project.elements[id]).sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const el of els) {
    if (el.start < cursor - EPS) el.start = cleanTime(cursor);
    cursor = el.start + el.duration;
  }
  setIds(main, els.map((e) => e.id));
}

function applyRipple(ctx: EditContext, before: MainSnapshot) {
  const project = ctx.draft;
  const { tier1RippleEnabled, tier2RippleEnabled } = project.rippleSettings;
  if (!tier1RippleEnabled && !tier2RippleEnabled) return;
  const main = mainTrack(project);

  // Surviving main elements, sorted by their old start, with their ripple delta.
  const deltas: { oldStart: number; delta: number }[] = [];
  let changed = false;
  for (const id of main.elementIds) {
    const old = before.starts.get(id);
    const el = project.elements[id];
    if (old === undefined) {
      changed = true;
      continue;
    }
    const delta = el.start - old;
    if (Math.abs(delta) > EPS) changed = true;
    deltas.push({ oldStart: old, delta });
  }
  if (before.starts.size !== deltas.length) changed = true;
  let newEnd = 0;
  for (const id of main.elementIds) {
    const el = project.elements[id];
    newEnd = Math.max(newEnd, el.start + el.duration);
  }
  if (Math.abs(newEnd - before.end) > EPS) changed = true;
  if (!changed) return;
  deltas.sort((a, b) => a.oldStart - b.oldStart);
  const endDelta = newEnd - before.end;

  const tier2Delta = (p: number): number => {
    for (const d of deltas) if (d.oldStart >= p - EPS) return d.delta;
    return endDelta;
  };

  for (const track of project.tracks) {
    if (track.behavior !== "free") continue;
    for (const id of track.elementIds) {
      if (ctx.positioned.has(id)) continue;
      const el = project.elements[id];
      if (!el) continue;
      const anchorEl = el.anchor ? project.elements[el.anchor.elementId] : undefined;
      if (tier1RippleEnabled && el.anchor && anchorEl && anchorEl.trackId === main.id) {
        const next = cleanTime(Math.max(0, anchorEl.start + el.anchor.offsetSeconds));
        if (Math.abs(next - el.start) > EPS) {
          el.start = next;
          ctx.touch(id);
        }
      } else if (tier2RippleEnabled) {
        const d = tier2Delta(el.start);
        if (Math.abs(d) > EPS) {
          el.start = cleanTime(Math.max(0, el.start + d));
          ctx.touch(id);
        }
      }
    }
  }
}

/** Move overlapping free elements to another lane of the same kind. */
function resolveOverlaps(ctx: EditContext) {
  const project = ctx.draft;
  // Iterate over a snapshot: lanes may be created while resolving.
  for (const track of [...project.tracks]) {
    if (track.behavior !== "free") continue;
    let guard = 0;
    let conflict = true;
    while (conflict && guard++ < 10_000) {
      conflict = false;
      const els = track.elementIds.map((id) => project.elements[id]).filter(Boolean) as Element[];
      els.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
      for (let i = 1; i < els.length; i++) {
        const prev = els[i - 1];
        const cur = els[i];
        if (cur.start < prev.start + prev.duration - EPS) {
          // Prefer moving the element this op touched; otherwise move the later one.
          const mover = ctx.touched.has(prev.id) && !ctx.touched.has(cur.id) ? prev : cur;
          const kind = compatibleKinds(mover).includes(track.kind) ? track.kind : defaultKindFor(mover);
          const lane = findOrCreateLane(ctx, kind, mover.start, mover.start + mover.duration, {
            preferTrackId: track.id,
            excludeId: mover.id,
          });
          attachToTrack(project, mover, lane);
          ctx.touch(mover.id);
          conflict = true;
          break;
        }
      }
    }
  }
}

function pruneAndSortTracks(project: Project) {
  for (let i = project.tracks.length - 1; i >= 1; i--) if (project.tracks[i].elementIds.length === 0) project.tracks.splice(i, 1);
  for (const t of project.tracks) {
    if (t.behavior !== "free") continue;
    const ids = t.elementIds.filter((id) => project.elements[id]);
    ids.sort((a, b) => project.elements[a].start - project.elements[b].start || a.localeCompare(b));
    setIds(t, ids);
  }
}

/** Anchor each free element to the main clip under its start (tier-1 ripple). */
export function reanchor(project: Project) {
  const main = mainTrack(project);
  const mains = main.elementIds.map((id) => project.elements[id]);
  for (const track of project.tracks) {
    if (track.behavior !== "free") continue;
    for (const id of track.elementIds) {
      const el = project.elements[id];
      const host = mains.find((m) => m.start <= el.start + EPS && el.start < m.start + m.duration - EPS);
      if (host) {
        const offsetSeconds = cleanTime(el.start - host.start);
        if (!el.anchor || el.anchor.elementId !== host.id || el.anchor.offsetSeconds !== offsetSeconds) el.anchor = { elementId: host.id, offsetSeconds };
      } else if (el.anchor) delete el.anchor;
    }
  }
}

function cleanTransitions(ctx: EditContext) {
  const project = ctx.draft;
  const order = mainTrack(project).elementIds;
  for (let k = project.transitions.length - 1; k >= 0; k--) {
    const tr = project.transitions[k];
    const i = order.indexOf(tr.fromElementId);
    if (!(i >= 0 && order[i + 1] === tr.toElementId)) project.transitions.splice(k, 1);
  }
  for (const tr of project.transitions) {
    const max = maxTransitionDuration(project, project.elements[tr.fromElementId], project.elements[tr.toElementId]);
    if (tr.durationSeconds > max + EPS) {
      if (max <= EPS) {
        tr.durationSeconds = 0;
      } else {
        tr.durationSeconds = cleanTime(max);
        ctx.warn(`Transition ${tr.id} shortened to ${tr.durationSeconds.toFixed(3)}s (it cannot be longer than the shorter clip)`);
      }
    }
  }
  for (let k = project.transitions.length - 1; k >= 0; k--) if (project.transitions[k].durationSeconds <= EPS) project.transitions.splice(k, 1);
}

/**
 * Restores every timeline invariant after an op: main-track layout, ripple tiers,
 * free-lane overlaps, empty-lane pruning, anchors and transition validity.
 */
export function finalize(ctx: EditContext, before: MainSnapshot) {
  const project = ctx.draft;
  // Drop dangling ids.
  for (const t of project.tracks) setIds(t, t.elementIds.filter((id) => project.elements[id]));
  layoutMainTrack(project);
  applyRipple(ctx, before);
  resolveOverlaps(ctx);
  pruneAndSortTracks(project);
  reanchor(project);
  cleanTransitions(ctx);
}

export { hasRoom };
