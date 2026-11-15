import type { Transition } from "../schema.js";
import { EditError } from "../errors.js";
import { EPS, cleanTime } from "../units.js";
import { mainTrack, requireElement } from "../timeline/query.js";
import { maxTransitionDuration } from "../timeline/handles.js";
import type { EditContext } from "./context.js";

/**
 * Add (or replace) a transition between a main-track clip and the next one.
 * Transitions are centered on the cut and consume media handles; durations are clamped.
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
  if (max <= EPS) throw new EditError("INVALID_RANGE", "Not enough media on either side of the cut for a transition (trim the clips to create handles)", { fromElementId: from.id, toElementId: toId });
  let duration = opts.durationSeconds;
  if (duration > max) {
    ctx.warn(`Transition shortened to ${max.toFixed(3)}s (limited by media handles and clip lengths)`);
    duration = max;
  }
  const tr: Transition = { id: existing >= 0 ? project.transitions[existing].id : ctx.ids("tr"), type: opts.type, fromElementId: from.id, toElementId: toId, durationSeconds: cleanTime(duration) };
  if (existing >= 0) project.transitions[existing] = tr;
  else project.transitions.push(tr);
  ctx.touch(from.id, toId);
  return tr;
}
