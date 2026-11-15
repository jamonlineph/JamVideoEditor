import { fontStack, type CaptionLayer, type ShapeLayer, type StickerLayer, type TextLayer, type TextStyle } from "@openedits/core";

export interface Raster {
  canvas: OffscreenCanvas;
  width: number;
  height: number;
}

interface Segment {
  text: string;
  color: string;
  fontWeight: number;
  scale: number;
  background?: string;
  /** Starts a new word (a space precedes it). */
  spaceBefore: boolean;
  newlineBefore: boolean;
  hidden: boolean;
  width?: number;
}

type Ctx = OffscreenCanvasRenderingContext2D;

function fontString(style: TextStyle, px: number, weight: number) {
  return `${style.italic ? "italic " : ""}${weight} ${px.toFixed(2)}px ${fontStack(style.fontFamily)}`;
}

function setSpacing(ctx: Ctx, px: number) {
  (ctx as unknown as { letterSpacing: string }).letterSpacing = `${px.toFixed(2)}px`;
}

function roundedRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

/** Lay out styled segments with word wrapping and draw them with stroke, shadow and backgrounds. */
function drawSegments(segments: Segment[], style: TextStyle, fontPx: number, maxWidthPx: number): Raster {
  const measure = new OffscreenCanvas(4, 4).getContext("2d")!;
  const spacing = style.letterSpacing * fontPx;
  for (const seg of segments) {
    measure.font = fontString(style, fontPx * seg.scale, seg.fontWeight);
    setSpacing(measure, spacing);
    seg.width = measure.measureText(seg.text).width;
  }
  measure.font = fontString(style, fontPx, style.fontWeight);
  setSpacing(measure, spacing);
  const spaceWidth = measure.measureText(" ").width;

  // Group into words, then wrap greedily.
  type Word = { segs: Segment[]; width: number; newline: boolean };
  const words: Word[] = [];
  for (const seg of segments) {
    if (!words.length || seg.spaceBefore || seg.newlineBefore) words.push({ segs: [], width: 0, newline: seg.newlineBefore });
    const w = words[words.length - 1];
    w.segs.push(seg);
    w.width += seg.width!;
  }
  type Line = { words: Word[]; width: number };
  const lines: Line[] = [];
  for (const word of words) {
    const cur = lines[lines.length - 1];
    if (!cur || word.newline || (cur.words.length > 0 && cur.width + spaceWidth + word.width > maxWidthPx)) lines.push({ words: [word], width: word.width });
    else {
      cur.words.push(word);
      cur.width += spaceWidth + word.width;
    }
  }
  if (!lines.length) lines.push({ words: [], width: 0 });

  const maxScale = Math.max(1, ...segments.map((s) => s.scale));
  const lineHeight = fontPx * style.lineHeight * maxScale;
  const hasBoxes = !!style.backgroundColor || segments.some((s) => s.background);
  const bgPad = hasBoxes ? fontPx * style.backgroundPadding : 0;
  const strokePx = style.strokeColor ? style.strokeWidth * fontPx : 0;
  const shadowPx = style.shadowColor ? (style.shadowBlur * 2 + Math.max(Math.abs(style.shadowOffsetX), Math.abs(style.shadowOffsetY))) * fontPx : 0;
  const margin = Math.ceil(bgPad + strokePx + shadowPx + fontPx * 0.2 + 2);
  const blockWidth = Math.max(1, ...lines.map((l) => l.width));
  const width = Math.ceil(blockWidth + margin * 2);
  const height = Math.ceil(lines.length * lineHeight + margin * 2);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  const lineX = (l: Line) => margin + (style.align === "left" ? 0 : style.align === "right" ? blockWidth - l.width : (blockWidth - l.width) / 2);
  const radiusFor = (h: number) => style.backgroundCornerRadius * (h / 2);

  // Pass 1: line backgrounds and per-segment boxes.
  lines.forEach((line, i) => {
    const visible = line.words.some((w) => w.segs.some((s) => !s.hidden));
    const top = margin + i * lineHeight;
    if (style.backgroundColor && visible && line.width > 0) {
      ctx.fillStyle = style.backgroundColor;
      roundedRect(ctx, lineX(line) - bgPad, top - bgPad * 0.35, line.width + bgPad * 2, lineHeight + bgPad * 0.7, radiusFor(lineHeight + bgPad * 0.7));
      ctx.fill();
    }
    let x = lineX(line);
    for (const word of line.words) {
      for (const seg of word.segs) {
        if (seg.background && !seg.hidden) {
          const pad = fontPx * 0.18;
          ctx.fillStyle = seg.background;
          roundedRect(ctx, x - pad, top + lineHeight * 0.06, seg.width! + pad * 2, lineHeight * 0.88, fontPx * 0.2);
          ctx.fill();
        }
        x += seg.width!;
      }
      x += spaceWidth;
    }
  });

  // Pass 2: glyphs.
  lines.forEach((line, i) => {
    const mid = margin + i * lineHeight + lineHeight / 2;
    let x = lineX(line);
    for (const word of line.words) {
      for (const seg of word.segs) {
        if (!seg.hidden && seg.text) {
          ctx.font = fontString(style, fontPx * seg.scale, seg.fontWeight);
          setSpacing(ctx, spacing);
          if (style.shadowColor) {
            ctx.shadowColor = style.shadowColor;
            ctx.shadowBlur = style.shadowBlur * fontPx;
            ctx.shadowOffsetX = style.shadowOffsetX * fontPx;
            ctx.shadowOffsetY = style.shadowOffsetY * fontPx;
          }
          if (strokePx > 0) {
            ctx.strokeStyle = style.strokeColor!;
            ctx.lineWidth = strokePx * 2;
            ctx.strokeText(seg.text, x, mid);
            ctx.shadowColor = "transparent";
          }
          ctx.fillStyle = seg.color;
          ctx.fillText(seg.text, x, mid);
          ctx.shadowColor = "transparent";
          if (style.underline) ctx.fillRect(x, mid + fontPx * seg.scale * 0.42, seg.width!, Math.max(1, fontPx * 0.06));
        }
        x += seg.width!;
      }
      x += spaceWidth;
    }
  });
  return { canvas, width, height };
}

export function rasterText(layer: TextLayer): Raster {
  const style = layer.style;
  const text = style.uppercase ? layer.text.toUpperCase() : layer.text;
  const chars = [...text];
  // Reveal: how many characters are visible.
  let visibleChars = chars.length;
  if (layer.reveal < 1) {
    if (layer.revealUnit === "word") {
      const wordStarts: number[] = [];
      chars.forEach((ch, i) => {
        if (!/\s/.test(ch) && (i === 0 || /\s/.test(chars[i - 1]))) wordStarts.push(i);
      });
      const shown = Math.floor(layer.reveal * wordStarts.length + 1e-6);
      visibleChars = shown >= wordStarts.length ? chars.length : wordStarts[shown] ?? 0;
    } else visibleChars = Math.floor(layer.reveal * chars.length + 1e-6);
  }
  const emphasisAt = (i: number) => layer.emphasis.find((e) => i >= e.startChar && i < e.endChar);
  const segments: Segment[] = [];
  let pendingSpace = false;
  let pendingNewline = false;
  let cur: Segment | null = null;
  let curKey = "";
  chars.forEach((ch, i) => {
    if (ch === "\n") {
      pendingNewline = true;
      cur = null;
      return;
    }
    if (/\s/.test(ch)) {
      pendingSpace = true;
      cur = null;
      return;
    }
    const em = emphasisAt(i);
    const hidden = i >= visibleChars;
    const key = `${em ? layer.emphasis.indexOf(em) : -1}:${hidden}`;
    if (!cur || key !== curKey || pendingSpace || pendingNewline) {
      cur = {
        text: "",
        color: em?.color ?? style.color,
        fontWeight: em?.fontWeight ?? style.fontWeight,
        scale: em?.scale ?? 1,
        ...(em?.backgroundColor ? { background: em.backgroundColor } : {}),
        spaceBefore: pendingSpace,
        newlineBefore: pendingNewline,
        hidden,
      };
      segments.push(cur);
      curKey = key;
      pendingSpace = false;
      pendingNewline = false;
    }
    cur.text += ch;
  });
  return drawSegments(segments, style, layer.fontPx, layer.maxWidthPx);
}

/** Which words of a caption are on screen, and which one is being spoken. */
export function captionWindow(layer: Pick<CaptionLayer, "words" | "localSeconds" | "maxWords" | "mode">): { from: number; to: number; active: number } {
  const { words, localSeconds: t } = layer;
  let active = -1;
  for (let i = 0; i < words.length; i++) if (words[i].startOffsetSeconds <= t + 1e-6) active = i;
  const size = Math.max(1, layer.maxWords);
  const chunk = Math.floor(Math.max(0, active) / size);
  return { from: chunk * size, to: Math.min(words.length, (chunk + 1) * size), active };
}

export function rasterCaption(layer: CaptionLayer): Raster {
  const style = layer.style;
  const { from, to, active } = captionWindow(layer);
  const segments: Segment[] = [];
  for (let i = from; i < to; i++) {
    const w = layer.words[i];
    const isActive = i === active;
    const spoken = i <= active;
    let color = style.color;
    let scale = 1;
    let background: string | undefined;
    if (w.highlighted) color = layer.highlightColor;
    if (layer.mode === "word" && isActive) color = layer.highlightColor;
    if (layer.mode === "karaoke" && spoken) color = layer.highlightColor;
    if (layer.mode === "pop" && isActive) {
      color = layer.highlightColor;
      scale = layer.activeWordScale;
    }
    if (layer.mode === "box" && isActive) background = layer.highlightColor;
    segments.push({
      text: style.uppercase ? w.text.toUpperCase() : w.text,
      color,
      fontWeight: style.fontWeight,
      scale,
      ...(background ? { background } : {}),
      spaceBefore: i > from,
      newlineBefore: false,
      hidden: layer.mode === "typewriter" && !spoken,
    });
  }
  return drawSegments(segments, style, layer.fontPx, layer.maxWidthPx);
}

export function rasterShape(layer: ShapeLayer): Raster {
  const pad = Math.ceil(layer.strokeWidthPx) + 2;
  const w = Math.max(1, layer.width);
  const h = Math.max(1, layer.height);
  const width = Math.ceil(w + pad * 2);
  const height = Math.ceil(h + pad * 2);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  if (layer.shape === "scrim") {
    const g = ctx.createLinearGradient(0, pad, 0, pad + h);
    g.addColorStop(0, layer.fillColor);
    g.addColorStop(1, layer.gradientToColor ?? "#00000000");
    ctx.fillStyle = g;
  } else ctx.fillStyle = layer.fillColor;
  if (layer.shape === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(pad + w / 2, pad + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else roundedRect(ctx, pad, pad, w, h, layer.shape === "rectangle" ? layer.cornerRadius * (Math.min(w, h) / 2) : 0);
  ctx.fill();
  if (layer.strokeColor && layer.strokeWidthPx > 0) {
    ctx.strokeStyle = layer.strokeColor;
    ctx.lineWidth = layer.strokeWidthPx;
    ctx.stroke();
  }
  return { canvas, width, height };
}

export function rasterSticker(layer: StickerLayer): Raster {
  const size = Math.max(2, Math.ceil(layer.width));
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = layer.fillColor;
  ctx.fill(new Path2D(layer.svgPath));
  return { canvas, width: size, height: size };
}

/** Stable cache key for a rasterized layer (pixel-identical output when equal). */
export function rasterKey(layer: TextLayer | CaptionLayer | ShapeLayer | StickerLayer): string {
  switch (layer.kind) {
    case "text":
      return JSON.stringify(["t", layer.text, layer.style, layer.fontPx.toFixed(2), layer.maxWidthPx.toFixed(1), layer.emphasis, layer.reveal < 1 ? layer.reveal.toFixed(4) : 1, layer.revealUnit]);
    case "caption": {
      const w = captionWindow(layer);
      return JSON.stringify(["c", layer.elementId, layer.words.map((x) => [x.text, x.highlighted]), layer.style, layer.fontPx.toFixed(2), layer.maxWidthPx.toFixed(1), layer.mode, layer.highlightColor, w]);
    }
    case "shape":
      return JSON.stringify(["s", layer.shape, layer.width.toFixed(1), layer.height.toFixed(1), layer.fillColor, layer.gradientToColor, layer.strokeColor, layer.strokeWidthPx.toFixed(2), layer.cornerRadius]);
    case "sticker":
      return JSON.stringify(["k", layer.stickerId, Math.ceil(layer.width), layer.fillColor]);
  }
}
