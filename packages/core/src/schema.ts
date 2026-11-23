import { z } from "zod";
import { HexColor } from "./color.js";

/**
 * Composition schema. All timeline times are seconds; source times end in `SourceSeconds`.
 * Canvas positions are normalized (0..1, origin top-left, +y down) and refer to element centers.
 */

export const SCHEMA_VERSION = 1;

export const Id = z.string().min(1);

// ---------------------------------------------------------------- canvas

export const AspectRatioSchema = z.enum(["9:16", "16:9", "1:1", "4:5"]);
export const ResolutionSchema = z.enum(["720p", "1080p", "4K"]);
export const FpsSchema = z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]);

export const CanvasSchema = z.object({
  aspectRatio: AspectRatioSchema,
  resolution: ResolutionSchema,
  fps: FpsSchema,
  backgroundColor: HexColor,
});
export type Canvas = z.infer<typeof CanvasSchema>;

// ---------------------------------------------------------------- transform & geometry

export const FitSchema = z.enum(["cover", "contain"]);

export const TransformSchema = z.object({
  /** Normalized center x (0 = left edge, 1 = right edge). */
  x: z.number(),
  /** Normalized center y (0 = top edge, 1 = bottom edge). */
  y: z.number(),
  /** Multiplier on the baseline fit size. */
  scale: z.number().positive().max(50),
  /** Degrees clockwise. */
  rotationDegrees: z.number(),
  /** Baseline sizing relative to the canvas at scale 1. */
  fit: FitSchema,
});
export type Transform = z.infer<typeof TransformSchema>;

export const CropSchema = z
  .object({
    left: z.number().min(0).max(0.99),
    top: z.number().min(0).max(0.99),
    right: z.number().min(0).max(0.99),
    bottom: z.number().min(0).max(0.99),
  })
  .refine((c) => c.left + c.right < 0.99 && c.top + c.bottom < 0.99, "Crop insets leave no visible area");
export type Crop = z.infer<typeof CropSchema>;

export const FlipSchema = z.object({ horizontal: z.boolean(), vertical: z.boolean() });
export type Flip = z.infer<typeof FlipSchema>;

export const MaskTypeSchema = z.enum(["none", "rectangle", "ellipse", "line", "shutter"]);
export const MaskSchema = z.object({
  type: MaskTypeSchema,
  /** Normalized to the element's own bounding box. */
  centerX: z.number(),
  centerY: z.number(),
  sizeW: z.number().min(0),
  sizeH: z.number().min(0),
  cornerRadius: z.number().min(0).max(1),
  feather: z.number().min(0).max(1),
  /** Degrees clockwise. */
  rotation: z.number(),
  invert: z.boolean(),
});
export type Mask = z.infer<typeof MaskSchema>;

export const BlendModeSchema = z.enum([
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "colorDodge",
  "colorBurn",
  "softLight",
  "hardLight",
  "difference",
  "add",
]);
export type BlendMode = z.infer<typeof BlendModeSchema>;

// ---------------------------------------------------------------- keyframes

export const EasingTypeSchema = z.enum(["linear", "easeIn", "easeOut", "easeInOut", "cubicBezier", "hold"]);
export const EasingSchema = z.object({
  type: EasingTypeSchema,
  /** Control points [x1, y1, x2, y2] for `cubicBezier`. */
  bezier: z.tuple([z.number().min(0).max(1), z.number(), z.number().min(0).max(1), z.number()]).optional(),
});
export type Easing = z.infer<typeof EasingSchema>;

export const KeyframeSchema = z.object({
  /** Seconds from the element's start (moves with the element). */
  offsetSeconds: z.number().min(0),
  value: z.number(),
  /** Easing for the segment from this keyframe to the next one. */
  easing: EasingSchema,
});
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const KEYFRAME_PROPERTIES = [
  "x",
  "y",
  "scale",
  "rotationDegrees",
  "opacity",
  "volume",
  "mask.centerX",
  "mask.centerY",
  "mask.sizeW",
  "mask.sizeH",
  "mask.rotation",
  "mask.feather",
  "mask.cornerRadius",
] as const;
export const KeyframePropertySchema = z.enum(KEYFRAME_PROPERTIES);
export type KeyframeProperty = z.infer<typeof KeyframePropertySchema>;

export const KeyframesSchema = z.partialRecord(KeyframePropertySchema, z.array(KeyframeSchema));
export type Keyframes = z.infer<typeof KeyframesSchema>;

// ---------------------------------------------------------------- color

export const COLOR_GRADE_KEYS = [
  "exposure",
  "brightness",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "temperature",
  "tint",
  "vibrance",
  "saturation",
  "clarity",
  "fade",
] as const;
export type ColorGradeKey = (typeof COLOR_GRADE_KEYS)[number];

const slider = z.number().min(-100).max(100);
export const ColorGradeSchema = z.object({
  exposure: slider,
  brightness: slider,
  contrast: slider,
  highlights: slider,
  shadows: slider,
  whites: slider,
  blacks: slider,
  temperature: slider,
  tint: slider,
  vibrance: slider,
  saturation: slider,
  clarity: slider,
  fade: z.number().min(0).max(100),
});
export type ColorGrade = z.infer<typeof ColorGradeSchema>;

export const WHEELS = ["shadows", "midtones", "highlights", "global"] as const;
export const ColorWheelSchema = z.object({
  hue: z.number().min(0).max(360),
  intensity: z.number().min(0).max(100),
});
export const ColorWheelsSchema = z.object({
  shadows: ColorWheelSchema,
  midtones: ColorWheelSchema,
  highlights: ColorWheelSchema,
  global: ColorWheelSchema,
});

export const HSL_BANDS = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"] as const;
export const HslBandSchema = z.object({ hue: slider, saturation: slider, luminance: slider });
export const HslSchema = z.object({
  red: HslBandSchema,
  orange: HslBandSchema,
  yellow: HslBandSchema,
  green: HslBandSchema,
  aqua: HslBandSchema,
  blue: HslBandSchema,
  purple: HslBandSchema,
  magenta: HslBandSchema,
});

export const CURVE_CHANNELS = ["luma", "red", "green", "blue"] as const;
export const CurvePointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
export type CurvePoint = z.infer<typeof CurvePointSchema>;
export const CurvesSchema = z.object({
  luma: z.array(CurvePointSchema).min(2),
  red: z.array(CurvePointSchema).min(2),
  green: z.array(CurvePointSchema).min(2),
  blue: z.array(CurvePointSchema).min(2),
});

export const LookRefSchema = z.object({
  id: z.string(),
  /** 0..100 */
  intensity: z.number().min(0).max(100),
});

export const LutRefSchema = z.object({
  /** Catalog id (e.g. `apple_log_to_rec709`) or `custom`. */
  id: z.string(),
  /** Absolute path for custom `.cube` LUTs. */
  cubePath: z.string().optional(),
  intensity: z.number().min(0).max(100),
});

export const ColorSettingsSchema = z.object({
  grade: ColorGradeSchema,
  wheels: ColorWheelsSchema,
  hsl: HslSchema,
  curves: CurvesSchema,
  filter: LookRefSchema.optional(),
  lut: LutRefSchema.optional(),
});
export type ColorSettings = z.infer<typeof ColorSettingsSchema>;

export const EffectInstanceSchema = z.object({
  instanceId: Id,
  effectId: z.string(),
  intensity: z.number().min(0).max(100),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
  /** For subject effects: id of a saved cutout mask (Phase 4). */
  subjectMaskId: z.string().optional(),
});
export type EffectInstance = z.infer<typeof EffectInstanceSchema>;

// ---------------------------------------------------------------- speed & audio

export const SpeedPointSchema = z.object({
  /** Normalized position within the source span (0..1). */
  position: z.number().min(0).max(1),
  /** Playback rate at that position (0.1 .. 100). */
  rate: z.number().min(0.1).max(100),
});
export type SpeedPoint = z.infer<typeof SpeedPointSchema>;

export const SPEED_PRESETS = ["MONTAGE", "HERO", "BULLET", "JUMP_CUT", "FLASH_IN", "FLASH_OUT", "RAMP", "STROBE"] as const;
export const SpeedPresetSchema = z.enum(SPEED_PRESETS);

export const SpeedSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("constant"), rate: z.number().min(0.1).max(100) }),
  z.object({
    mode: z.literal("curve"),
    preset: SpeedPresetSchema.optional(),
    points: z.array(SpeedPointSchema).min(2),
  }),
]);
export type Speed = z.infer<typeof SpeedSchema>;

export const VoiceEnhanceSchema = z.object({
  enabled: z.boolean(),
  reduceNoise: z.number().min(0).max(100),
  enhanceVoice: z.number().min(0).max(100),
});

export const DuckingSchema = z.object({
  enabled: z.boolean(),
  /** How far to lower this element under speech, in dB (negative). */
  amountDb: z.number().min(-60).max(0),
  attackSeconds: z.number().min(0).max(5),
  releaseSeconds: z.number().min(0).max(5),
});

const audioProps = {
  /** Linear gain 0..10 (1 = 0 dB). */
  volume: z.number().min(0).max(10),
  muted: z.boolean(),
  fadeInSeconds: z.number().min(0),
  fadeOutSeconds: z.number().min(0),
  voiceEnhance: VoiceEnhanceSchema,
  ducking: DuckingSchema,
};

// ---------------------------------------------------------------- text

export const TextAlignSchema = z.enum(["left", "center", "right"]);
export const TextStyleSchema = z.object({
  fontFamily: z.string(),
  fontWeight: z.number().int().min(100).max(1000),
  italic: z.boolean(),
  /** Fraction of the canvas short side. */
  fontSizeNorm: z.number().positive().max(1),
  color: HexColor,
  strokeColor: HexColor.optional(),
  /** Fraction of the font size. */
  strokeWidth: z.number().min(0).max(1),
  shadowColor: HexColor.optional(),
  shadowBlur: z.number().min(0).max(1),
  shadowOffsetX: z.number().min(-1).max(1),
  shadowOffsetY: z.number().min(-1).max(1),
  backgroundColor: HexColor.optional(),
  /** Fraction of the font size. */
  backgroundPadding: z.number().min(0).max(2),
  backgroundCornerRadius: z.number().min(0).max(1),
  align: TextAlignSchema,
  lineHeight: z.number().positive().max(4),
  letterSpacing: z.number().min(-1).max(2),
  uppercase: z.boolean(),
  underline: z.boolean(),
  /** Wrap width as a fraction of canvas width. */
  maxWidthNorm: z.number().positive().max(1),
});
export type TextStyle = z.infer<typeof TextStyleSchema>;

export const TextAnimationRefSchema = z.object({ id: z.string(), durationSeconds: z.number().positive().max(10) });
export const TextAnimationSchema = z.object({
  in: TextAnimationRefSchema.optional(),
  out: TextAnimationRefSchema.optional(),
  loop: TextAnimationRefSchema.optional(),
});

export const EmphasisSchema = z.object({
  /** Character range [startChar, endChar). */
  startChar: z.number().int().min(0),
  endChar: z.number().int().min(0),
  color: HexColor.optional(),
  fontWeight: z.number().int().min(100).max(1000).optional(),
  scale: z.number().positive().max(4).optional(),
  backgroundColor: HexColor.optional(),
});

export const CaptionWordSchema = z.object({
  /** Transcript word id (`#n`) when generated from a transcript. */
  id: z.union([z.number().int(), z.string()]),
  text: z.string(),
  startOffsetSeconds: z.number().min(0),
  endOffsetSeconds: z.number().min(0),
  highlighted: z.boolean(),
});
export type CaptionWord = z.infer<typeof CaptionWordSchema>;

// ---------------------------------------------------------------- elements

const timedBase = {
  id: Id,
  trackId: Id,
  name: z.string().optional(),
  /** Timeline start, seconds. */
  start: z.number().min(0),
  /** Timeline duration, seconds. */
  duration: z.number().positive(),
  /** Tier-1 ripple anchor: the main-track clip this free element follows. */
  anchor: z.object({ elementId: Id, offsetSeconds: z.number() }).optional(),
};

const visualProps = {
  transform: TransformSchema,
  opacity: z.number().min(0).max(1),
  blendMode: BlendModeSchema,
  mask: MaskSchema,
  keyframes: KeyframesSchema,
  color: ColorSettingsSchema,
  effects: z.array(EffectInstanceSchema),
};

const sourceProps = {
  mediaId: Id,
  /** Source in-point. */
  sourceInSourceSeconds: z.number().min(0),
  /** Length of the source span used (before speed). */
  sourceDurationSourceSeconds: z.number().positive(),
  speed: SpeedSchema,
  reversed: z.boolean(),
};

export const VideoElementSchema = z.object({
  type: z.literal("video"),
  ...timedBase,
  ...visualProps,
  ...sourceProps,
  ...audioProps,
  crop: CropSchema.optional(),
  flip: FlipSchema,
  /** True once audio was extracted to a separate element. */
  audioDetached: z.boolean(),
  linkedAudioId: Id.optional(),
  reverseStatus: z.enum(["none", "pending", "ready"]),
});

export const ImageElementSchema = z.object({
  type: z.literal("image"),
  ...timedBase,
  ...visualProps,
  mediaId: Id,
  crop: CropSchema.optional(),
  flip: FlipSchema,
});

export const AudioRoleSchema = z.enum(["music", "sfx", "voiceover", "extracted", "tts"]);
export const AudioElementSchema = z.object({
  type: z.literal("audio"),
  ...timedBase,
  ...sourceProps,
  ...audioProps,
  keyframes: KeyframesSchema,
  role: AudioRoleSchema,
  linkedVideoId: Id.optional(),
});

export const TextElementSchema = z.object({
  type: z.literal("text"),
  ...timedBase,
  ...visualProps,
  text: z.string(),
  style: TextStyleSchema,
  presetId: z.string().optional(),
  animation: TextAnimationSchema,
  emphasis: z.array(EmphasisSchema),
});

export const CaptionElementSchema = z.object({
  type: z.literal("caption"),
  ...timedBase,
  ...visualProps,
  words: z.array(CaptionWordSchema).min(1),
  styleId: z.string(),
  styleOverrides: TextStyleSchema.partial(),
  highlightColor: HexColor,
  sourceMediaId: Id.optional(),
});

export const ShapeKindSchema = z.enum(["rectangle", "ellipse", "line", "scrim"]);
export const ShapeElementSchema = z.object({
  type: z.literal("shape"),
  ...timedBase,
  ...visualProps,
  shape: ShapeKindSchema,
  /** Fraction of canvas width. */
  widthNorm: z.number().positive().max(4),
  /** Fraction of canvas height. */
  heightNorm: z.number().positive().max(4),
  fillColor: HexColor,
  /** Second color for `scrim` gradients (top -> bottom). */
  gradientToColor: HexColor.optional(),
  strokeColor: HexColor.optional(),
  strokeWidth: z.number().min(0).max(0.2),
  cornerRadius: z.number().min(0).max(1),
});

export const StickerElementSchema = z.object({
  type: z.literal("sticker"),
  ...timedBase,
  ...visualProps,
  stickerId: z.string().optional(),
  cutoutMaskId: z.string().optional(),
});

export const AdjustmentElementSchema = z.object({
  type: z.literal("adjustment"),
  ...timedBase,
  opacity: z.number().min(0).max(1),
  keyframes: KeyframesSchema,
  color: ColorSettingsSchema,
  effects: z.array(EffectInstanceSchema),
});

export const ElementSchema = z.discriminatedUnion("type", [
  VideoElementSchema,
  ImageElementSchema,
  AudioElementSchema,
  TextElementSchema,
  CaptionElementSchema,
  ShapeElementSchema,
  StickerElementSchema,
  AdjustmentElementSchema,
]);

export type VideoElement = z.infer<typeof VideoElementSchema>;
export type ImageElement = z.infer<typeof ImageElementSchema>;
export type AudioElement = z.infer<typeof AudioElementSchema>;
export type TextElement = z.infer<typeof TextElementSchema>;
export type CaptionElement = z.infer<typeof CaptionElementSchema>;
export type ShapeElement = z.infer<typeof ShapeElementSchema>;
export type StickerElement = z.infer<typeof StickerElementSchema>;
export type AdjustmentElement = z.infer<typeof AdjustmentElementSchema>;
export type Element = z.infer<typeof ElementSchema>;
export type ElementType = Element["type"];
export const ELEMENT_TYPES: ElementType[] = ["video", "image", "audio", "text", "caption", "shape", "sticker", "adjustment"];

export type VisualElement = Exclude<Element, AudioElement | AdjustmentElement>;
export type SourcedElement = VideoElement | AudioElement;

// ---------------------------------------------------------------- tracks

export const TRACK_KINDS = [
  "main",
  "overlay",
  "adjustment",
  "shape",
  "text",
  "sticker",
  "caption",
  "music",
  "sfx",
  "voiceover",
  "audio",
] as const;
export const TrackKindSchema = z.enum(TRACK_KINDS);
export type TrackKind = z.infer<typeof TrackKindSchema>;

export const TrackSchema = z.object({
  id: Id,
  kind: TrackKindSchema,
  behavior: z.enum(["magnetic", "free"]),
  name: z.string(),
  locked: z.boolean(),
  hidden: z.boolean(),
  muted: z.boolean(),
  /** Main track: playback order. Free tracks: sorted by start. */
  elementIds: z.array(Id),
});
export type Track = z.infer<typeof TrackSchema>;

// ---------------------------------------------------------------- media

export const MediaKindSchema = z.enum(["video", "audio", "image"]);
export const MediaAssetSchema = z.object({
  id: Id,
  kind: MediaKindSchema,
  name: z.string(),
  path: z.string(),
  folderId: Id.optional(),
  durationSourceSeconds: z.number().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  /** Color matrix reported by the container (e.g. bt709, bt2020nc). */
  colorSpace: z.string().optional(),
  /** Transfer characteristic (e.g. bt709, arib-std-b67 for HLG, smpte2084 for PQ). */
  colorTransfer: z.string().optional(),
  /** Presentation time of the first video frame. */
  videoStartSourceSeconds: z.number().optional(),
  audioChannels: z.number().int().optional(),
  sampleRate: z.number().int().optional(),
  sizeBytes: z.number().int().min(0),
  importedAt: z.number(),
  createdAt: z.number().optional(),
  proxyPath: z.string().optional(),
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

export const MediaFolderSchema = z.object({ id: Id, name: z.string(), parentId: Id.optional() });
export type MediaFolder = z.infer<typeof MediaFolderSchema>;

// ---------------------------------------------------------------- transitions, markers, settings

export const TransitionSchema = z.object({
  id: Id,
  type: z.string(),
  /** Main-track element before the cut. */
  fromElementId: Id,
  /** Main-track element after the cut. */
  toElementId: Id,
  durationSeconds: z.number().positive(),
});
export type Transition = z.infer<typeof TransitionSchema>;

export const BeatDensitySchema = z.enum(["off", "lowest", "low", "medium", "high", "extreme"]);
export const BeatMarkerSchema = z.object({
  id: Id,
  timeSeconds: z.number().min(0),
  source: z.enum(["manual", "auto"]),
  strength: z.number().min(0).max(1).optional(),
});
export type BeatMarker = z.infer<typeof BeatMarkerSchema>;

export const RippleSettingsSchema = z.object({
  magnetEnabled: z.boolean(),
  snappingEnabled: z.boolean(),
  tier1RippleEnabled: z.boolean(),
  tier2RippleEnabled: z.boolean(),
});
export type RippleSettings = z.infer<typeof RippleSettingsSchema>;

export const TeleprompterSchema = z.object({
  text: z.string(),
  fontSize: z.number().min(8).max(200),
  /** Words per minute. */
  scrollSpeed: z.number().min(20).max(400),
});

export const ExportSettingsSchema = z.object({
  resolution: ResolutionSchema,
  fps: FpsSchema,
  codec: z.enum(["h264", "hevc", "prores"]),
  quality: z.enum(["low", "medium", "high", "max"]),
  container: z.enum(["mp4", "mov"]),
  audioBitrateKbps: z.number().int().min(64).max(512),
  burnInCaptions: z.boolean(),
  outputDir: z.string().optional(),
  fileName: z.string().optional(),
});
export type ExportSettings = z.infer<typeof ExportSettingsSchema>;

export const ProjectSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: Id,
  name: z.string(),
  createdAt: z.number(),
  canvas: CanvasSchema,
  /** Index 0 is always the main track. Visual tracks render in array order (bottom -> top). */
  tracks: z.array(TrackSchema).min(1),
  elements: z.record(Id, ElementSchema),
  media: z.record(Id, MediaAssetSchema),
  mediaFolders: z.array(MediaFolderSchema),
  transitions: z.array(TransitionSchema),
  beatMarkers: z.array(BeatMarkerSchema),
  beatDensity: BeatDensitySchema,
  rippleSettings: RippleSettingsSchema,
  teleprompter: TeleprompterSchema,
  exportSettings: ExportSettingsSchema,
  /** Default style for captions generated in this project, when started from a template. */
  preferredCaptionStyle: z.string().optional(),
  /** Creator brief / notes recorded by agents (OpenCut `brief` op). */
  brief: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;
