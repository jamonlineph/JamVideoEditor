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
  ["seaside", "Seaside", "color", { temperature: -15, tint: -5, saturation: 15, highlights: -10, shadows: 10 }],
  ["blush", "Blush", "portrait", { tint: 18, temperature: 8, fade: 8, saturation: -5 }],
  ["honey", "Honey", "portrait", { temperature: 28, saturation: 8, highlights: -12, fade: 6 }],
  ["glow_skin", "Glow", "portrait", { exposure: 8, clarity: -15, temperature: 10, shadows: 15 }],
  ["mint", "Mint", "light", { tint: -18, temperature: -8, fade: 12, saturation: -8 }],
  ["lavender", "Lavender", "light", { tint: 22, temperature: -12, fade: 15, saturation: -10 }],
  ["retro_70s", "Seventies", "retro", { temperature: 30, tint: 8, fade: 25, saturation: -20, contrast: -8 }],
  ["lomo", "Lomo", "retro", { contrast: 35, saturation: 25, blacks: -15, temperature: 10 }],
  ["chrome", "Chrome", "cinematic", { contrast: 20, saturation: 15, clarity: 15, highlights: -10 }],
  ["cold_steel", "Cold Steel", "cinematic", { temperature: -30, saturation: -35, contrast: 20, clarity: 10 }],
  ["neon_night", "Neon Night", "cinematic", { tint: 25, temperature: -25, saturation: 25, contrast: 15, exposure: -8 }],
  ["desert", "Desert", "color", { temperature: 38, tint: 6, saturation: -10, contrast: 10, fade: 8 }],
  ["cocoa", "Cocoa", "color", { temperature: 22, saturation: -25, contrast: 12, blacks: 8 }],
  ["bold_bw", "Bold B&W", "mono", { saturation: -100, contrast: 50, clarity: 25, blacks: -10 }],
  ["faded_bw", "Faded B&W", "mono", { saturation: -100, fade: 35, contrast: -10 }],
  ["cyber", "Cyber", "cinematic", { tint: 30, temperature: -30, saturation: 30, contrast: 25 }],
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
  ["invert", "Invert", "color", []],
  ["duotone", "Duotone", "color", [P("shadowHue", 0, 360, 260), P("highlightHue", 0, 360, 30)]],
  ["rainbow", "Rainbow", "color", [P("speed", 0, 5, 1), P("spread", 0, 100, 50)]],
  ["neon_edges", "Neon Edges", "stylize", [P("hue", 0, 360, 300), P("thickness", 0.5, 5, 1.5)]],
  ["sketch", "Sketch", "stylize", [P("strength", 0, 100, 50)]],
  ["grid", "Grid", "split", [P("count", 2, 4, 2)]],
  ["triple", "Triple Split", "split", [{ name: "axis", type: "number", min: 0, max: 1, default: 0 }]],
  ["old_film", "Old Film", "retro", [P("scratches", 0, 100, 50), P("flicker", 0, 100, 50)]],
  ["snow", "Snow", "particles", [P("density", 0, 100, 50), P("speed", 0, 10, 3)]],
  ["sparkle", "Sparkle", "particles", [P("density", 0, 100, 50), P("size", 0, 100, 50)]],
  ["wave", "Wave", "distort", [P("amount", 0, 100, 40), P("frequency", 0, 12, 4)]],
  ["letterbox", "Cinema Bars", "light", [P("size", 0, 100, 50)]],
  ["strobe", "Strobe", "motion", [P("frequency", 0, 15, 4)]],
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
  ["wipe_right", "Wipe Right", "wipe"],
  ["wipe_up", "Wipe Up", "wipe"],
  ["wipe_down", "Wipe Down", "wipe"],
  ["push_right", "Push Right", "slide"],
  ["push_down", "Push Down", "slide"],
  ["cross_zoom", "Pull In", "zoom"],
  ["pixelize", "Pixelize", "glitch"],
  ["doors_open", "Doors Open", "wipe"],
  ["blinds", "Blinds", "wipe"],
  ["diamond", "Diamond", "wipe"],
  ["heart", "Heart", "wipe"],
  ["ripple", "Ripple", "distort"],
  ["swirl", "Swirl", "distort"],
  ["squeeze", "Squeeze", "slide"],
  ["film_burn", "Film Burn", "light"],
  ["shake", "Shake", "motion"],
  ["roll_up", "Roll Up", "motion"],
];

export const TRANSITIONS_CATALOG: CatalogItem<{ defaultDurationSeconds: number }>[] = [
  { id: "none", name: "None", category: "basic", data: { defaultDurationSeconds: 0 } },
  ...TRANSITIONS.map(([id, name, category]) => ({ id, name, category, data: { defaultDurationSeconds: category === "motion" || id === "flash" ? 0.3 : 0.5 } })),
];

/** In / out / combo animations for video, photo, sticker and shape clips (setClipAnimation). */
const CLIP_ANIMS: [string, string, "in" | "out" | "loop"][] = [
  ["fade_in", "Fade In", "in"],
  ["zoom_in", "Zoom In", "in"],
  ["zoom_out_in", "Zoom Out", "in"],
  ["slide_in_left", "Slide Left", "in"],
  ["slide_in_right", "Slide Right", "in"],
  ["slide_in_up", "Slide Up", "in"],
  ["slide_in_down", "Slide Down", "in"],
  ["rotate_in", "Rotate In", "in"],
  ["spin_in", "Spin In", "in"],
  ["blur_in", "Blur In", "in"],
  ["pop_in", "Pop In", "in"],
  ["drop_in", "Drop In", "in"],
  ["swing_in", "Swing In", "in"],
  ["fade_out", "Fade Out", "out"],
  ["zoom_out", "Zoom Out", "out"],
  ["zoom_in_out", "Zoom In", "out"],
  ["slide_out_left", "Slide Left", "out"],
  ["slide_out_right", "Slide Right", "out"],
  ["slide_out_up", "Slide Up", "out"],
  ["slide_out_down", "Slide Down", "out"],
  ["rotate_out", "Rotate Out", "out"],
  ["spin_out", "Spin Out", "out"],
  ["blur_out", "Blur Out", "out"],
  ["pop_out", "Pop Out", "out"],
  ["fall_out", "Fall", "out"],
  ["ken_burns", "Ken Burns", "loop"],
  ["slow_zoom_out", "Slow Zoom Out", "loop"],
  ["pan_left", "Pan Left", "loop"],
  ["pan_right", "Pan Right", "loop"],
  ["pulse", "Pulse", "loop"],
  ["heartbeat", "Heartbeat", "loop"],
  ["rock", "Rock", "loop"],
  ["float", "Float", "loop"],
  ["shake", "Shake", "loop"],
  ["wobble", "Wobble", "loop"],
  ["spin", "Spin", "loop"],
];

/** Combo animations that run once over the whole clip (their duration is ignored). */
export const WHOLE_CLIP_ANIMATIONS = new Set(["ken_burns", "slow_zoom_out", "pan_left", "pan_right"]);

export const CLIP_ANIMATIONS: CatalogItem<{ slot: "in" | "out" | "loop"; defaultDurationSeconds: number }>[] = CLIP_ANIMS.map(([id, name, slot]) => ({
  id,
  name,
  category: slot === "loop" ? "combo" : slot,
  data: { slot, defaultDurationSeconds: slot === "loop" ? 2 : 0.6 },
}));

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

/** Original full-color stickers: [id, name, category, layers of [path, fill]] on a 24x24 grid. */
const COLOR_STICKERS: [string, string, string, [string, string][]][] = [
  ["fire", "Fire", "emoji", [
    ["M12 1c1 4 6 6.5 6 12.5A6 6 0 0 1 6 13.5c0-2.6 1.2-4.2 2.6-5.6.2 1.8 1 3 2.2 3.6C10 8 10.5 4.2 12 1z", "#FF5A1F"],
    ["M12 9.5c.6 2.3 3.5 3.6 3.5 7a3.5 3.5 0 0 1-7 0c0-1.6.8-2.6 1.6-3.4.2 1 .7 1.7 1.4 2-.4-2 .3-4 .5-5.6z", "#FFC93C"],
  ]],
  ["red_heart", "Red Heart", "emoji", [
    ["M12 21s-7.5-4.6-10-9.3C.3 8.3 2.4 4 6.3 4 8.6 4 10.4 5.3 12 7.2 13.6 5.3 15.4 4 17.7 4c3.9 0 6 4.3 4.3 7.7C19.5 16.4 12 21 12 21z", "#FF2D55"],
    ["M6.4 6.2c-1.6 0-2.6 1.3-2.6 2.7 0 .5.4.8.8.6.6-.9 1.4-1.6 2.6-1.8.6-.1.8-.9.2-1.3-.3-.1-.6-.2-1-.2z", "#FFFFFF99"],
  ]],
  ["gold_star", "Gold Star", "emoji", [
    ["M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z", "#FFC93C"],
    ["M12 5.5l2 4.1 4.5.6-3.3 3.2.8 4.5L12 15.8z", "#FFE27A"],
  ]],
  ["smile", "Smile", "emoji", [
    ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z", "#FFCC33"],
    ["M8.5 8a1.5 1.8 0 1 0 0 3.6A1.5 1.8 0 0 0 8.5 8zm7 0a1.5 1.8 0 1 0 0 3.6 1.5 1.8 0 0 0 0-3.6z", "#3B2A14"],
    ["M6.5 13.5h11c-.6 3-3 5-5.5 5s-4.9-2-5.5-5z", "#3B2A14"],
    ["M9 16.6c.9.8 1.9 1.2 3 1.2s2.1-.4 3-1.2c-.9-.5-1.9-.8-3-.8s-2.1.3-3 .8z", "#FF5A6E"],
  ]],
  ["laugh", "Laugh", "emoji", [
    ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z", "#FFCC33"],
    ["M6.5 10.5l3-1.5-3-1.5-.5.8 1.6.7-1.6.7zM17.5 10.5l-3-1.5 3-1.5.5.8-1.6.7 1.6.7z", "#3B2A14"],
    ["M5.5 12.5h13c-.4 4-3.2 6.5-6.5 6.5s-6.1-2.5-6.5-6.5z", "#3B2A14"],
    ["M7 13.2h10c-.1.9-.4 1.6-.8 2.2H7.8c-.4-.6-.7-1.3-.8-2.2z", "#FFFFFF"],
    ["M3 13.5c-1 1.5-1 3 0 3.5s2-1 1.6-2.6zM21 13.5c1 1.5 1 3 0 3.5s-2-1-1.6-2.6z", "#5AC8FA"],
  ]],
  ["heart_eyes", "Heart Eyes", "emoji", [
    ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z", "#FFCC33"],
    ["M8.5 12.3S5.5 10.5 5 8.8C4.7 7.6 5.5 6.6 6.6 6.6c.8 0 1.4.5 1.9 1.1.5-.6 1.1-1.1 1.9-1.1 1.1 0 1.9 1 1.6 2.2-.5 1.7-3.5 3.5-3.5 3.5zM15.5 12.3s-3-1.8-3.5-3.5c-.3-1.2.5-2.2 1.6-2.2.8 0 1.4.5 1.9 1.1.5-.6 1.1-1.1 1.9-1.1 1.1 0 1.9 1 1.6 2.2-.5 1.7-3.5 3.5-3.5 3.5z", "#FF2D55"],
    ["M7.5 14.5h9c-.6 2.4-2.4 3.8-4.5 3.8s-3.9-1.4-4.5-3.8z", "#3B2A14"],
  ]],
  ["cool", "Cool", "emoji", [
    ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z", "#FFCC33"],
    ["M3.5 8.5h17v1.2l-1 .3c-.3 2.2-1.6 3.2-3.5 3.2s-3-1.2-3.4-2.9h-1.2c-.4 1.7-1.5 2.9-3.4 2.9S5.8 12.2 5.5 10l-2-.3z", "#1C1C1E"],
    ["M8 16.2c1.2 1 2.5 1.5 4 1.5s2.8-.5 4-1.5l-.7-.8c-1 .8-2.1 1.2-3.3 1.2s-2.3-.4-3.3-1.2z", "#3B2A14"],
  ]],
  ["thumbs", "Thumbs Up", "emoji", [
    ["M2 21h4V9H2z", "#2F80FF"],
    ["M22 10a2 2 0 0 0-2-2h-6.3l1-4.6v-.3c0-.4-.2-.8-.4-1.1L13.2 1 6.6 7.6C6.2 8 6 8.5 6 9v10a2 2 0 0 0 2 2h9c.8 0 1.5-.5 1.8-1.2l3-7.1c.1-.2.2-.5.2-.7z", "#FFCC33"],
  ]],
  ["party", "Party", "emoji", [
    ["M3 21l5-14 9 9z", "#FF9F0A"],
    ["M5.3 14.6l1.2-3.3 6.2 6.2-3.3 1.2z", "#FF2D55"],
    ["M14 3l1 2.2L17.2 6 15 7l-1 2.2L13 7l-2.2-1L13 5.2zM19 9l.6 1.4 1.4.6-1.4.6L19 13l-.6-1.4L17 11l1.4-.6z", "#FFD60A"],
    ["M17.5 2.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM21 5.5a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6zM20.5 15a1 1 0 1 0 0 2 1 1 0 0 0 0-2z", "#30D158"],
    ["M9.5 3a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6z", "#5AC8FA"],
  ]],
  ["crown", "Crown", "fun", [
    ["M3 7l4.5 4L12 4l4.5 7L21 7l-2 11H5z", "#FFC93C"],
    ["M5 18h14v2.5H5z", "#E0A100"],
    ["M12 11a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z", "#FF2D55"],
    ["M7.5 13.2a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zM16.5 13.2a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2z", "#2F80FF"],
  ]],
  ["lightning", "Lightning", "fun", [["M13.5 1L4 13.5h6.5L9 23l10-13h-6.8z", "#FFD60A"], ["M13.5 1l-3 9.5h2.2z", "#FFF2A8"]]],
  ["sun", "Sun", "weather", [
    ["M11 0h2v4h-2zM11 20h2v4h-2zM0 11h4v2H0zM20 11h4v2h-4zM3.5 4.9l1.4-1.4 2.8 2.8-1.4 1.4zM16.3 17.7l1.4-1.4 2.8 2.8-1.4 1.4zM3.5 19.1l2.8-2.8 1.4 1.4-2.8 2.8zM16.3 6.3l2.8-2.8 1.4 1.4-2.8 2.8z", "#FF9F0A"],
    ["M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z", "#FFD60A"],
  ]],
  ["moon", "Moon", "weather", [["M15 2a9.5 9.5 0 1 0 7 15.5A8 8 0 0 1 15 2z", "#FFE27A"], ["M8 9a1.2 1.2 0 1 0 0 2.4A1.2 1.2 0 0 0 8 9zm2 6a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8z", "#E8C14A"]]],
  ["cloud", "Cloud", "weather", [["M7 19a5 5 0 0 1-.6-10A6.5 6.5 0 0 1 19 8.6 5.2 5.2 0 0 1 18.5 19z", "#FFFFFF"], ["M7 19a5 5 0 0 1-3-1.1h17.7A5.1 5.1 0 0 1 18.5 19z", "#D6E4F0"]]],
  ["rainbow", "Rainbow", "weather", [
    ["M1 18a11 11 0 0 1 22 0h-2.5a8.5 8.5 0 0 0-17 0z", "#FF3B30"],
    ["M3.5 18a8.5 8.5 0 0 1 17 0H18a6 6 0 0 0-12 0z", "#FFCC00"],
    ["M6 18a6 6 0 0 1 12 0h-2.5a3.5 3.5 0 0 0-7 0z", "#34C759"],
    ["M8.5 18a3.5 3.5 0 0 1 7 0z", "#2F80FF"],
  ]],
  ["music", "Music Note", "fun", [["M9 3l12-2v14.5a3 3 0 1 1-2-2.8V5.4L11 6.8v11.7A3 3 0 1 1 9 15.7z", "#FF2D92"]]],
  ["sparkles", "Sparkles", "fun", [
    ["M10 2c.8 5.6 2.4 7.2 8 8-5.6.8-7.2 2.4-8 8-.8-5.6-2.4-7.2-8-8 5.6-.8 7.2-2.4 8-8z", "#FFC93C"],
    ["M19 13c.4 2.8 1.2 3.6 4 4-2.8.4-3.6 1.2-4 4-.4-2.8-1.2-3.6-4-4 2.8-.4 3.6-1.2 4-4zM19 1c.3 1.9.8 2.4 2.7 2.7-1.9.3-2.4.8-2.7 2.7-.3-1.9-.8-2.4-2.7-2.7C18.2 3.4 18.7 2.9 19 1z", "#FFE27A"],
  ]],
  ["gift", "Gift", "fun", [
    ["M3 8h18v4H3z", "#FF3B5C"],
    ["M4.5 12h15v10h-15z", "#FF5A73"],
    ["M10.8 8h2.4v14h-2.4z", "#FFD60A"],
    ["M12 8c-1.5-3-5.5-5-6.5-3S8 8 12 8zm0 0c1.5-3 5.5-5 6.5-3S16 8 12 8z", "#FFD60A"],
  ]],
  ["flower", "Flower", "nature", [
    ["M12 2.5a3.2 3.2 0 0 1 3 4.3 3.2 3.2 0 0 1 3.6 5.2 3.2 3.2 0 0 1-2.3 5.4A3.2 3.2 0 0 1 12 19a3.2 3.2 0 0 1-4.3-1.6 3.2 3.2 0 0 1-2.3-5.4A3.2 3.2 0 0 1 9 6.8a3.2 3.2 0 0 1 3-4.3z", "#FF7AB6"],
    ["M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", "#FFD60A"],
  ]],
  ["rocket", "Rocket", "fun", [
    ["M12 1c3.5 2.5 5 6.5 5 11l-2 4H9l-2-4c0-4.5 1.5-8.5 5-11z", "#E9EEF5"],
    ["M7 12l-3 3 1 4 4-3zM17 12l3 3-1 4-4-3z", "#FF3B5C"],
    ["M12 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4z", "#2F80FF"],
    ["M9.5 16h5l-1 4-1.5 3-1.5-3z", "#FF9F0A"],
  ]],
  ["eyes", "Eyes", "emoji", [
    ["M7 3c2.8 0 4.5 4 4.5 9S9.8 21 7 21s-4.5-4-4.5-9S4.2 3 7 3zm10 0c2.8 0 4.5 4 4.5 9s-1.7 9-4.5 9-4.5-4-4.5-9 1.7-9 4.5-9z", "#FFFFFF"],
    ["M8 9.5c1.2 0 2 1.4 2 3.2S9.2 16 8 16s-2-1.4-2-3.3.8-3.2 2-3.2zm10 0c1.2 0 2 1.4 2 3.2S19.2 16 18 16s-2-1.4-2-3.3.8-3.2 2-3.2z", "#1C1C1E"],
  ]],
  ["hundred", "Hundred", "emoji", [
    ["M2.5 5h3v11h-3zM10 5a3.5 5.5 0 1 1 0 11 3.5 5.5 0 0 1 0-11zm0 2.4c-.7 0-1 1.4-1 3.1s.3 3.1 1 3.1 1-1.4 1-3.1-.3-3.1-1-3.1zM18 5a3.5 5.5 0 1 1 0 11 3.5 5.5 0 0 1 0-11zm0 2.4c-.7 0-1 1.4-1 3.1s.3 3.1 1 3.1 1-1.4 1-3.1-.3-3.1-1-3.1z", "#FF2D55"],
    ["M2 18.5c6-1.6 13-1.6 20 0l-.5 1.6c-6.5-1.4-12.5-1.4-19 0zM3 21.5c5.5-1.3 12-1.3 18 0l-.4 1.3c-5.6-1.1-11.6-1.1-17.2 0z", "#FF2D55"],
  ]],
];

export const STICKERS_CATALOG: CatalogItem<{ svgPath: string; viewBox: string; defaultColor: string; parts?: { d: string; fill: string }[] }>[] = [
  ...COLOR_STICKERS.map(([id, name, category, parts]) => ({
    id,
    name,
    category,
    data: { svgPath: parts.map(([d]) => d).join(" "), viewBox: "0 0 24 24", defaultColor: parts[0][1], parts: parts.map(([d, fill]) => ({ d, fill })) },
  })),
  ...STICKERS.map(([id, name, category, svgPath]) => ({
    id,
    name,
    category,
    data: { svgPath, viewBox: "0 0 24 24", defaultColor: "#FFFFFF" },
  })),
];

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

/** The inspector tool panels and the element types they apply to. */
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
  ["clipAnimation", "Animation", "edit", ["video", "image", "sticker", "shape"], ["setClipAnimation"]],
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
