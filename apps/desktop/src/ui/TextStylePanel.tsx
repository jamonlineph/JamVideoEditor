import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  CAPTION_STYLES,
  FONTS,
  TEXT_PRESETS,
  captionText,
  defaultTextStyle,
  fontStack,
  isHexColor,
  isVisibleHexColor,
  resolveCaptionStyle,
  type CaptionElement,
  type TextElement,
  type TextStyle,
} from "@openedits/core";
import { live } from "./live.js";
import { ui, type UiState } from "./uiStore.js";

const FONT_CATEGORIES: Record<string, string> = { display: "Display", sans: "Sans serif", serif: "Serif", mono: "Monospace", handwritten: "Handwritten", slab: "Slab serif" };
const WEIGHTS: Record<number, string> = { 100: "Thin", 200: "Extra Light", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semi Bold", 700: "Bold", 800: "Extra Bold", 900: "Black" };
const FEATURED_TITLES = new Set(["classic", "headline", "label_pill", "lower_third", "serif_title", "outline_only"]);
const FEATURED_CAPTIONS = new Set(["clean", "bold", "subtitle", "word_highlight_box", "karaoke", "pop"]);
const installedFonts = new Map<string, boolean>();

function systemFontAvailable(family: string): boolean {
  const cached = installedFonts.get(family);
  if (cached !== undefined) return cached;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return true;
  const measure = (font: string) => {
    ctx.font = `48px ${font}`;
    const metrics = ctx.measureText("MWiilQ .AaJy 01234");
    return `${metrics.width}/${metrics.actualBoundingBoxAscent}/${metrics.actualBoundingBoxDescent}`;
  };
  const available = ["monospace", "serif", "sans-serif"].some((fallback) => measure(`"${family.replace(/["\\]/g, "")}", ${fallback}`) !== measure(fallback));
  installedFonts.set(family, available);
  return available;
}

type StylingElement = TextElement | CaptionElement;
type StylePatch = Partial<TextStyle>;
type NumericKey = { [K in keyof TextStyle]: TextStyle[K] extends number ? K : never }[keyof TextStyle] & keyof TextStyle;
type PreviewControl<T> = { label: string; value: T; preview: (value: T) => void; commit: (value: T) => void; cancel: () => void };

function ShortSample({ sample, style }: { sample: string; style: CSSProperties }) {
  return <span className="text-style-sample" dir="auto" style={style}>{sample}</span>;
}

function FontPicker({ sample, style, onPick }: { sample: string; style: TextStyle; onPick: (font: (typeof FONTS)[number]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    setQuery("");
    trigger.current?.focus();
  };
  const words = query.toLowerCase().trim().split(/\s+/);
  const matches = FONTS.filter((font) => words.every((word) => `${font.name} ${FONT_CATEGORIES[font.category] ?? font.category}`.toLowerCase().includes(word)));
  const currentFont = FONTS.find((font) => font.data.family === style.fontFamily);
  const currentFallback = !currentFont?.data.builtIn && !systemFontAvailable(style.fontFamily);
  return (
    <div className="text-style-font" onKeyDown={(event) => {
      if (open && event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    }}>
      <button type="button" className="text-style-font-trigger" aria-label={`Font, ${style.fontFamily}${currentFallback ? ", using fallback" : ""}`} aria-expanded={open} aria-controls={open ? listId : undefined} ref={trigger} onClick={() => open ? close() : setOpen(true)}>
        <span>Font</span>
        <ShortSample sample={`${style.fontFamily}${currentFallback ? " · Fallback" : ""}`} style={{ fontFamily: fontStack(style.fontFamily) }} />
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div id={listId} className="text-style-font-picker">
          <input type="search" aria-label="Search fonts" placeholder="Search fonts" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus />
          <div className="text-style-font-list">
            {matches.length === 0 && <p className="muted small" role="status">No matching fonts</p>}
            {([true, false] as const).map((bundled) => {
              const fonts = matches.filter((font) => font.data.builtIn === bundled);
              if (!fonts.length) return null;
              return (
                <div key={String(bundled)} role="group" aria-label={bundled ? "Included fonts" : "System fonts"}>
                  <div className="section-title">{bundled ? "Included fonts" : "System fonts · may vary by device"}</div>
                  {fonts.map((font) => {
                    const fallback = !bundled && !systemFontAvailable(font.data.family);
                    return <button type="button" key={font.id} aria-label={`${font.name}${fallback ? ", using fallback" : ""}`} aria-pressed={font.data.family === style.fontFamily} onClick={() => { onPick(font); close(); }}>
                      <span title={fallback ? "This device uses a fallback for this font" : undefined}>{font.name}{fallback && <small>Fallback</small>}</span>
                      <ShortSample sample={sample} style={{ fontFamily: fontStack(font.data.family) }} />
                    </button>;
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function PrecisionControl({ label, value, min, max, step, scale = 1, preview, commit, cancel }: PreviewControl<number> & { min: number; max: number; step: number; scale?: number }) {
  const rangeId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const position = Number((value * scale).toFixed(5));
  const number = (candidate: string) => candidate.trim() === "" ? NaN : Number(candidate);
  const clamp = (candidate: number) => Math.max(min, Math.min(max, candidate));
  const update = (next: string) => {
    pending.current = next;
    setDraft(next);
    const raw = number(next);
    if (Number.isFinite(raw) && raw >= min && raw <= max) preview(raw / scale);
    else cancel();
  };
  const finish = () => {
    const next = pending.current === null ? NaN : number(pending.current);
    pending.current = null;
    setDraft(null);
    if (Number.isFinite(next) && clamp(next) !== position) commit(clamp(next) / scale);
    else cancel();
  };
  const discard = () => {
    pending.current = null;
    setDraft(null);
    cancel();
  };
  return (
    <div className="text-style-control" onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        discard();
      }
    }}>
      <label htmlFor={rangeId}>{label}</label>
      <input id={rangeId} type="range" min={min} max={max} step={step} value={draft === null || !Number.isFinite(number(draft)) ? position : clamp(number(draft))}
        onChange={(event) => update(event.currentTarget.value)} onPointerUp={finish} onPointerCancel={discard} onKeyUp={(event) => { if (event.key !== "Escape") finish(); }} onBlur={() => { if (pending.current !== null) finish(); }} />
      <input aria-label={`${label} value`} type="number" min={min} max={max} step={step} value={draft ?? position} onChange={(event) => update(event.currentTarget.value)} onBlur={() => { if (pending.current !== null) finish(); }} onKeyDown={(event) => { if (event.key === "Enter") finish(); }} />
    </div>
  );
}

function ColorControl({ label, value, preview, commit, cancel }: PreviewControl<string>) {
  const colorId = useId();
  const hexId = useId();
  const color = useRef<HTMLInputElement>(null);
  const pending = useRef<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const update = (next: string) => {
    pending.current = next;
    setDraft(next);
    if (isHexColor(next)) preview(next.toUpperCase());
    else cancel();
  };
  const discard = () => {
    pending.current = null;
    setDraft(null);
    cancel();
  };
  const finish = () => {
    const next = pending.current?.toUpperCase();
    pending.current = null;
    setDraft(null);
    if (next && isHexColor(next) && next !== value.toUpperCase()) commit(next);
    else cancel();
  };
  // A native color picker can emit many input events before its single change event.
  useEffect(() => {
    const input = color.current!;
    input.addEventListener("change", finish);
    return () => input.removeEventListener("change", finish);
  });
  return (
    <div className="text-style-control text-style-color" onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        discard();
      }
    }}>
      <label htmlFor={colorId}>{label}</label>
      <input ref={color} id={colorId} type="color" value={isHexColor(draft ?? "") ? draft!.slice(0, 7) : value.slice(0, 7)} onInput={(event) => update(event.currentTarget.value.toUpperCase() + value.slice(7))} onChange={() => {}} />
      <input id={hexId} aria-label={`${label} hex`} type="text" value={draft ?? value} maxLength={9} spellCheck={false} onChange={(event) => update(event.currentTarget.value)} onBlur={() => { if (pending.current !== null) finish(); }} onKeyDown={(event) => { if (event.key === "Enter") finish(); }} />
    </div>
  );
}

function StyleSection({ label, children, status }: { label: string; children: ReactNode; status?: string }) {
  return (
    <details className="text-style-section">
      <summary>{label}{status && <span>{status}</span>}</summary>
      {children}
    </details>
  );
}

function Presets({ caption, active, sample, onPick }: { caption: boolean; active?: string; sample: string; onPick: (id: string) => void }) {
  const [browseAll, setBrowseAll] = useState(false);
  const [category, setCategory] = useState("");
  const presets = caption ? CAPTION_STYLES : TEXT_PRESETS;
  const categories = [...new Set(presets.map((preset) => preset.category))];
  const featured = caption ? FEATURED_CAPTIONS : FEATURED_TITLES;
  const visible = browseAll ? presets.filter((preset) => !category || preset.category === category) : presets.filter((preset) => featured.has(preset.id));
  return (
    <StyleSection label="Presets" status={presets.find((preset) => preset.id === active)?.name ?? "Custom"}>
      {browseAll && <select aria-label="Preset category" value={category} onChange={(event) => setCategory(event.currentTarget.value)}>
        <option value="">All styles</option>
        {categories.map((key) => <option key={key} value={key}>{key[0].toUpperCase() + key.slice(1)}</option>)}
      </select>}
      <div className="text-style-presets">
        {visible.map((preset) => {
          const { data } = preset;
          const { style } = data;
          let foreground = style.color;
          let background = style.backgroundColor;
          if ("mode" in data && "highlightColor" in data && typeof data.highlightColor === "string" && data.mode !== "line" && data.mode !== "typewriter") {
            if (data.mode === "box") background = data.highlightColor;
            else foreground = data.highlightColor;
          }
          return (
            <button type="button" key={preset.id} aria-label={`Apply ${preset.name} preset`} aria-pressed={active === preset.id} onClick={() => onPick(preset.id)}>
              <ShortSample sample={style.uppercase ? sample.toUpperCase() : sample} style={{ fontFamily: fontStack(style.fontFamily), fontWeight: style.fontWeight, fontStyle: style.italic ? "italic" : undefined, color: foreground, backgroundColor: background, WebkitTextStroke: style.strokeColor ? `0.8px ${style.strokeColor}` : undefined, textShadow: style.shadowColor ? `0 0 6px ${style.shadowColor}` : undefined }} />
              <span>{preset.name}</span>
            </button>
          );
        })}
      </div>
      <button type="button" className="ghost" onClick={() => setBrowseAll(!browseAll)}>{browseAll ? "Show featured" : "Browse all"}</button>
    </StyleSection>
  );
}

export function TextStylePanel({ element, selectedIds = [element.id], captionIds }: { element: StylingElement; selectedIds?: string[]; captionIds: string[] }) {
  const [allCaptions, setAllCaptions] = useState(false);
  const draft = useRef<UiState["textStyleDraft"]>(null);
  const caption = element.type === "caption" ? element : null;
  const style = element.type === "text" ? element.style : resolveCaptionStyle(element).style;
  const ids = caption && allCaptions ? captionIds : selectedIds;
  const sample = (element.type === "text" ? element.text : captionText(element)).replace(/\s+/g, " ").trim() || "Aa";
  const font = FONTS.find((item) => item.data.family === style.fontFamily);
  const weights = [...new Set([...(font?.data.weights ?? [400, 700]), style.fontWeight])].sort((a, b) => a - b);
  const outline = isVisibleHexColor(style.strokeColor) && style.strokeWidth > 0;
  const shadow = isVisibleHexColor(style.shadowColor);
  const background = isVisibleHexColor(style.backgroundColor);
  const clearDraft = useCallback(() => {
    if (draft.current && ui.get().textStyleDraft === draft.current) ui.set({ textStyleDraft: null });
    draft.current = null;
  }, []);
  useEffect(() => clearDraft, [clearDraft]);
  const preview = (patch: StylePatch, highlightColor?: string) => {
    draft.current = { elementIds: ids, patch, highlightColor };
    ui.set({ textStyleDraft: draft.current });
  };
  const commit = async (tool: string, args: Record<string, unknown>) => {
    const current = draft.current;
    await live.run(tool, args);
    if (draft.current === current) clearDraft();
  };
  const setStyle = (patch: StylePatch) => void commit("setTextStyle", { elementIds: ids, ...patch });
  const pickFont = (next: (typeof FONTS)[number]) => {
    const { family, italic, weights: available } = next.data;
    const weight = available.reduce((closest, candidate) => Math.abs(candidate - style.fontWeight) < Math.abs(closest - style.fontWeight) ? candidate : closest);
    setStyle({ fontFamily: family, fontWeight: weight, ...(italic === false ? { italic: false } : {}) });
  };
  const numberProps = (key: NumericKey, label: string): PreviewControl<number> => ({ label, value: style[key], preview: (value) => preview({ [key]: value }), commit: (value) => setStyle({ [key]: value }), cancel: clearDraft });
  const colorProps = (key: "color" | "strokeColor" | "shadowColor" | "backgroundColor", label: string): PreviewControl<string> => ({ label, value: style[key] ?? "#000000", preview: (value) => preview({ [key]: value }), commit: (value) => setStyle({ [key]: value }), cancel: clearDraft });
  const pickPreset = (id: string) => {
    if (caption) void commit("setCaptionStyle", { elementIds: ids, styleId: id, usePresetHighlight: true });
    else void commit("applyTextPreset", { elementId: element.id, presetId: id, replaceStyle: true });
  };
  const captionPreset = caption && CAPTION_STYLES.find((preset) => preset.id === caption.styleId);
  const titlePreset = element.type === "text" && TEXT_PRESETS.find((preset) => preset.id === element.presetId);
  const titleBaseline = defaultTextStyle(titlePreset ? titlePreset.data.style : undefined);
  const titleModified = Object.keys({ ...style, ...titleBaseline }).some((key) => style[key as keyof TextStyle] !== titleBaseline[key as keyof TextStyle]);
  const modified = caption ? Object.keys(caption.styleOverrides).length > 0 || Boolean(captionPreset && caption.highlightColor !== captionPreset.data.highlightColor) : titleModified;
  const activePreset = modified || ids.length > 1 ? undefined : caption ? caption.styleId : element.type === "text" ? element.presetId : undefined;

  return (
    <div className="text-style-panel">
      {caption && captionIds.length > selectedIds.length && (
        <fieldset className="text-style-scope">
          <legend>Apply to</legend>
          <label><input type="radio" name="caption-style-scope" checked={!allCaptions} onChange={() => { clearDraft(); setAllCaptions(false); }} />{selectedIds.length === 1 ? "This caption" : "Selected captions"}</label>
          <label><input type="radio" name="caption-style-scope" checked={allCaptions} onChange={() => { clearDraft(); setAllCaptions(true); }} />All captions</label>
        </fieldset>
      )}
      <Presets caption={!!caption} active={activePreset} sample={sample} onPick={pickPreset} />
      <FontPicker sample={sample} style={style} onPick={pickFont} />
      <div className="text-style-control text-style-select">
        <label htmlFor="text-style-weight">Weight</label>
        <select id="text-style-weight" value={style.fontWeight} onChange={(event) => setStyle({ fontWeight: Number(event.currentTarget.value) })}>
          {weights.map((weight) => <option key={weight} value={weight}>{WEIGHTS[weight] ?? weight}</option>)}
        </select>
      </div>
      <PrecisionControl {...numberProps("fontSizeNorm", "Size (%)")} min={0.1} max={100} step={0.1} scale={100} />
      <ColorControl {...colorProps("color", "Fill")} />
      <div className="text-style-control text-style-select">
        <label htmlFor="text-style-align">Alignment</label>
        <select id="text-style-align" value={style.align} onChange={(event) => setStyle({ align: event.currentTarget.value as TextStyle["align"] })}>
          <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
        </select>
      </div>
      <div className="text-style-toggles" role="group" aria-label="Text formatting">
        <button type="button" aria-pressed={style.italic} disabled={font?.data.italic === false} onClick={() => setStyle({ italic: !style.italic })}>Italic</button>
        <button type="button" aria-pressed={style.underline} onClick={() => setStyle({ underline: !style.underline })}>Underline</button>
        <button type="button" aria-pressed={style.uppercase} onClick={() => setStyle({ uppercase: !style.uppercase })}>Uppercase</button>
      </div>
      {caption && <ColorControl label="Highlight" value={caption.highlightColor} preview={(color) => preview({}, color)} cancel={clearDraft} commit={(color) => void commit("setCaptionHighlightColor", { elementIds: ids, color })} />}
      <StyleSection label="Spacing and wrapping">
        <PrecisionControl {...numberProps("letterSpacing", "Letter spacing (em)")} min={-1} max={2} step={0.01} />
        <PrecisionControl {...numberProps("lineHeight", "Line height (×)")} min={0.1} max={4} step={0.05} />
        <PrecisionControl {...numberProps("maxWidthNorm", "Max width (%)")} min={1} max={100} step={1} scale={100} />
      </StyleSection>
      <StyleSection label="Outline" status={outline ? "On" : "Off"}>
        <label className="text-style-effect-toggle"><input type="checkbox" checked={outline} onChange={() => setStyle(outline ? { strokeColor: "#00000000" } : { strokeColor: isVisibleHexColor(style.strokeColor) ? style.strokeColor : "#000000", strokeWidth: style.strokeWidth || 0.08 })} />Show outline</label>
        {outline && <><ColorControl {...colorProps("strokeColor", "Color")} /><PrecisionControl {...numberProps("strokeWidth", "Width (%)")} min={1} max={100} step={1} scale={100} /></>}
      </StyleSection>
      <StyleSection label="Shadow" status={shadow ? "On" : "Off"}>
        <label className="text-style-effect-toggle"><input type="checkbox" checked={shadow} onChange={() => setStyle(shadow ? { shadowColor: "#00000000" } : { shadowColor: "#000000B3", ...(!style.shadowBlur && !style.shadowOffsetX && !style.shadowOffsetY ? { shadowBlur: 0.15, shadowOffsetY: 0.08 } : {}) })} />Show shadow</label>
        {shadow && <>
          <ColorControl {...colorProps("shadowColor", "Color")} />
          <PrecisionControl {...numberProps("shadowBlur", "Blur (%)")} min={0} max={100} step={1} scale={100} />
          <PrecisionControl {...numberProps("shadowOffsetX", "Horizontal (%)")} min={-100} max={100} step={1} scale={100} />
          <PrecisionControl {...numberProps("shadowOffsetY", "Vertical (%)")} min={-100} max={100} step={1} scale={100} />
        </>}
      </StyleSection>
      <StyleSection label="Background" status={background ? "On" : "Off"}>
        <label className="text-style-effect-toggle"><input type="checkbox" checked={background} onChange={() => setStyle({ backgroundColor: background ? "#00000000" : "#000000B3" })} />Show background</label>
        {background && <>
          <ColorControl {...colorProps("backgroundColor", "Color")} />
          <PrecisionControl {...numberProps("backgroundPadding", "Padding (%)")} min={0} max={200} step={1} scale={100} />
          <PrecisionControl {...numberProps("backgroundCornerRadius", "Roundness (%)")} min={0} max={100} step={1} scale={100} />
        </>}
      </StyleSection>
      <button type="button" className="ghost text-style-reset" disabled={!modified && ids.length === 1} onClick={() => void commit("setTextStyle", { elementIds: ids, reset: true })}>Reset style</button>
    </div>
  );
}
