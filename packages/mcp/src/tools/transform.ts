import { z } from "zod";
import {
  EditError,
  MaskTypeSchema,
  SpeedPresetSchema,
  evaluateProperty,
  removeKeyframe,
  requireElement,
  setCrop,
  setFlip,
  setKeyframe,
  setKeyframeEasing,
  setMask,
  setOpacity,
  setBlendMode,
  BlendModeSchema,
  setReversed,
  setSpeed,
  setSpeedCurve,
  setTransform,
  splitScreen,
} from "@openedits/core";
import { defineTool } from "../defineTool.js";
import { easingInput, element, expectedVersion, hexColor, keyframeProperty, mutate, resolveElementId, round, transformInput } from "./common.js";

const keyframeItem = z.object({
  elementId: z.string().optional(),
  property: keyframeProperty,
  time: z.number().min(0).optional().describe("Timeline seconds"),
  offsetSeconds: z.number().min(0).optional().describe("Seconds from the element start"),
  value: z.number(),
  easing: easingInput.optional().describe("Easing from this keyframe to the next"),
});

const crop = z.object({
  left: z.number().min(0).max(0.99),
  top: z.number().min(0).max(0.99),
  right: z.number().min(0).max(0.99),
  bottom: z.number().min(0).max(0.99),
});

export const transformTools = [
  defineTool({
    name: "getTransform",
    title: "Get transform",
    category: "transform",
    description: "Static transform plus, with `time`, the keyframe-evaluated x/y/scale/rotation/opacity at that timeline time.",
    input: z.object({ elementId: z.string().optional(), time: z.number().min(0).optional() }),
    readOnly: true,
    handler: (a, ctx) => {
      const el = element(ctx, a.elementId);
      if (!("transform" in el)) throw new EditError("INVALID_ELEMENT_TYPE", `${el.id} (${el.type}) has no transform`);
      const t = a.time ?? ctx.host.appState.playheadSeconds;
      return {
        elementId: el.id,
        transform: el.transform,
        opacity: el.opacity,
        ...("crop" in el && el.crop ? { crop: el.crop } : {}),
        ...("flip" in el ? { flip: el.flip } : {}),
        evaluatedAt: t,
        evaluated: {
          x: round(evaluateProperty(el, "x", t)),
          y: round(evaluateProperty(el, "y", t)),
          scale: round(evaluateProperty(el, "scale", t)),
          rotationDegrees: round(evaluateProperty(el, "rotationDegrees", t)),
          opacity: round(evaluateProperty(el, "opacity", t)),
        },
        keyframes: Object.fromEntries(Object.entries(el.keyframes).filter(([p]) => ["x", "y", "scale", "rotationDegrees", "opacity"].includes(p))),
      };
    },
  }),
  defineTool({
    name: "setTransform",
    title: "Set transform",
    category: "transform",
    description: "Set position (normalized center), scale, rotation (degrees clockwise) or fit. If a property is keyframed, pass `time` to set the keyframe at that time.",
    input: transformInput.extend({ elementId: z.string().optional(), time: z.number().min(0).optional(), expectedVersion }),
    handler: ({ elementId, time, expectedVersion: ev, ...patch }, ctx) => {
      const id = resolveElementId(ctx, elementId);
      return mutate(ctx, "Transform", (c) => setTransform(c, requireElement(c.draft, id), patch, time), { expectedVersion: ev }, () => ({ transform: (ctx.host.project.elements[id] as { transform: unknown }).transform }));
    },
  }),
  defineTool({
    name: "setTransforms",
    title: "Set transforms (batch)",
    category: "transform",
    description: "Set transforms on many elements in one undo step.",
    input: z.object({ items: z.array(transformInput.extend({ elementId: z.string(), time: z.number().min(0).optional() })).min(1), expectedVersion }),
    handler: (a, ctx) =>
      mutate(ctx, `Transform ${a.items.length} elements`, (c) => {
        for (const { elementId, time, ...patch } of a.items) setTransform(c, requireElement(c.draft, elementId), patch, time);
      }, { expectedVersion: a.expectedVersion }),
  }),
  defineTool({
    name: "setTransformKeyframe",
    title: "Set keyframe",
    category: "transform",
    description: "Add or replace a keyframe for x, y, scale, rotationDegrees, opacity, volume or mask.* at a timeline `time` or element `offsetSeconds`.",
    input: keyframeItem.extend({ expectedVersion }),
    handler: ({ expectedVersion: ev, elementId, ...spec }, ctx) => {
      const id = resolveElementId(ctx, elementId);
      return mutate(ctx, `Keyframe ${spec.property}`, (c) => setKeyframe(c, requireElement(c.draft, id), spec), { expectedVersion: ev }, (offset) => ({ offsetSeconds: offset, keyframes: ctx.host.project.elements[id].keyframes[spec.property] }));
    },
  }),
  defineTool({
    name: "setTransformKeyframes",
    title: "Set keyframes (batch)",
    category: "transform",
    description: "Add many keyframes (any elements/properties) in one undo step, e.g. a whole punch-in zoom.",
    input: z.object({ items: z.array(keyframeItem.extend({ elementId: z.string() })).min(1).max(5000), expectedVersion }),
    handler: (a, ctx) =>
      mutate(ctx, `Set ${a.items.length} keyframes`, (c) => {
        for (const { elementId, ...spec } of a.items) setKeyframe(c, requireElement(c.draft, elementId), spec);
      }, { expectedVersion: a.expectedVersion }),
  }),
  defineTool({
    name: "removeTransformKeyframe",
    title: "Remove keyframe",
    category: "transform",
    description: "Remove one keyframe (by time or offsetSeconds) or all keyframes of a property (all: true keeps the value at the clip start as the static value).",
    input: z.object({ elementId: z.string().optional(), property: keyframeProperty, time: z.number().min(0).optional(), offsetSeconds: z.number().min(0).optional(), all: z.boolean().optional(), expectedVersion }),
    destructive: true,
    handler: ({ elementId, property, expectedVersion: ev, ...opts }, ctx) => {
      const id = resolveElementId(ctx, elementId);
      return mutate(ctx, `Remove ${property} keyframe`, (c) => removeKeyframe(c, requireElement(c.draft, id), property, opts), { expectedVersion: ev }, (n) => ({ removed: n }));
    },
  }),
  defineTool({
    name: "setKeyframeEasing",
    title: "Set keyframe easing",
    category: "transform",
    description: "Change the easing of the segment that starts at a keyframe (linear, easeIn, easeOut, easeInOut, cubicBezier with bezier, hold).",
    input: z.object({ elementId: z.string().optional(), property: keyframeProperty, time: z.number().min(0).optional(), offsetSeconds: z.number().min(0).optional(), easing: easingInput, expectedVersion }),
    handler: ({ elementId, property, easing, expectedVersion: ev, ...opts }, ctx) => {
      const id = resolveElementId(ctx, elementId);
      return mutate(ctx, "Keyframe easing", (c) => setKeyframeEasing(c, requireElement(c.draft, id), property, opts, easing), { expectedVersion: ev });
    },
  }),
  defineTool({
    name: "setCrop",
    title: "Set crop",
    category: "transform",
    description: "Crop a video/image with normalized insets from each edge (0..1 of the source size).",
    input: crop.extend({ elementId: z.string().optional(), expectedVersion }),
    handler: ({ elementId, expectedVersion: ev, ...c0 }, ctx) => {
      const id = resolveElementId(ctx, elementId);
      return mutate(ctx, "Crop", (c) => setCrop(c, requireElement(c.draft, id), c0), { expectedVersion: ev });
    },
  }),
  defineTool({
    name: "clearCrop",
    title: "Clear crop",
    category: "transform",
    description: "Remove the crop from a video/image.",
    input: z.object({ elementId: z.string().optional(), expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, "Clear crop", (c) => setCrop(c, requireElement(c.draft, id), undefined), { expectedVersion: a.expectedVersion });
    },
  }),
  defineTool({
    name: "setFlip",
    title: "Set flip",
    category: "transform",
    description: "Mirror a video/image horizontally and/or vertically.",
    input: z.object({ elementId: z.string().optional(), horizontal: z.boolean().optional(), vertical: z.boolean().optional(), expectedVersion }),
    handler: ({ elementId, expectedVersion: ev, ...flip }, ctx) => {
      const id = resolveElementId(ctx, elementId);
      return mutate(ctx, "Flip", (c) => setFlip(c, requireElement(c.draft, id), flip), { expectedVersion: ev });
    },
  }),
  defineTool({
    name: "setOpacity",
    title: "Set opacity",
    category: "transform",
    description: "Set static opacity 0..1 (use setTransformKeyframe with property opacity to animate).",
    input: z.object({ elementId: z.string().optional(), opacity: z.number().min(0).max(1), expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, "Opacity", (c) => setOpacity(c, requireElement(c.draft, id), a.opacity), { expectedVersion: a.expectedVersion });
    },
  }),
  defineTool({
    name: "setBlendMode",
    title: "Set blend mode",
    category: "transform",
    description: "How a visual layer blends with the layers below it (normal, multiply, screen, overlay, …).",
    input: z.object({ elementId: z.string().optional(), blendMode: BlendModeSchema, expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, "Blend mode", (c) => setBlendMode(c, requireElement(c.draft, id), a.blendMode), { expectedVersion: a.expectedVersion });
    },
  }),
  defineTool({
    name: "setMask",
    title: "Set mask",
    category: "transform",
    description: "Parametric mask: rectangle, ellipse, line (split), shutter or none. Center/size are normalized to the element's own box; feather and cornerRadius 0..1; rotation in degrees.",
    input: z.object({
      elementId: z.string().optional(),
      type: MaskTypeSchema.optional(),
      centerX: z.number().optional(),
      centerY: z.number().optional(),
      sizeW: z.number().min(0).optional(),
      sizeH: z.number().min(0).optional(),
      cornerRadius: z.number().min(0).max(1).optional(),
      feather: z.number().min(0).max(1).optional(),
      rotation: z.number().optional(),
      invert: z.boolean().optional(),
      expectedVersion,
    }),
    handler: ({ elementId, expectedVersion: ev, ...patch }, ctx) => {
      const id = resolveElementId(ctx, elementId);
      return mutate(ctx, "Mask", (c) => setMask(c, requireElement(c.draft, id), patch), { expectedVersion: ev }, () => ({ mask: (ctx.host.project.elements[id] as { mask: unknown }).mask }));
    },
  }),
  defineTool({
    name: "splitScreen",
    title: "Split screen",
    category: "transform",
    description: "One step vertical split screen (stack2) from one element (duplicated into both panels) or two. Panels are center-cropped to fill; gap is a fraction of canvas height; background blur (default) or solid color.",
    input: z.object({
      elementIds: z.array(z.string()).min(1).max(2),
      layout: z.enum(["stack2"]).optional(),
      gap: z.number().min(0).max(0.2).optional(),
      background: z.enum(["blur", "solid"]).optional(),
      backgroundColor: hexColor.optional(),
      blurAmount: z.number().min(0).max(100).optional(),
      expectedVersion,
    }),
    handler: (a, ctx) =>
      mutate(ctx, "Split screen", (c) =>
        splitScreen(c, {
          elementIds: a.elementIds,
          layout: a.layout ?? "stack2",
          gap: a.gap ?? 0.01,
          background: { type: a.background ?? "blur", color: a.backgroundColor, blurAmount: a.blurAmount },
        }), { expectedVersion: a.expectedVersion }, (r) => r),
  }),
  defineTool({
    name: "setSpeed",
    title: "Set speed",
    category: "transform",
    description: "Constant speed multiplier 0.1..100 for video/audio. Duration changes (main track ripples); keyframes scale with it.",
    input: z.object({ elementId: z.string().optional(), rate: z.number().min(0.1).max(100), expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, `Speed ${a.rate}x`, (c) => setSpeed(c, requireElement(c.draft, id), a.rate), { expectedVersion: a.expectedVersion }, () => ({ duration: ctx.host.project.elements[id].duration }));
    },
  }),
  defineTool({
    name: "setSpeedCurve",
    title: "Set speed curve",
    category: "transform",
    description: "Speed ramp from a preset (MONTAGE, HERO, BULLET, JUMP_CUT, FLASH_IN, FLASH_OUT, RAMP, STROBE) or custom points [{position 0..1 of the source span, rate}].",
    input: z.object({
      elementId: z.string().optional(),
      preset: SpeedPresetSchema.optional(),
      points: z.array(z.object({ position: z.number().min(0).max(1), rate: z.number().min(0.1).max(100) })).min(2).optional(),
      expectedVersion,
    }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, `Speed curve ${a.preset ?? "custom"}`, (c) => setSpeedCurve(c, requireElement(c.draft, id), a), { expectedVersion: a.expectedVersion }, () => ({ duration: ctx.host.project.elements[id].duration }));
    },
  }),
  defineTool({
    name: "setReversed",
    title: "Reverse",
    category: "transform",
    description: "Play a video/audio element backwards (picture and sound).",
    input: z.object({ elementId: z.string().optional(), reversed: z.boolean(), expectedVersion }),
    handler: (a, ctx) => {
      const id = resolveElementId(ctx, a.elementId);
      return mutate(ctx, a.reversed ? "Reverse" : "Un-reverse", (c) => setReversed(c, requireElement(c.draft, id), a.reversed), { expectedVersion: a.expectedVersion });
    },
  }),
];
