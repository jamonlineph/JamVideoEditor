import type { TextStyle } from "../schema.js";
import type { CatalogItem } from "./types.js";

type S = Partial<TextStyle>;
const W = "#FFFFFF";
const K = "#000000";

/** [id, name, category, style] — original text presets. */
const PRESETS: [string, string, string, S][] = [
  ["classic", "Classic", "basic", { fontFamily: "Helvetica Neue", fontWeight: 700, color: W }],
  ["classic_outline", "Classic Outline", "basic", { fontFamily: "Helvetica Neue", fontWeight: 800, color: W, strokeColor: K, strokeWidth: 0.12 }],
  ["clean_light", "Clean Light", "basic", { fontFamily: "Helvetica Neue", fontWeight: 300, color: W, letterSpacing: 0.02 }],
  ["label_black", "Label Black", "label", { fontFamily: "Helvetica Neue", fontWeight: 700, color: W, backgroundColor: "#000000CC", backgroundPadding: 0.3, backgroundCornerRadius: 0.15 }],
  ["label_white", "Label White", "label", { fontFamily: "Helvetica Neue", fontWeight: 700, color: K, backgroundColor: "#FFFFFFEE", backgroundPadding: 0.3, backgroundCornerRadius: 0.15 }],
  ["label_pill", "Pill", "label", { fontFamily: "Avenir Next", fontWeight: 700, color: W, backgroundColor: "#FF3B5CFF", backgroundPadding: 0.35, backgroundCornerRadius: 1 }],
  ["label_tape", "Tape", "label", { fontFamily: "Courier New", fontWeight: 700, color: K, backgroundColor: "#F5E6A8FF", backgroundPadding: 0.25, uppercase: true }],
  ["headline", "Headline", "title", { fontFamily: "Helvetica Neue", fontWeight: 900, fontSizeNorm: 0.09, color: W, uppercase: true, letterSpacing: -0.02 }],
  ["headline_yellow", "Headline Yellow", "title", { fontFamily: "Helvetica Neue", fontWeight: 900, fontSizeNorm: 0.09, color: "#FFE14D", strokeColor: K, strokeWidth: 0.08, uppercase: true }],
  ["impact", "Impact", "title", { fontFamily: "Impact", fontWeight: 400, fontSizeNorm: 0.1, color: W, strokeColor: K, strokeWidth: 0.1, uppercase: true }],
  ["serif_title", "Serif Title", "title", { fontFamily: "Georgia", fontWeight: 700, fontSizeNorm: 0.08, color: W }],
  ["serif_italic", "Serif Italic", "elegant", { fontFamily: "Georgia", fontWeight: 400, italic: true, color: W }],
  ["didot", "Editorial", "elegant", { fontFamily: "Didot", fontWeight: 400, fontSizeNorm: 0.075, color: W, letterSpacing: 0.04 }],
  ["typewriter", "Typewriter", "retro", { fontFamily: "American Typewriter", fontWeight: 400, color: W }],
  ["mono_code", "Mono", "retro", { fontFamily: "Menlo", fontWeight: 500, color: "#7CFFB2", backgroundColor: "#0B0F0CDD", backgroundPadding: 0.3 }],
  ["retro_shadow", "Retro Shadow", "retro", { fontFamily: "Futura", fontWeight: 800, color: "#FFD23F", shadowColor: "#EE4266FF", shadowOffsetX: 0.08, shadowOffsetY: 0.08, uppercase: true }],
  ["neon_pink", "Neon Pink", "neon", { fontFamily: "Avenir Next", fontWeight: 600, color: "#FFD6F5", shadowColor: "#FF2EC4FF", shadowBlur: 0.6 }],
  ["neon_blue", "Neon Blue", "neon", { fontFamily: "Avenir Next", fontWeight: 600, color: "#D6F4FF", shadowColor: "#2EB8FFFF", shadowBlur: 0.6 }],
  ["neon_green", "Neon Green", "neon", { fontFamily: "Avenir Next", fontWeight: 600, color: "#E2FFD6", shadowColor: "#4BFF2EFF", shadowBlur: 0.6 }],
  ["soft_shadow", "Soft Shadow", "basic", { fontFamily: "Avenir Next", fontWeight: 700, color: W, shadowColor: "#00000099", shadowBlur: 0.35, shadowOffsetY: 0.05 }],
  ["handwritten", "Handwritten", "fun", { fontFamily: "Bradley Hand", fontWeight: 700, color: W, fontSizeNorm: 0.075 }],
  ["marker", "Marker", "fun", { fontFamily: "Marker Felt", fontWeight: 700, color: "#FFFFFF", strokeColor: "#1A1A1A", strokeWidth: 0.06 }],
  ["bubble", "Bubble", "fun", { fontFamily: "Chalkboard SE", fontWeight: 700, color: "#FFFFFF", strokeColor: "#FF6FB5", strokeWidth: 0.18 }],
  ["comic", "Comic", "fun", { fontFamily: "Chalkboard SE", fontWeight: 700, color: "#111111", backgroundColor: "#FFE14DFF", backgroundPadding: 0.3, strokeColor: "#111111", strokeWidth: 0.02 }],
  ["sticker_text", "Sticker", "fun", { fontFamily: "Avenir Next", fontWeight: 900, color: "#111111", strokeColor: "#FFFFFF", strokeWidth: 0.25, uppercase: true }],
  ["lower_third", "Lower Third", "info", { fontFamily: "Helvetica Neue", fontWeight: 600, fontSizeNorm: 0.045, color: W, backgroundColor: "#111111CC", backgroundPadding: 0.4, align: "left" }],
  ["name_tag", "Name Tag", "info", { fontFamily: "Avenir Next", fontWeight: 700, fontSizeNorm: 0.045, color: K, backgroundColor: "#FFFFFFFF", backgroundPadding: 0.35, backgroundCornerRadius: 0.3, align: "left" }],
  ["quote", "Quote", "info", { fontFamily: "Georgia", fontWeight: 400, italic: true, fontSizeNorm: 0.055, color: W, lineHeight: 1.35 }],
  ["caption_small", "Small Caption", "info", { fontFamily: "Helvetica Neue", fontWeight: 500, fontSizeNorm: 0.035, color: W, shadowColor: "#000000AA", shadowBlur: 0.2 }],
  ["countdown", "Countdown", "title", { fontFamily: "Futura", fontWeight: 900, fontSizeNorm: 0.16, color: W, strokeColor: K, strokeWidth: 0.05 }],
  ["gradient_sunset", "Sunset", "color", { fontFamily: "Avenir Next", fontWeight: 900, color: "#FF8A5B", shadowColor: "#7A1FA2CC", shadowOffsetY: 0.06, uppercase: true }],
  ["mint_box", "Mint Box", "label", { fontFamily: "Avenir Next", fontWeight: 700, color: "#0E3B2E", backgroundColor: "#B8F5D9FF", backgroundPadding: 0.3, backgroundCornerRadius: 0.4 }],
  ["outline_only", "Outline Only", "basic", { fontFamily: "Helvetica Neue", fontWeight: 900, color: "#FFFFFF00", strokeColor: W, strokeWidth: 0.08, uppercase: true }],
  ["wide_spaced", "Wide Spaced", "elegant", { fontFamily: "Futura", fontWeight: 500, color: W, letterSpacing: 0.35, uppercase: true, fontSizeNorm: 0.045 }],
  ["highlighter", "Highlighter", "trending", { fontFamily: "Avenir Next", fontWeight: 800, color: K, backgroundColor: "#FFE14DFF", backgroundPadding: 0.25, backgroundCornerRadius: 0.1 }],
  ["bold_pop", "Bold Pop", "trending", { fontFamily: "Helvetica Neue", fontWeight: 900, fontSizeNorm: 0.085, color: W, strokeColor: "#FF3B5C", strokeWidth: 0.16, uppercase: true }],
  ["chat_bubble", "Chat Bubble", "trending", { fontFamily: "SF Pro Display", fontWeight: 600, color: W, backgroundColor: "#2F80FFFF", backgroundPadding: 0.45, backgroundCornerRadius: 0.8 }],
  ["reply_bubble", "Reply Bubble", "trending", { fontFamily: "SF Pro Display", fontWeight: 600, color: K, backgroundColor: "#E9E9EBFF", backgroundPadding: 0.45, backgroundCornerRadius: 0.8 }],
  ["glow_white", "White Glow", "neon", { fontFamily: "Avenir Next", fontWeight: 800, color: W, shadowColor: "#FFFFFFFF", shadowBlur: 0.5 }],
  ["fire", "Fire", "neon", { fontFamily: "Impact", fontWeight: 400, fontSizeNorm: 0.09, color: "#FFE9A8", shadowColor: "#FF5A1FFF", shadowBlur: 0.55, uppercase: true }],
  ["ice", "Ice", "neon", { fontFamily: "Futura", fontWeight: 800, color: "#E8FBFF", shadowColor: "#5AD8FFFF", shadowBlur: 0.45, uppercase: true }],
  ["gold", "Gold", "elegant", { fontFamily: "Didot", fontWeight: 700, fontSizeNorm: 0.08, color: "#F4D27A", shadowColor: "#7A4B00CC", shadowOffsetY: 0.05, letterSpacing: 0.06, uppercase: true }],
  ["shadow_box", "Shadow Box", "label", { fontFamily: "Futura", fontWeight: 800, color: K, backgroundColor: "#FFFFFFFF", backgroundPadding: 0.3, shadowColor: "#FF3B5CFF", shadowOffsetX: 0.08, shadowOffsetY: 0.08, uppercase: true }],
  ["ticket", "Ticket", "label", { fontFamily: "Courier New", fontWeight: 700, color: "#FFF3D6", backgroundColor: "#D7263DFF", backgroundPadding: 0.35, backgroundCornerRadius: 0.1, uppercase: true, letterSpacing: 0.1 }],
  ["chunky", "Chunky", "fun", { fontFamily: "Avenir Next", fontWeight: 900, fontSizeNorm: 0.1, color: "#FF6FB5", strokeColor: W, strokeWidth: 0.2, shadowColor: "#00000088", shadowOffsetY: 0.08 }],
  ["sky", "Sky", "color", { fontFamily: "Avenir Next", fontWeight: 900, color: "#7FD8FF", strokeColor: "#0B2A4A", strokeWidth: 0.1, uppercase: true }],
  ["lime", "Lime", "color", { fontFamily: "Helvetica Neue", fontWeight: 900, color: "#C6FF3D", shadowColor: "#000000CC", shadowOffsetY: 0.06, uppercase: true }],
  ["lavender", "Lavender", "color", { fontFamily: "Georgia", fontWeight: 700, italic: true, color: "#D9C2FF", shadowColor: "#4B2A86CC", shadowBlur: 0.3 }],
  ["subtitle_yellow", "Subtitle Yellow", "info", { fontFamily: "Helvetica Neue", fontWeight: 700, fontSizeNorm: 0.045, color: "#FFE14D", strokeColor: K, strokeWidth: 0.1 }],
  ["breaking", "Breaking", "info", { fontFamily: "Helvetica Neue", fontWeight: 900, fontSizeNorm: 0.05, color: W, backgroundColor: "#E50914FF", backgroundPadding: 0.35, uppercase: true, align: "left" }],
];

export const TEXT_PRESETS: CatalogItem<{ style: S }>[] = PRESETS.map(([id, name, category, style]) => ({
  id,
  name,
  category,
  data: { style },
}));

export type CaptionMode = "line" | "word" | "karaoke" | "box" | "pop" | "typewriter";

export interface CaptionStyleData {
  mode: CaptionMode;
  maxWords: number;
  highlightColor: string;
  activeWordScale: number;
  style: S;
}

/** [id, name, category, mode, maxWords, highlightColor, style] — 39 original caption styles. */
const CAPTIONS: [string, string, string, CaptionMode, number, string, S][] = [
  ["bold", "Bold", "essential", "word", 3, "#FFE14D", { fontFamily: "Helvetica Neue", fontWeight: 900, color: W, strokeColor: K, strokeWidth: 0.12, uppercase: true }],
  ["bold_green", "Bold Green", "essential", "word", 3, "#4BFF7A", { fontFamily: "Helvetica Neue", fontWeight: 900, color: W, strokeColor: K, strokeWidth: 0.12, uppercase: true }],
  ["clean", "Clean", "essential", "line", 6, "#FFFFFF", { fontFamily: "Helvetica Neue", fontWeight: 600, color: W, shadowColor: "#000000AA", shadowBlur: 0.25 }],
  ["clean_box", "Clean Box", "essential", "line", 6, "#FFFFFF", { fontFamily: "Helvetica Neue", fontWeight: 600, color: W, backgroundColor: "#000000B3", backgroundPadding: 0.3, backgroundCornerRadius: 0.2 }],
  ["subtitle", "Subtitle", "essential", "line", 8, "#FFFFFF", { fontFamily: "Helvetica Neue", fontWeight: 500, fontSizeNorm: 0.042, color: W, backgroundColor: "#00000099", backgroundPadding: 0.2 }],
  ["word_highlight", "Word Highlight", "highlight", "word", 3, "#FFE14D", { fontFamily: "Avenir Next", fontWeight: 800, color: W, strokeColor: K, strokeWidth: 0.08 }],
  ["word_highlight_box", "Word Highlight Box", "highlight", "box", 3, "#7C4DFF", { fontFamily: "Avenir Next", fontWeight: 800, color: W, strokeColor: K, strokeWidth: 0.04 }],
  ["word_highlight_box_2", "Word Highlight Box 2", "highlight", "box", 3, "#FF3B5C", { fontFamily: "Helvetica Neue", fontWeight: 900, color: W, uppercase: true }],
  ["word_highlight_box_3", "Word Highlight Box 3", "highlight", "box", 4, "#2EB8FF", { fontFamily: "Futura", fontWeight: 800, color: W }],
  ["karaoke", "Karaoke", "highlight", "karaoke", 5, "#4BFF7A", { fontFamily: "Avenir Next", fontWeight: 800, color: "#FFFFFFAA", strokeColor: K, strokeWidth: 0.06 }],
  ["karaoke_pink", "Karaoke Pink", "highlight", "karaoke", 5, "#FF6FB5", { fontFamily: "Avenir Next", fontWeight: 800, color: "#FFFFFFAA", strokeColor: K, strokeWidth: 0.06 }],
  ["pop", "Pop", "animated", "pop", 2, "#FFE14D", { fontFamily: "Helvetica Neue", fontWeight: 900, color: W, strokeColor: K, strokeWidth: 0.14, uppercase: true, fontSizeNorm: 0.075 }],
  ["pop_single", "Pop Single", "animated", "pop", 1, "#FFE14D", { fontFamily: "Helvetica Neue", fontWeight: 900, color: W, strokeColor: K, strokeWidth: 0.14, uppercase: true, fontSizeNorm: 0.09 }],
  ["bounce", "Bounce", "animated", "pop", 3, "#FF8A5B", { fontFamily: "Avenir Next", fontWeight: 900, color: W, shadowColor: "#000000CC", shadowOffsetY: 0.08 }],
  ["typewriter", "Typewriter", "animated", "typewriter", 6, "#FFFFFF", { fontFamily: "American Typewriter", fontWeight: 400, color: W, backgroundColor: "#00000099", backgroundPadding: 0.25 }],
  ["typewriter_mono", "Terminal", "animated", "typewriter", 6, "#7CFFB2", { fontFamily: "Menlo", fontWeight: 500, color: "#7CFFB2", backgroundColor: "#0B0F0CDD", backgroundPadding: 0.25 }],
  ["neon", "Neon", "glow", "word", 3, "#FF2EC4", { fontFamily: "Avenir Next", fontWeight: 700, color: "#FFD6F5", shadowColor: "#FF2EC4FF", shadowBlur: 0.6 }],
  ["neon_cyan", "Neon Cyan", "glow", "word", 3, "#2EB8FF", { fontFamily: "Avenir Next", fontWeight: 700, color: "#D6F4FF", shadowColor: "#2EB8FFFF", shadowBlur: 0.6 }],
  ["glow_soft", "Soft Glow", "glow", "line", 5, "#FFFFFF", { fontFamily: "Avenir Next", fontWeight: 600, color: W, shadowColor: "#FFFFFF88", shadowBlur: 0.5 }],
  ["serif", "Serif", "elegant", "line", 6, "#FFFFFF", { fontFamily: "Georgia", fontWeight: 400, color: W, shadowColor: "#00000088", shadowBlur: 0.2 }],
  ["serif_italic", "Serif Italic", "elegant", "line", 6, "#F5E6A8", { fontFamily: "Georgia", fontWeight: 400, italic: true, color: W }],
  ["editorial", "Editorial", "elegant", "line", 5, "#FFFFFF", { fontFamily: "Didot", fontWeight: 400, color: W, letterSpacing: 0.03 }],
  ["minimal_lower", "Minimal Lowercase", "minimal", "line", 6, "#FFFFFF", { fontFamily: "Helvetica Neue", fontWeight: 400, color: W, fontSizeNorm: 0.045 }],
  ["minimal_caps", "Minimal Caps", "minimal", "line", 4, "#FFFFFF", { fontFamily: "Futura", fontWeight: 500, color: W, uppercase: true, letterSpacing: 0.12, fontSizeNorm: 0.04 }],
  ["outline", "Outline", "minimal", "word", 3, "#FFFFFF", { fontFamily: "Helvetica Neue", fontWeight: 900, color: "#FFFFFF00", strokeColor: W, strokeWidth: 0.08, uppercase: true }],
  ["comic", "Comic", "fun", "word", 3, "#FF3B5C", { fontFamily: "Chalkboard SE", fontWeight: 700, color: "#111111", backgroundColor: "#FFE14DFF", backgroundPadding: 0.25 }],
  ["bubble", "Bubble", "fun", "pop", 2, "#FF6FB5", { fontFamily: "Chalkboard SE", fontWeight: 700, color: W, strokeColor: "#FF6FB5", strokeWidth: 0.18 }],
  ["marker", "Marker", "fun", "word", 3, "#FFE14D", { fontFamily: "Marker Felt", fontWeight: 700, color: W, strokeColor: "#1A1A1A", strokeWidth: 0.06 }],
  ["handwritten", "Handwritten", "fun", "line", 5, "#FFFFFF", { fontFamily: "Bradley Hand", fontWeight: 700, color: W }],
  ["retro", "Retro", "retro", "word", 3, "#EE4266", { fontFamily: "Futura", fontWeight: 800, color: "#FFD23F", shadowColor: "#EE4266FF", shadowOffsetX: 0.06, shadowOffsetY: 0.06, uppercase: true }],
  ["vhs", "VHS", "retro", "line", 5, "#2EB8FF", { fontFamily: "Courier New", fontWeight: 700, color: W, shadowColor: "#FF2E63CC", shadowOffsetX: 0.04 }],
  ["podcast", "Podcast", "talking", "line", 7, "#FFE14D", { fontFamily: "Avenir Next", fontWeight: 700, color: W, backgroundColor: "#111111CC", backgroundPadding: 0.3, backgroundCornerRadius: 0.25 }],
  ["podcast_highlight", "Podcast Highlight", "talking", "karaoke", 6, "#FFE14D", { fontFamily: "Avenir Next", fontWeight: 700, color: "#FFFFFFB3", backgroundColor: "#111111CC", backgroundPadding: 0.3, backgroundCornerRadius: 0.25 }],
  ["interview", "Interview", "talking", "line", 8, "#FFFFFF", { fontFamily: "Helvetica Neue", fontWeight: 500, color: W, fontSizeNorm: 0.04, shadowColor: "#000000AA", shadowBlur: 0.25 }],
  ["tutorial", "Tutorial", "talking", "word", 4, "#4BFF7A", { fontFamily: "Helvetica Neue", fontWeight: 800, color: W, backgroundColor: "#000000AA", backgroundPadding: 0.2 }],
  ["gaming", "Gaming", "energetic", "pop", 2, "#4BFF2E", { fontFamily: "Impact", fontWeight: 400, color: W, strokeColor: K, strokeWidth: 0.12, uppercase: true, fontSizeNorm: 0.085 }],
  ["hype", "Hype", "energetic", "pop", 2, "#FF3B5C", { fontFamily: "Helvetica Neue", fontWeight: 900, color: "#FFE14D", strokeColor: K, strokeWidth: 0.12, uppercase: true, fontSizeNorm: 0.085 }],
  ["sport", "Sport", "energetic", "word", 3, "#FF8A5B", { fontFamily: "Futura", fontWeight: 900, italic: true, color: W, strokeColor: K, strokeWidth: 0.08, uppercase: true }],
  ["luxury", "Luxury", "elegant", "line", 4, "#E6C47A", { fontFamily: "Didot", fontWeight: 400, color: "#E6C47A", letterSpacing: 0.12, uppercase: true, fontSizeNorm: 0.045 }],
];

export const CAPTION_STYLES: CatalogItem<CaptionStyleData>[] = CAPTIONS.map(([id, name, category, mode, maxWords, highlightColor, style]) => ({
  id,
  name,
  category,
  data: { mode, maxWords, highlightColor, activeWordScale: mode === "pop" ? 1.15 : 1, style: { fontSizeNorm: 0.06, ...style } },
}));

const ANIMS: [string, string, "in" | "out" | "loop"][] = [
  ["fade_in", "Fade In", "in"],
  ["slide_up", "Slide Up", "in"],
  ["slide_down", "Slide Down", "in"],
  ["slide_left", "Slide Left", "in"],
  ["slide_right", "Slide Right", "in"],
  ["zoom_in", "Zoom In", "in"],
  ["pop_in", "Pop In", "in"],
  ["typewriter", "Typewriter", "in"],
  ["blur_in", "Blur In", "in"],
  ["word_by_word", "Word by Word", "in"],
  ["bounce_in", "Bounce In", "in"],
  ["spin_in", "Spin In", "in"],
  ["swing_in", "Swing In", "in"],
  ["drop_in", "Drop In", "in"],
  ["fade_out", "Fade Out", "out"],
  ["slide_out_up", "Slide Out Up", "out"],
  ["slide_out_down", "Slide Out Down", "out"],
  ["zoom_out", "Zoom Out", "out"],
  ["pop_out", "Pop Out", "out"],
  ["blur_out", "Blur Out", "out"],
  ["slide_out_left", "Slide Out Left", "out"],
  ["slide_out_right", "Slide Out Right", "out"],
  ["spin_out", "Spin Out", "out"],
  ["erase", "Erase", "out"],
  ["pulse", "Pulse", "loop"],
  ["wiggle", "Wiggle", "loop"],
  ["float", "Float", "loop"],
  ["flicker", "Flicker", "loop"],
  ["shake", "Shake", "loop"],
  ["glow_pulse", "Glow Pulse", "loop"],
  ["bounce", "Bounce", "loop"],
  ["heartbeat", "Heartbeat", "loop"],
  ["swing", "Swing", "loop"],
  ["spin", "Spin", "loop"],
  ["blink", "Blink", "loop"],
];

export const TEXT_ANIMATIONS: CatalogItem<{ slot: "in" | "out" | "loop"; defaultDurationSeconds: number }>[] = ANIMS.map(([id, name, slot]) => ({
  id,
  name,
  category: slot,
  data: { slot, defaultDurationSeconds: slot === "loop" ? 1 : 0.4 },
}));

export const FONTS: CatalogItem<{ family: string; weights: number[]; builtIn: boolean }>[] = [
  ["Helvetica Neue", "sans", [300, 400, 500, 700, 900]],
  ["Avenir Next", "sans", [400, 500, 600, 700, 800, 900]],
  ["Futura", "sans", [500, 700, 800, 900]],
  ["SF Pro Display", "sans", [300, 400, 500, 600, 700, 800, 900]],
  ["Impact", "display", [400]],
  ["Georgia", "serif", [400, 700]],
  ["Didot", "serif", [400, 700]],
  ["Baskerville", "serif", [400, 600, 700]],
  ["American Typewriter", "mono", [300, 400, 600, 700]],
  ["Courier New", "mono", [400, 700]],
  ["Menlo", "mono", [400, 500, 700]],
  ["Marker Felt", "handwritten", [400, 700]],
  ["Bradley Hand", "handwritten", [700]],
  ["Chalkboard SE", "handwritten", [300, 400, 700]],
  ["Noteworthy", "handwritten", [300, 700]],
  ["Rockwell", "slab", [400, 700]],
].map(([family, category, weights]) => ({
  id: String(family).toLowerCase().replace(/\s+/g, "_"),
  name: family as string,
  category: category as string,
  data: { family: family as string, weights: weights as number[], builtIn: true },
}));

/** Look-alike fonts that ship with Windows and common Linux desktops, per catalog font. */
const FONT_FALLBACKS: Record<string, string[]> = {
  "Helvetica Neue": ["Helvetica", "Arial", "Liberation Sans", "Arimo"],
  "Avenir Next": ["Avenir", "Segoe UI", "Nunito Sans", "Century Gothic"],
  Futura: ["Futura PT", "Century Gothic", "Jost", "Trebuchet MS"],
  "SF Pro Display": ["-apple-system", "Segoe UI", "Inter", "Roboto"],
  Impact: ["Haettenschweiler", "Anton", "Arial Black", "Oswald"],
  Georgia: ["Times New Roman", "Liberation Serif", "Tinos", "DejaVu Serif"],
  Didot: ["Bodoni 72", "Bodoni MT", "Playfair Display", "Georgia", "Times New Roman"],
  Baskerville: ["Baskerville Old Face", "Libre Baskerville", "Georgia", "Times New Roman"],
  "American Typewriter": ["Courier Prime", "Courier New", "Liberation Mono"],
  "Courier New": ["Courier", "Liberation Mono", "Cousine", "Nimbus Mono PS"],
  Menlo: ["Consolas", "Cascadia Mono", "DejaVu Sans Mono", "Liberation Mono"],
  "Marker Felt": ["Comic Sans MS", "Segoe Print", "Comic Neue"],
  "Bradley Hand": ["Segoe Script", "Bradley Hand ITC", "Dancing Script"],
  "Chalkboard SE": ["Comic Sans MS", "Segoe Print", "Comic Neue"],
  Noteworthy: ["Segoe Print", "Comic Sans MS", "Comic Neue"],
  Rockwell: ["Rockwell Nova", "Roboto Slab", "Zilla Slab", "Georgia"],
};

const GENERIC: Record<string, string> = { sans: "sans-serif", display: "sans-serif", serif: "serif", mono: "monospace", slab: "serif", handwritten: "cursive" };

/**
 * A CSS font-family list for a font name: the font itself, then similar fonts that ship with
 * Windows and Linux, then a generic family of the same kind (so a serif stays a serif).
 */
export function fontStack(family: string | undefined): string {
  if (!family) family = "Helvetica Neue";
  const item = FONTS.find((f) => f.data.family === family);
  const quote = (f: string) => (f.startsWith("-") ? f : `"${f.replace(/"/g, "")}"`);
  const fallbacks = FONT_FALLBACKS[family] ?? ["Helvetica Neue", "Arial", "Segoe UI", "Liberation Sans"];
  return [family, ...fallbacks].map(quote).join(", ") + `, ${GENERIC[item?.category ?? "sans"] ?? "sans-serif"}`;
}
