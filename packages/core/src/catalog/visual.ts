import type { ColorGrade, ElementType } from "../schema.js";
import type { CatalogItem } from "./types.js";

type G = Partial<ColorGrade>;

/** Original filter looks, expressed as grade offsets (applied at the filter's intensity). */
const FILTERS: [string, string, string, G][] = [
  ["vivid", "Vivid", "color", { saturation: 25, vibrance: 20, contrast: 10 }],
  ["warm", "Warm", "color", { temperature: 30, tint: 5, vibrance: 10 }],
  ["cool", "Cool", "color", { temperature: -30, tint: -5 }],
  ["golden_hour", "Golden Hour", "color", { temperature: 40, highlights: -10, shadows: 10, saturation: 10 }],
  ["teal_orange", "Teal & Orange", "cinematic", { temperature: 10, contrast: 15, saturation: 10, shadows: -5 }],
  ["moody", "Moody", "cinematic", { exposure: -10, contrast: 20, saturation: -20, blacks: -15 }],
  ["film_fade", "Film Fade", "cinematic", { fade: 30, contrast: -10, saturation: -10 }],
  ["noir", "Noir", "mono", { saturation: -100, contrast: 30, clarity: 15 }],
  ["silver", "Silver", "mono", { saturation: -100, contrast: 10, fade: 15 }],
  ["sepia", "Sepia", "mono", { saturation: -70, temperature: 45, fade: 10 }],
  ["bright_airy", "Bright & Airy", "light", { exposure: 15, highlights: -15, shadows: 25, saturation: -5 }],
  ["pastel", "Pastel", "light", { saturation: -25, fade: 20, brightness: 10 }],
  ["punchy", "Punchy", "color", { contrast: 30, clarity: 20, vibrance: 15 }],
  ["matte", "Matte", "cinematic", { fade: 25, blacks: 15, contrast: -5 }],
  ["crisp", "Crisp", "detail", { clarity: 35, contrast: 10, whites: 10 }],
  ["sunset", "Sunset", "color", { temperature: 35, tint: 15, saturation: 15 }],
  ["forest", "Forest", "color", { temperature: -10, tint: -20, saturation: 10 }],
  ["night", "Night", "cinematic", { temperature: -35, exposure: -15, contrast: 15 }],
  ["vintage", "Vintage", "retro", { fade: 20, temperature: 20, saturation: -15, contrast: -10 }],
  ["polaroid", "Instant", "retro", { fade: 15, temperature: 15, tint: 10, highlights: -10 }],
  ["vibrant_food", "Food", "subject", { saturation: 20, temperature: 15, clarity: 10 }],
  ["portrait_soft", "Soft Portrait", "subject", { clarity: -20, highlights: -10, temperature: 8 }],
  ["urban", "Urban", "cinematic", { saturation: -30, contrast: 25, clarity: 20 }],
  ["dream", "Dream", "light", { clarity: -30, exposure: 10, fade: 10 }],
];

export const FILTERS_CATALOG: CatalogItem<{ grade: G }>[] = [
  { id: "none", name: "None", category: "basic", data: { grade: {} } },
  ...FILTERS.map(([id, name, category, grade]) => ({ id, name, category, data: { grade } })),
];

const ADJUST: [string, string, G][] = [
  ["auto", "Auto", { exposure: 5, contrast: 8, shadows: 10, highlights: -8, vibrance: 8 }],
  ["brighten", "Brighten", { exposure: 15, shadows: 15 }],
  ["darken", "Darken", { exposure: -15, highlights: -10 }],
  ["more_contrast", "More Contrast", { contrast: 25, blacks: -10, whites: 10 }],
  ["less_contrast", "Less Contrast", { contrast: -25, fade: 10 }],
  ["recover_highlights", "Recover Highlights", { highlights: -40, whites: -15 }],
  ["lift_shadows", "Lift Shadows", { shadows: 40, blacks: 10 }],
  ["warm_up", "Warm Up", { temperature: 20 }],
  ["cool_down", "Cool Down", { temperature: -20 }],
  ["desaturate", "Desaturate", { saturation: -40 }],
  ["boost_color", "Boost Color", { vibrance: 30, saturation: 10 }],
  ["sharpen", "Sharpen", { clarity: 30 }],
];

export const ADJUST_PRESETS: CatalogItem<{ grade: G }>[] = ADJUST.map(([id, name, grade]) => ({ id, name, category: "adjust", data: { grade } }));

export interface LutData {
  vendor: string;
  logCurve: string;
  gamut: string;
  output: "Rec.709";
}

const LUTS: [string, string, string, string, string][] = [
  ["apple_log_to_rec709", "Apple Log → Rec.709", "Apple", "Apple Log", "Rec.2020"],
  ["apple_log_2_to_rec709", "Apple Log 2 → Rec.709", "Apple", "Apple Log 2", "Apple Wide Gamut"],
  ["sony_slog2_sgamut_to_rec709", "Sony S-Log2 / S-Gamut → Rec.709", "Sony", "S-Log2", "S-Gamut"],
  ["sony_slog2_sgamut3_to_rec709", "Sony S-Log2 / S-Gamut3 → Rec.709", "Sony", "S-Log2", "S-Gamut3"],
  ["sony_slog2_sgamut3cine_to_rec709", "Sony S-Log2 / S-Gamut3.Cine → Rec.709", "Sony", "S-Log2", "S-Gamut3.Cine"],
  ["sony_slog3_sgamut3_to_rec709", "Sony S-Log3 / S-Gamut3 → Rec.709", "Sony", "S-Log3", "S-Gamut3"],
  ["sony_slog3_sgamut3cine_to_rec709", "Sony S-Log3 / S-Gamut3.Cine → Rec.709", "Sony", "S-Log3", "S-Gamut3.Cine"],
  ["canon_clog_to_rec709", "Canon C-Log → Rec.709", "Canon", "C-Log", "Cinema Gamut"],
  ["canon_clog2_to_rec709", "Canon C-Log2 → Rec.709", "Canon", "C-Log2", "Cinema Gamut"],
  ["canon_clog3_to_rec709", "Canon C-Log3 → Rec.709", "Canon", "C-Log3", "Cinema Gamut"],
  ["dji_dlog_to_rec709", "DJI D-Log → Rec.709", "DJI", "D-Log", "D-Gamut"],
  ["dji_dlogm_to_rec709", "DJI D-Log M → Rec.709", "DJI", "D-Log M", "D-Gamut"],
  ["fuji_flog_to_rec709", "Fujifilm F-Log → Rec.709", "Fujifilm", "F-Log", "F-Gamut"],
  ["fuji_flog2_to_rec709", "Fujifilm F-Log2 → Rec.709", "Fujifilm", "F-Log2", "F-Gamut"],
  ["panasonic_vlog_to_rec709", "Panasonic V-Log → Rec.709", "Panasonic", "V-Log", "V-Gamut"],
  ["panasonic_vlogl_to_rec709", "Panasonic V-Log L → Rec.709", "Panasonic", "V-Log L", "V-Gamut"],
];

export const LUTS_CATALOG: CatalogItem<LutData>[] = [
  ...LUTS.map(([id, name, vendor, logCurve, gamut]) => ({ id, name, category: vendor.toLowerCase(), data: { vendor, logCurve, gamut, output: "Rec.709" as const } })),
  { id: "custom", name: "Custom .cube", category: "custom", description: "Pass cubePath with an absolute path to a .cube file", data: { vendor: "custom", logCurve: "custom", gamut: "custom", output: "Rec.709" } },
];

export interface EffectParamDef {
  name: string;
  type: "number" | "boolean" | "color";
  min?: number;
  max?: number;
  default: number | boolean | string;
}

const P = (name: string, min: number, max: number, def: number): EffectParamDef => ({ name, type: "number", min, max, default: def });

const EFFECTS: [string, string, string, EffectParamDef[]][] = [
  ["blur", "Blur", "blur", [P("radius", 0, 100, 20)]],
  ["motion_blur", "Motion Blur", "blur", [P("angle", 0, 360, 0), P("amount", 0, 100, 30)]],
  ["zoom_blur", "Zoom Blur", "blur", [P("amount", 0, 100, 30)]],
  ["tilt_shift", "Tilt Shift", "blur", [P("focus", 0, 1, 0.5), P("width", 0, 1, 0.3)]],
  ["vignette", "Vignette", "light", [P("amount", 0, 100, 40), P("softness", 0, 100, 60)]],
  ["glow", "Glow", "light", [P("threshold", 0, 100, 70), P("radius", 0, 100, 30)]],
  ["light_leak", "Light Leak", "light", [P("hue", 0, 360, 30), P("speed", 0, 10, 1)]],
  ["flash", "Flash", "light", [P("frequency", 0, 20, 2)]],
  ["film_grain", "Film Grain", "texture", [P("amount", 0, 100, 25), P("size", 0, 10, 1.5)]],
  ["vhs", "VHS", "retro", [P("tracking", 0, 100, 30), P("noise", 0, 100, 20)]],
  ["chromatic_aberration", "RGB Split", "glitch", [P("amount", 0, 100, 20), P("angle", 0, 360, 0)]],
  ["glitch", "Glitch", "glitch", [P("amount", 0, 100, 40), P("speed", 0, 10, 3)]],
  ["pixelate", "Pixelate", "stylize", [P("size", 1, 200, 20)]],
  ["posterize", "Posterize", "stylize", [P("levels", 2, 32, 6)]],
  ["halftone", "Halftone", "stylize", [P("dotSize", 1, 50, 8)]],
  ["mirror", "Mirror", "distort", [{ name: "axis", type: "number", min: 0, max: 1, default: 0 }]],
  ["kaleidoscope", "Kaleidoscope", "distort", [P("segments", 2, 16, 6)]],
  ["fisheye", "Fisheye", "distort", [P("amount", 0, 100, 40)]],
  ["shake", "Camera Shake", "motion", [P("amount", 0, 100, 30), P("frequency", 0, 30, 8)]],
  ["zoom_pulse", "Zoom Pulse", "motion", [P("amount", 0, 100, 15), P("frequency", 0, 10, 2)]],
  ["sharpen", "Sharpen", "detail", [P("amount", 0, 100, 40)]],
  ["denoise", "Denoise", "detail", [P("amount", 0, 100, 40)]],
  ["outline", "Subject Outline", "subject", [{ name: "color", type: "color", default: "#FFFFFF" }, P("width", 0, 50, 8)]],
  ["subject_glow", "Subject Glow", "subject", [{ name: "color", type: "color", default: "#FFFFFF" }, P("radius", 0, 100, 30)]],
  ["background_blur", "Background Blur", "subject", [P("radius", 0, 100, 40)]],
];

export const EFFECTS_CATALOG: CatalogItem<{ params: EffectParamDef[]; requiresSubjectMask: boolean }>[] = EFFECTS.map(([id, name, category, params]) => ({
  id,
  name,
  category,
  data: { params, requiresSubjectMask: category === "subject" },
}));

const TRANSITIONS: [string, string, string][] = [
  ["dissolve", "Dissolve", "basic"],
  ["fade_black", "Fade Through Black", "basic"],
  ["fade_white", "Fade Through White", "basic"],
  ["slide_left", "Slide Left", "slide"],
  ["slide_right", "Slide Right", "slide"],
  ["slide_up", "Slide Up", "slide"],
  ["slide_down", "Slide Down", "slide"],
  ["push_left", "Push Left", "slide"],
  ["push_up", "Push Up", "slide"],
  ["zoom_in", "Zoom In", "zoom"],
  ["zoom_out", "Zoom Out", "zoom"],
  ["whip_pan", "Whip Pan", "motion"],
  ["spin", "Spin", "motion"],
  ["blur_dissolve", "Blur Dissolve", "blur"],
  ["flash", "Flash", "light"],
  ["glitch", "Glitch", "glitch"],
  ["wipe_left", "Wipe Left", "wipe"],
  ["circle_reveal", "Circle Reveal", "wipe"],
];

export const TRANSITIONS_CATALOG: CatalogItem<{ defaultDurationSeconds: number }>[] = [
  { id: "none", name: "None", category: "basic", data: { defaultDurationSeconds: 0 } },
  ...TRANSITIONS.map(([id, name, category]) => ({ id, name, category, data: { defaultDurationSeconds: category === "motion" || id === "flash" ? 0.3 : 0.5 } })),
];

/** Simple original vector stickers (24x24 viewBox SVG paths). */
const STICKERS: [string, string, string, string][] = [
  ["arrow_right", "Arrow Right", "arrows", "M4 11h12.2l-4.6-4.6L13 5l7 7-7 7-1.4-1.4 4.6-4.6H4z"],
  ["arrow_down", "Arrow Down", "arrows", "M11 4v12.2l-4.6-4.6L5 13l7 7 7-7-1.4-1.4-4.6 4.6V4z"],
  ["arrow_curved", "Curved Arrow", "arrows", "M5 18c0-6 4-10 10-10h1.2l-3-3L14.6 3.6 20 9l-5.4 5.4-1.4-1.4 3-3H15c-4.9 0-8 3.1-8 8z"],
  ["circle", "Circle", "shapes", "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16z"],
  ["star", "Star", "shapes", "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"],
  ["heart", "Heart", "shapes", "M12 21s-7.5-4.6-10-9.3C.3 8.3 2.4 4 6.3 4 8.6 4 10.4 5.3 12 7.2 13.6 5.3 15.4 4 17.7 4c3.9 0 6 4.3 4.3 7.7C19.5 16.4 12 21 12 21z"],
  ["sparkle", "Sparkle", "shapes", "M12 2c.6 4.8 2.2 6.4 7 7-4.8.6-6.4 2.2-7 7-.6-4.8-2.2-6.4-7-7 4.8-.6 6.4-2.2 7-7z"],
  ["check", "Check", "marks", "M9 16.2l-3.5-3.5L4 14.2l5 5 11-11-1.5-1.5z"],
  ["cross", "Cross", "marks", "M6.4 5L5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z"],
  ["exclaim", "Exclamation", "marks", "M11 3h2v12h-2zm0 15h2v3h-2z"],
  ["question", "Question", "marks", "M12 3a5 5 0 0 1 5 5c0 2.5-2 3.4-3 4.4-.6.6-1 1.1-1 2.6h-2c0-2.4.9-3.3 1.8-4.1.9-.8 2.2-1.5 2.2-2.9a3 3 0 0 0-6 0H7a5 5 0 0 1 5-5zm-1 15h2v3h-2z"],
  ["speech", "Speech Bubble", "callouts", "M4 4h16v11H9l-5 4z"],
  ["thought", "Thought Bubble", "callouts", "M12 4c4.4 0 8 2.7 8 6s-3.6 6-8 6c-.8 0-1.6-.1-2.3-.3L6 18l1-3.2C5.2 13.7 4 12 4 10c0-3.3 3.6-6 8-6z"],
  ["burst", "Burst", "callouts", "M12 1l2.2 5.3 5.6-1.6-2.4 5.3 5.1 2.9-5.6 1.8 1 5.7-5-3-3.9 4.3-1-5.7-5.8.4 3.6-4.5L1.6 8.3l5.7-.7z"],
  ["underline", "Underline Swoosh", "doodles", "M2 16c6-3 14-3 20-1l-.4 1.6C15.8 15 8.4 15 2.6 17.6z"],
  ["circle_scribble", "Scribble Circle", "doodles", "M12 4C6 4 3 7.5 3 11s3.5 8 9.5 8S21 15 21 11.5 18 4.5 12.5 4.5l-.1 1.4C17 6 19.5 8.5 19.5 11.5S16.8 17.5 12 17.5 4.5 14 4.5 11 7 5.5 12 5.5z"],
  ["play", "Play Button", "ui", "M8 5v14l11-7z"],
  ["bell", "Bell", "ui", "M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11c0-3.1-1.6-5.6-4.5-6.3V4a1.5 1.5 0 0 0-3 0v.7C7.6 5.4 6 7.9 6 11v5l-2 2v1h16v-1z"],
  ["thumb_up", "Thumbs Up", "ui", "M2 21h4V9H2zm20-11a2 2 0 0 0-2-2h-6.3l1-4.6v-.3c0-.4-.2-.8-.4-1.1L13.2 1 6.6 7.6C6.2 8 6 8.5 6 9v10a2 2 0 0 0 2 2h9c.8 0 1.5-.5 1.8-1.2l3-7.1c.1-.2.2-.5.2-.7z"],
  ["location_pin", "Location Pin", "ui", "M12 2a7 7 0 0 0-7 7c0 5.3 7 13 7 13s7-7.7 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"],
];

export const STICKERS_CATALOG: CatalogItem<{ svgPath: string; viewBox: string; defaultColor: string }>[] = STICKERS.map(([id, name, category, svgPath]) => ({
  id,
  name,
  category,
  data: { svgPath, viewBox: "0 0 24 24", defaultColor: "#FFFFFF" },
}));

export const SHAPES_CATALOG: CatalogItem<{ shape: string; defaultSize: { widthNorm: number; heightNorm: number } }>[] = [
  { id: "rectangle", name: "Rectangle", category: "basic", data: { shape: "rectangle", defaultSize: { widthNorm: 0.6, heightNorm: 0.2 } } },
  { id: "ellipse", name: "Ellipse", category: "basic", data: { shape: "ellipse", defaultSize: { widthNorm: 0.4, heightNorm: 0.225 } } },
  { id: "line", name: "Line", category: "basic", data: { shape: "line", defaultSize: { widthNorm: 0.6, heightNorm: 0.005 } } },
  { id: "scrim", name: "Gradient Scrim", category: "scrim", description: "Full-width gradient for text legibility", data: { shape: "scrim", defaultSize: { widthNorm: 1, heightNorm: 0.4 } } },
];

export const MASK_TYPES_CATALOG: CatalogItem<{ type: string }>[] = [
  { id: "none", name: "None", category: "mask", data: { type: "none" } },
  { id: "rectangle", name: "Rectangle", category: "mask", data: { type: "rectangle" } },
  { id: "ellipse", name: "Circle / Ellipse", category: "mask", data: { type: "ellipse" } },
  { id: "line", name: "Split (Line)", category: "mask", data: { type: "line" } },
  { id: "shutter", name: "Shutter", category: "mask", data: { type: "shutter" } },
];

export const SPLIT_SCREEN_LAYOUTS: CatalogItem<{ panels: number; direction: "vertical" }>[] = [
  { id: "stack2", name: "Stack (2 panels)", category: "layout", data: { panels: 2, direction: "vertical" } },
];

export const BEAT_DENSITIES: CatalogItem<{ beatsPerBar: number }>[] = [
  ["off", 0],
  ["lowest", 0.25],
  ["low", 0.5],
  ["medium", 1],
  ["high", 2],
  ["extreme", 4],
].map(([id, beatsPerBar]) => ({ id: id as string, name: String(id).charAt(0).toUpperCase() + String(id).slice(1), category: "beats", data: { beatsPerBar: beatsPerBar as number } }));

const VIS: ElementType[] = ["video", "image", "text", "caption", "shape", "sticker"];
const MEDIA: ElementType[] = ["video", "image"];
const SRC: ElementType[] = ["video", "audio"];
const COLORABLE: ElementType[] = ["video", "image", "adjustment", "sticker"];

/** The 42 inspector tool panels and the element types they apply to. */
const PANELS: [string, string, string, ElementType[], string[]][] = [
  ["transform", "Transform", "layout", VIS, ["setTransform", "getTransform"]],
  ["crop", "Crop", "layout", MEDIA, ["setCrop", "clearCrop"]],
  ["mask", "Mask", "layout", VIS, ["setMask"]],
  ["flip", "Flip", "layout", MEDIA, ["setFlip"]],
  ["opacity", "Opacity", "layout", [...VIS, "adjustment"], ["setOpacity"]],
  ["blend", "Blend", "layout", VIS, ["setBlendMode"]],
  ["splitScreen", "Split Screen", "layout", MEDIA, ["splitScreen"]],
  ["autoReframe", "Auto Reframe", "layout", MEDIA, ["autoReframe"]],
  ["speed", "Speed", "time", SRC, ["setSpeed"]],
  ["speedCurve", "Speed Ramp", "time", SRC, ["setSpeedCurve"]],
  ["reverse", "Reverse", "time", SRC, ["setReversed"]],
  ["split", "Split", "edit", ["video", "image", "audio", "text", "caption", "shape", "sticker", "adjustment"], ["split", "splitAt"]],
  ["duplicate", "Duplicate", "edit", ["video", "image", "audio", "text", "caption", "shape", "sticker", "adjustment"], ["duplicate"]],
  ["delete", "Delete", "edit", ["video", "image", "audio", "text", "caption", "shape", "sticker", "adjustment"], ["delete"]],
  ["replace", "Replace", "edit", ["video", "image", "audio"], ["replaceElementMedia"]],
  ["keyframeEasing", "Keyframes", "edit", ["video", "image", "audio", "text", "caption", "shape", "sticker", "adjustment"], ["setTransformKeyframe", "setKeyframeEasing", "removeTransformKeyframe"]],
  ["volume", "Volume", "audio", SRC, ["setSound"]],
  ["voiceEnhance", "Voice Enhance", "audio", SRC, ["setVoiceEnhance"]],
  ["noiseReduction", "Noise Reduction", "audio", SRC, ["setVoiceEnhance"]],
  ["fade", "Fade", "audio", SRC, ["setFade"]],
  ["ducking", "Ducking", "audio", ["audio"], ["setDucking"]],
  ["extractAudio", "Extract Audio", "audio", ["video"], ["extractAudio"]],
  ["beats", "Beats", "audio", ["audio"], ["beatMarkers", "addBeatMarker", "setBeatDensity"]],
  ["adjust", "Adjust", "color", COLORABLE, ["setColorGrade"]],
  ["adjustPresets", "Adjust Presets", "color", COLORABLE, ["setColorGrade"]],
  ["colorWheels", "Color Wheels", "color", COLORABLE, ["setColorWheel"]],
  ["hsl", "HSL", "color", COLORABLE, ["setHSL"]],
  ["curves", "Curves", "color", COLORABLE, ["setCurve"]],
  ["filters", "Filters", "color", COLORABLE, ["applyFilter"]],
  ["lut", "Camera LUT", "color", COLORABLE, ["applyLUT"]],
  ["effects", "Effects", "effects", ["video", "image", "text", "caption", "shape", "sticker", "adjustment"], ["applyEffect"]],
  ["transitions", "Transitions", "effects", MEDIA, ["addTransition"]],
  ["cutout", "Cutout", "effects", MEDIA, ["trackObject", "addStickerFromCutout"]],
  ["subjectEffect", "Subject Effects", "effects", MEDIA, ["applySubjectEffect"]],
  ["textEdit", "Edit Text", "text", ["text"], ["editText"]],
  ["textStyle", "Text Style", "text", ["text", "caption"], ["setTextStyle"]],
  ["textFont", "Font", "text", ["text", "caption"], ["setTextFont"]],
  ["textAnimation", "Animation", "text", ["text"], ["setTextAnimation"]],
  ["textPreset", "Text Presets", "text", ["text"], ["applyTextPreset"]],
  ["textToSpeech", "Text to Speech", "text", ["text"], ["applyTextToSpeech"]],
  ["captionsTranscript", "Transcript", "captions", ["caption"], ["captions", "editCaption", "splitCaption", "mergeCaptions"]],
  ["captionStyle", "Caption Style", "captions", ["caption"], ["setCaptionStyle", "setCaptionHighlights", "setCaptionHighlightColor"]],
];

export const TOOL_PANELS: CatalogItem<{ appliesTo: ElementType[]; mcpTools: string[] }>[] = PANELS.map(([id, name, category, appliesTo, mcpTools]) => ({
  id,
  name,
  category,
  data: { appliesTo, mcpTools },
}));

export const BLEND_MODES: CatalogItem<{ mode: string }>[] = [
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
].map((m) => ({ id: m, name: m.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()), category: "blend", data: { mode: m } }));
