import type { ColorGrade, ColorSettings, CurvePoint, Element, EffectInstance } from "../schema.js";
import { CURVE_CHANNELS, HSL_BANDS, WHEELS } from "../schema.js";
import { EditError } from "../errors.js";
import { assertUnlocked } from "../timeline/query.js";
import type { EditContext } from "./context.js";

type Colorable = Extract<Element, { color: ColorSettings }>;

export function requireColorable(el: Element): asserts el is Colorable {
  if (!("color" in el)) throw new EditError("INVALID_ELEMENT_TYPE", `Element ${el.id} (${el.type}) has no color settings`);
}

export function setColorGrade(ctx: EditContext, el: Element, patch: Partial<ColorGrade>, reset = false) {
  requireColorable(el);
  assertUnlocked(ctx.draft, el);
  if (reset) for (const k of Object.keys(el.color.grade) as (keyof ColorGrade)[]) el.color.grade[k] = 0;
  Object.assign(el.color.grade, patch);
  ctx.touch(el.id);
}

export function setColorWheel(ctx: EditContext, el: Element, wheel: (typeof WHEELS)[number], value: { hue?: number; intensity?: number }) {
  requireColorable(el);
  assertUnlocked(ctx.draft, el);
  Object.assign(el.color.wheels[wheel], value);
  ctx.touch(el.id);
}

export function setHsl(ctx: EditContext, el: Element, band: (typeof HSL_BANDS)[number], value: { hue?: number; saturation?: number; luminance?: number }) {
  requireColorable(el);
  assertUnlocked(ctx.draft, el);
  Object.assign(el.color.hsl[band], value);
  ctx.touch(el.id);
}

export function setCurve(ctx: EditContext, el: Element, channel: (typeof CURVE_CHANNELS)[number], points: CurvePoint[]) {
  requireColorable(el);
  assertUnlocked(ctx.draft, el);
  if (points.length < 2) throw new EditError("INVALID_ARGUMENT", "A curve needs at least 2 points");
  const sorted = [...points].sort((a, b) => a.x - b.x);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].x - sorted[i - 1].x < 1e-4) throw new EditError("INVALID_ARGUMENT", "Curve points must have distinct x values");
  el.color.curves[channel] = sorted;
  ctx.touch(el.id);
}

export function applyFilter(ctx: EditContext, el: Element, filterId: string, intensity: number) {
  requireColorable(el);
  assertUnlocked(ctx.draft, el);
  if (filterId === "none") delete el.color.filter;
  else el.color.filter = { id: filterId, intensity };
  ctx.touch(el.id);
}

export function applyLut(ctx: EditContext, el: Element, lut: { id: string; cubePath?: string; intensity: number }) {
  requireColorable(el);
  assertUnlocked(ctx.draft, el);
  if (lut.id === "none") delete el.color.lut;
  else el.color.lut = { id: lut.id, intensity: lut.intensity, ...(lut.cubePath ? { cubePath: lut.cubePath } : {}) };
  ctx.touch(el.id);
}

type WithEffects = Extract<Element, { effects: EffectInstance[] }>;

export function applyEffect(
  ctx: EditContext,
  el: Element,
  opts: { effectId: string; intensity: number; params?: Record<string, number | string | boolean>; instanceId?: string; remove?: boolean; subjectMaskId?: string },
): EffectInstance | null {
  if (!("effects" in el)) throw new EditError("INVALID_ELEMENT_TYPE", `Element ${el.id} (${el.type}) cannot have effects`);
  const target = el as WithEffects;
  assertUnlocked(ctx.draft, el);
  if (opts.remove) {
    const before = target.effects.length;
    target.effects = target.effects.filter((e) => (opts.instanceId ? e.instanceId !== opts.instanceId : e.effectId !== opts.effectId));
    if (target.effects.length === before) throw new EditError("INVALID_ARGUMENT", `Effect not found on ${el.id}`, { effectId: opts.effectId, instanceId: opts.instanceId });
    ctx.touch(el.id);
    return null;
  }
  if (opts.instanceId) {
    const existing = target.effects.find((e) => e.instanceId === opts.instanceId);
    if (!existing) throw new EditError("INVALID_ARGUMENT", `No effect instance ${opts.instanceId} on ${el.id}`);
    existing.intensity = opts.intensity;
    if (opts.params) existing.params = { ...existing.params, ...opts.params };
    ctx.touch(el.id);
    return existing;
  }
  const inst: EffectInstance = {
    instanceId: ctx.ids("fx"),
    effectId: opts.effectId,
    intensity: opts.intensity,
    params: opts.params ?? {},
    ...(opts.subjectMaskId ? { subjectMaskId: opts.subjectMaskId } : {}),
  };
  target.effects.push(inst);
  ctx.touch(el.id);
  return inst;
}
