import type {
  Canvas,
  ColorSettings,
  ExportSettings,
  Mask,
  Project,
  RippleSettings,
  TextStyle,
  Track,
  TrackKind,
  Transform,
} from "./schema.js";
import { SCHEMA_VERSION } from "./schema.js";
import type { IdGenerator } from "./ids.js";

export const DEFAULT_CANVAS: Canvas = {
  aspectRatio: "9:16",
  resolution: "1080p",
  fps: 30,
  backgroundColor: "#000000",
};

export const DEFAULT_RIPPLE: RippleSettings = {
  magnetEnabled: true,
  snappingEnabled: true,
  tier1RippleEnabled: true,
  tier2RippleEnabled: false,
};

export const DEFAULT_EXPORT: ExportSettings = {
  resolution: "1080p",
  fps: 30,
  codec: "h264",
  quality: "high",
  container: "mp4",
  audioBitrateKbps: 192,
  burnInCaptions: true,
};

export function defaultTransform(overrides: Partial<Transform> = {}): Transform {
  return { x: 0.5, y: 0.5, scale: 1, rotationDegrees: 0, fit: "cover", ...overrides };
}

export function defaultMask(): Mask {
  return {
    type: "none",
    centerX: 0.5,
    centerY: 0.5,
    sizeW: 0.6,
    sizeH: 0.6,
    cornerRadius: 0,
    feather: 0,
    rotation: 0,
    invert: false,
  };
}

const identityCurve = () => [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

export function defaultColor(): ColorSettings {
  const wheel = () => ({ hue: 0, intensity: 0 });
  const band = () => ({ hue: 0, saturation: 0, luminance: 0 });
  return {
    grade: {
      exposure: 0,
      brightness: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      temperature: 0,
      tint: 0,
      vibrance: 0,
      saturation: 0,
      clarity: 0,
      fade: 0,
    },
    wheels: { shadows: wheel(), midtones: wheel(), highlights: wheel(), global: wheel() },
    hsl: {
      red: band(),
      orange: band(),
      yellow: band(),
      green: band(),
      aqua: band(),
      blue: band(),
      purple: band(),
      magenta: band(),
    },
    curves: { luma: identityCurve(), red: identityCurve(), green: identityCurve(), blue: identityCurve() },
  };
}

export function defaultTextStyle(overrides: Partial<TextStyle> = {}): TextStyle {
  return {
    fontFamily: "Helvetica Neue",
    fontWeight: 700,
    italic: false,
    fontSizeNorm: 0.06,
    color: "#FFFFFF",
    strokeWidth: 0,
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    backgroundPadding: 0.25,
    backgroundCornerRadius: 0,
    align: "center",
    lineHeight: 1.15,
    letterSpacing: 0,
    uppercase: false,
    underline: false,
    maxWidthNorm: 0.86,
    ...overrides,
  };
}

export function defaultAudioProps() {
  return {
    volume: 1,
    muted: false,
    fadeInSeconds: 0,
    fadeOutSeconds: 0,
    voiceEnhance: { enabled: false, reduceNoise: 0, enhanceVoice: 0 },
    ducking: { enabled: false, amountDb: -12, attackSeconds: 0.2, releaseSeconds: 0.4 },
  };
}

export function defaultVisualProps(transform: Partial<Transform> = {}) {
  return {
    transform: defaultTransform(transform),
    opacity: 1,
    blendMode: "normal" as const,
    mask: defaultMask(),
    keyframes: {},
    color: defaultColor(),
    effects: [],
  };
}

export const TRACK_KIND_LABEL: Record<TrackKind, string> = {
  main: "Main",
  overlay: "Overlay",
  adjustment: "Adjustment",
  shape: "Shapes",
  text: "Text",
  sticker: "Stickers",
  caption: "Captions",
  music: "Music",
  sfx: "Sound effects",
  voiceover: "Voiceover",
  audio: "Audio",
};

export function makeTrack(id: string, kind: TrackKind, name?: string): Track {
  return {
    id,
    kind,
    behavior: kind === "main" ? "magnetic" : "free",
    name: name ?? TRACK_KIND_LABEL[kind],
    locked: false,
    hidden: false,
    muted: false,
    elementIds: [],
  };
}

export interface CreateProjectOptions {
  id: string;
  name: string;
  canvas?: Partial<Canvas>;
  now?: number;
  ids: IdGenerator;
}

export function createProject(opts: CreateProjectOptions): Project {
  const canvas = { ...DEFAULT_CANVAS, ...opts.canvas };
  return {
    schemaVersion: SCHEMA_VERSION,
    id: opts.id,
    name: opts.name,
    createdAt: opts.now ?? Date.now(),
    canvas,
    tracks: [makeTrack(opts.ids("trk"), "main")],
    elements: {},
    media: {},
    mediaFolders: [],
    transitions: [],
    beatMarkers: [],
    beatDensity: "off",
    rippleSettings: { ...DEFAULT_RIPPLE },
    teleprompter: { text: "", fontSize: 48, scrollSpeed: 140 },
    exportSettings: { ...DEFAULT_EXPORT, resolution: canvas.resolution, fps: canvas.fps },
    brief: "",
  };
}
