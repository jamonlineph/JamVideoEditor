import type { Element, Project } from "../schema.js";
import { rateAt } from "../speed.js";

/** Rate at the head (local 0) and tail (local end) of a sourced element, in playback order. */
function edgeRates(el: Extract<Element, { type: "video" | "audio" }>): { head: number; tail: number } {
  if (el.speed.mode === "constant") return { head: el.speed.rate, tail: el.speed.rate };
  return { head: rateAt(el.speed.points, 0), tail: rateAt(el.speed.points, 1) };
}

/**
 * Unused media available before the element's head and after its tail, in timeline seconds.
 * Images, text and generated elements have unlimited handles.
 */
export function mediaHandles(project: Project, el: Element): { head: number; tail: number } {
  if (el.type !== "video" && el.type !== "audio") return { head: Infinity, tail: Infinity };
  const media = project.media[el.mediaId];
  const total = media?.durationSourceSeconds;
  if (total === undefined) return { head: Infinity, tail: Infinity };
  const before = Math.max(0, el.sourceInSourceSeconds);
  const after = Math.max(0, total - (el.sourceInSourceSeconds + el.sourceDurationSourceSeconds));
  const rates = edgeRates(el);
  const [headSrc, tailSrc] = el.reversed ? [after, before] : [before, after];
  return { head: headSrc / rates.head, tail: tailSrc / rates.tail };
}

/** Longest centered transition the two adjacent elements can support. */
export function maxTransitionDuration(project: Project, from: Element, to: Element): number {
  const a = mediaHandles(project, from).tail;
  const b = mediaHandles(project, to).head;
  return Math.min(2 * Math.min(a, b), from.duration, to.duration);
}
