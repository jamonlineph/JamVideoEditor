import { z } from "zod";
import {
  COLOR_GRADE_KEYS,
  CURVE_CHANNELS,
  EditError,
  HSL_BANDS,
  WHEELS,
  applyEffect,
  applyFilter,
  applyLut,
  assertCatalogId,
  getCatalogItem,
  requireElement,
  setColorGrade,
  setColorWheel,
  setCurve,
  setHsl,
  type ColorGrade,
} from "@openedits/core";
import { defineTool } from "../defineTool.js";
import { element, expectedVersion, mutate, resolveElementId } from "./common.js";

const slider = z.number().min(-100).max(100);
const gradeShape = Object.fromEntries(COLOR_GRADE_KEYS.map((k) => [k, (k === "fade" ? z.number().min(0).max(100) : slider).optional()])) as Record<(typeof COLOR_GRADE_KEYS)[number], z.ZodOptional<z.ZodNumber>>;

export const colorTools = [
  defineTool({
    name: "getColor",
    title: "Get color",
    category: "color",
    description: "Full color settings of an element: 13-slider grade, wheels, HSL, curves, filter, LUT and effects.",
    input: z.object({ elementId: z.string().optional() }),
    readOnly: true,
    handler: (a, ctx) => {
      const el = element(ctx, a.elementId);
      if (!("color" in el)) throw new EditError("INVALID_ELEMENT_TYPE", `${el.id} (${el.type}) has no color settings`);
      return { elementId: el.id, color: el.color, effects: "effects" in el ? el.effects : [] };
    },
  }),
  defineTool({
    name: "setColorGrade",
    title: "Set color grade",
    category: "color",
    description: "Set any of the 13 sliders (-100..100; fade 0..100): exposure, brightness, contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation, clarity, fade. presetId applies an adjustPresets entry first; reset zeroes everything first.",
    input: z.object({ elementId: z.string().optional(), ...gradeShape, presetId: z.string().optional(), reset: z.boolean().optional(), expectedVersion }),
    handler: ({ elementId, presetId, reset, expectedVersion: ev, ...sliders }, ctx) => {
      const id = resolveElementId(ctx, elementId);
      const preset = presetId ? (getCatalogItem("adjustPresets", presetId).data as { grade: Partial<ColorGrade> }).grade : {};
      const patch = { ...preset, ...Object.fromEntries(Object.entries(sliders).filter(([, v]) => v !== undefined)) } as Partial<ColorGrade>;
      return mutate(ctx, "Adjust color", (c) => setColorGrade(c, requireElement(c.draft, id), patch, reset || !!presetId), { expectedVersion: ev }, () => ({ grade: (ctx.host.project.elements[id] as { color: { grade: ColorGrade } }).color.grade }));
    },
  }),
  defineTool({
    name: "setColorWheel",
    title: "Set color wheel",
    category: "color",
    description: "Set a color wheel (shadows, midtones, highlights, global): hue 0..360 and intensity 0..100.",
    input: z.object({ elementId: z.string().optional(), wheel: z.enum(WHEELS), hue: z.number().min(0).max(360).optional(), intensity: z.number().min(0).max(100).optional(), expectedVersion }),
    handler: ({ elementId, wheel, expectedVersion: ev, ...v }, ctx) => {
      const id = resolveElementId(ctx, elementId);
      return mutate(ctx, `Color wheel ${wheel}`, (c) => setColorWheel(c, requireElement(c.draft, id), wheel, v), { expectedVersion: ev });
    },
  }),
  defineTool({
    name: "setHSL",
    title: "Set HSL",
    category: "color",
    description: "8-band HSL: adjust hue, saturation and luminance (-100..100) of red, orange, yellow, green, aqua, blue, purple or magenta.",
    input: z.object({ elementId: z.string().optional(), band: z.enum(HSL_BANDS), hue: z.number().min(-100).max(100).optional(), saturation: z.number().min(-100).max(100).optional(), luminance: z.number().min(-100).max(100).optional(), expectedVersion }),
    handler: ({ elementId, band, expectedVersion: ev, ...v }, ctx) => {
      const id = resolveElementId(ctx, elementId);
      return mutate(ctx, `HSL ${band}`, (c) => setHsl(c, requireElement(c.draft, id), band, v), { expectedVersion: ev });
    },
  }),
  defineTool({
    name: "setCurve",
    title: "Set curve",
    category: "color",
    description: "Tone curve for luma, red, green or blue: control points {x, y} in 0..1 (at least 2, distinct x).",
    input: z.object({ elementId: z.string().optional(), channel: z.enum(CURVE_CHANNELS), points: z.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })).min(2).max(16), expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, `Curve ${a.channel}`, (c) => setCurve(c, requireElement(c.draft, id), a.channel, a.points), { expectedVersion: a.expectedVersion });
    },
  }),
  defineTool({
    name: "applyFilter",
    title: "Apply filter",
    category: "color",
    description: "Apply a filter look (listCatalog kind filters) at intensity 0..100; filterId \"none\" removes it.",
    input: z.object({ elementId: z.string().optional(), filterId: z.string(), intensity: z.number().min(0).max(100).optional(), expectedVersion }),
    handler: (a, ctx) => {
      assertCatalogId("filters", a.filterId);
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, `Filter ${a.filterId}`, (c) => applyFilter(c, requireElement(c.draft, id), a.filterId, a.intensity ?? 100), { expectedVersion: a.expectedVersion });
    },
  }),
  defineTool({
    name: "applyLUT",
    title: "Apply LUT",
    category: "color",
    description: "Apply a camera log → Rec.709 LUT (Apple Log 1/2, S-Log2/3, C-Log 1/2/3, D-Log / D-Log M, F-Log 1/2, V-Log / V-Log L) or lutId \"custom\" with an absolute cubePath. \"none\" removes it.",
    input: z.object({ elementId: z.string().optional(), lutId: z.string(), cubePath: z.string().optional(), intensity: z.number().min(0).max(100).optional(), expectedVersion }),
    handler: (a, ctx) => {
      if (a.lutId !== "none") assertCatalogId("luts", a.lutId);
      if (a.lutId === "custom" && !a.cubePath) throw new EditError("INVALID_ARGUMENT", "lutId custom requires cubePath");
      if (a.cubePath && !a.cubePath.toLowerCase().endsWith(".cube")) throw new EditError("INVALID_ARGUMENT", "cubePath must point to a .cube file");
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, `LUT ${a.lutId}`, (c) => applyLut(c, requireElement(c.draft, id), { id: a.lutId, cubePath: a.cubePath, intensity: a.intensity ?? 100 }), { expectedVersion: a.expectedVersion });
    },
  }),
  defineTool({
    name: "applyEffect",
    title: "Apply effect",
    category: "color",
    description: "Add an effect (listCatalog kind effects) with intensity/params, update an instance (instanceId), or remove one (remove: true).",
    input: z.object({
      elementId: z.string().optional(),
      effectId: z.string(),
      intensity: z.number().min(0).max(100).optional(),
      params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
      instanceId: z.string().optional(),
      remove: z.boolean().optional(),
      expectedVersion,
    }),
    handler: (a, ctx) => {
      const item = getCatalogItem("effects", a.effectId);
      if ((item.data as { requiresSubjectMask: boolean }).requiresSubjectMask && !a.remove) {
        throw new EditError("INVALID_ARGUMENT", `"${a.effectId}" is a subject effect: use applySubjectEffect, which computes the subject mask`);
      }
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, a.remove ? `Remove ${a.effectId}` : `Effect ${a.effectId}`, (c) => applyEffect(c, requireElement(c.draft, id), { ...a, intensity: a.intensity ?? 100 }), { expectedVersion: a.expectedVersion }, (inst) => ({ effect: inst }));
    },
  }),
];
