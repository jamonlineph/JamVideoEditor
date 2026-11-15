import type { Transition } from "../schema.js";
import { EditError } from "../errors.js";
import { EPS, cleanTime } from "../units.js";
import { mainTrack, requireElement } from "../timeline/query.js";
import { handleCoveredTransitionDuration, maxTransitionDuration } from "../timeline/handles.js";
import type { EditContext } from "./context.js";

/**
 * Add (or replace) a transition between a main-track clip and the next one.
 * Transitions are centered on the cut and use media handles (spare footage past the cut) when the
 * clips have them; without handles the edge frame is held. Durations are clamped to the shorter clip.
 * `type: "none"` removes the transition.
 */
export function addTransition(ctx: EditContext, opts: { fromElementId: string; type: string; durationSeconds: number }): Transition | null {
  const project = ctx.draft;
  const from = requireElement(project, opts.fromElementId);
  const order = mainTrack(project).elementIds;
  const i = order.indexOf(from.id);
  if (i < 0) throw new EditError("INVALID_ARGUMENT", "Transitions apply to main-track clips", { elementId: from.id });
  const toId = order[i + 1];
  if (!toId) throw new EditError("INVALID_ARGUMENT", `${from.id} is the last main-track clip; there is no cut after it`);
  const existing = project.transitions.findIndex((t) => t.fromElementId === from.id);
  if (opts.type === "none") {
    if (existing >= 0) project.transitions.splice(existing, 1);
    ctx.touch(from.id, toId);
    return null;
  }
  const to = requireElement(project, toId);
  const max = maxTransitionDuration(project, from, to);
  if (max <= EPS) throw new EditError("INVALID_RANGE", "The clips at this cut are too short for a transition", { fromElementId: from.id, toElementId: toId });
  let duration = opts.durationSeconds;
  if (duration > max) {
    ctx.warn(`Transition shortened to ${max.toFixed(3)}s (it cannot be longer than the shorter clip)`);
    duration = max;
  }
  if (handleCoveredTransitionDuration(project, from, to) < duration - EPS) {
    ctx.warn("These clips have no spare footage at the cut, so their edge frames are held during the transition. Trim the clips a little for motion on both sides.");
  }
  const tr: Transition = { id: existing >= 0 ? project.transitions[existing].id : ctx.ids("tr"), type: opts.type, fromElementId: from.id, toElementId: toId, durationSeconds: cleanTime(duration) };
  if (existing >= 0) project.transitions[existing] = tr;
  else project.transitions.push(tr);
  ctx.touch(from.id, toId);
  return tr;
}
