import {
  ADJUST_PRESETS,
  EFFECTS_CATALOG,
  FILTERS_CATALOG,
  Session,
  addMediaAssets,
  addMediaToTimeline,
  addTransition,
  applyEffect,
  applyFilter,
  applyLut,
  builtinLut,
  createProject,
  logEncoder,
  evaluateScene,
  mainTrack,
  randomIds,
  setColorGrade,
  type MediaAsset,
} from "@openedits/core";
import { Compositor, type LutTexture, type SceneResources, type TextureInfo } from "@openedits/renderer";

/**
 * Preview thumbnails for effects, transitions, filters, adjust presets and LUTs, drawn by the same
 * compositor the viewport and exports use, on built-in sample pictures. Stills are cached as data
 * URLs; hovering a tile animates it (an intensity sweep for looks, the full move for transitions).
 */
export type PreviewKind = "effect" | "subject" | "transition" | "filter" | "lut" | "adjust";

export const THUMB_W = 320;
export const THUMB_H = 180;

/**
 * Settings that make subtle effects readable at thumbnail size (a 4% blur of a 72 px tall tile is
 * under 3 px). The effect itself is the same; only its strength is turned up for the preview.
 */
const PREVIEW_PARAMS: Record<string, Record<string, number>> = {
  blur: { radius: 100 },
  letterbox: { size: 100 },
  wave: { amount: 100, frequency: 6 },
  neon_edges: { thickness: 3 },
  sketch: { strength: 80 },
  sparkle: { density: 60, size: 90 },
  snow: { density: 40 },
  motion_blur: { amount: 90 },
  zoom_blur: { amount: 80 },
  tilt_shift: { width: 0.12 },
  film_grain: { amount: 60, size: 4 },
  pixelate: { size: 60 },
  halftone: { dotSize: 18 },
  chromatic_aberration: { amount: 60 },
  glow: { threshold: 55, radius: 50 },
  vignette: { amount: 80 },
  sharpen: { amount: 100 },
  denoise: { amount: 100 },
  light_leak: { speed: 1 },
  shake: { amount: 90 },
  zoom_pulse: { amount: 70 },
};

/** Effects that move over time: their still is taken at the moment they show most. */
const ANIMATED = new Set(["flash", "zoom_pulse", "shake", "glitch", "light_leak", "vhs", "film_grain", "rainbow", "snow", "sparkle", "wave", "old_film", "strobe"]);

type Pixels = Uint8ClampedArray;

function paint(draw: (g: CanvasRenderingContext2D) => void): Pixels {
  const c = document.createElement("canvas");
  c.width = THUMB_W;
  c.height = THUMB_H;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  draw(g);
  return g.getImageData(0, 0, THUMB_W, THUMB_H).data;
}

/** A person standing in the frame (the "subject" for subject effects). */
function person(g: CanvasRenderingContext2D, fill: string) {
  g.fillStyle = fill;
  g.beginPath();
  g.arc(118, 74, 15, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.moveTo(96, 180);
  g.quadraticCurveTo(94, 100, 118, 94);
  g.quadraticCurveTo(142, 100, 140, 180);
  g.closePath();
  g.fill();
}

/** Sunset over hills, with a person, fine grass detail and a bright sun (so glows and blurs show). */
function sunset(g: CanvasRenderingContext2D) {
  const sky = g.createLinearGradient(0, 0, 0, THUMB_H);
  sky.addColorStop(0, "#2b2a6b");
  sky.addColorStop(0.45, "#c2557a");
  sky.addColorStop(0.75, "#ffb35c");
  g.fillStyle = sky;
  g.fillRect(0, 0, THUMB_W, THUMB_H);
  g.fillStyle = "#fff4c2";
  g.beginPath();
  g.arc(236, 98, 24, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#5b3a6e";
  g.beginPath();
  g.moveTo(0, 120);
  for (let x = 0; x <= THUMB_W; x += 20) g.lineTo(x, 112 - 18 * Math.sin(x / 37) - 10 * Math.sin(x / 13));
  g.lineTo(THUMB_W, THUMB_H);
  g.lineTo(0, THUMB_H);
  g.fill();
  g.fillStyle = "#2f6b3a";
  g.fillRect(0, 140, THUMB_W, 40);
  g.strokeStyle = "#4f9a4c";
  for (let x = 2; x < THUMB_W; x += 5) {
    g.beginPath();
    g.moveTo(x, 180);
    g.lineTo(x + 2, 146 + (x % 7));
    g.stroke();
  }
  person(g, "#1c1426");
  g.fillStyle = "rgba(255,255,255,0.9)";
  for (const [x, y] of [[30, 20], [70, 34], [180, 16], [290, 28], [258, 46]]) g.fillRect(x, y, 2, 2);
}

/** Seaside at midday: the clip a transition goes to. */
function seaside(g: CanvasRenderingContext2D) {
  const sky = g.createLinearGradient(0, 0, 0, 110);
  sky.addColorStop(0, "#2f8fe0");
  sky.addColorStop(1, "#bfe6ff");
  g.fillStyle = sky;
  g.fillRect(0, 0, THUMB_W, 110);
  const sea = g.createLinearGradient(0, 110, 0, THUMB_H);
  sea.addColorStop(0, "#1f9fb5");
  sea.addColorStop(1, "#0b4f7a");
  g.fillStyle = sea;
  g.fillRect(0, 110, THUMB_W, 70);
  g.fillStyle = "#f2e2b5";
  g.beginPath();
  g.moveTo(0, 150);
  g.quadraticCurveTo(140, 130, 320, 170);
  g.lineTo(320, 180);
  g.lineTo(0, 180);
  g.fill();
  g.fillStyle = "#ffffff";
  for (const [x, y, r] of [[60, 34, 14], [80, 30, 18], [100, 36, 13], [220, 50, 12], [238, 46, 16]]) {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.moveTo(200, 70);
  g.lineTo(200, 118);
  g.lineTo(232, 118);
  g.closePath();
  g.fill();
  g.fillStyle = "#c0392b";
  g.fillRect(186, 118, 52, 7);
}

interface Engine {
  compositor: Compositor;
  session: Session;
  clipA: string;
  clipB: string;
  textures: Record<string, TextureInfo>;
  luts: Map<string, LutTexture | null>;
  sample: Pixels;
  /** Where finished preview frames are composed (split views, motion trails). */
  out: HTMLCanvasElement;
  /** The sample encoded in each camera's log curve (left half of LUT previews). */
  encoded: Map<string, { tex: TextureInfo; image: HTMLCanvasElement }>;
  /** Which texture stands in for log footage in the frame being drawn. */
  logTexture: TextureInfo | null;
}

let engine: Engine | null | undefined;

const toCanvas = (px: Pixels) => {
  const c = document.createElement("canvas");
  c.width = THUMB_W;
  c.height = THUMB_H;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(px), THUMB_W, THUMB_H), 0, 0);
  return c;
};

function setup(): Engine | null {
  if (engine !== undefined) return engine;
  try {
    const canvas = document.createElement("canvas");
    const compositor = new Compositor(canvas);
    const upload = (px: Pixels) => compositor.uploadPixels(null, new Uint8Array(px.buffer, px.byteOffset, px.byteLength), THUMB_W, THUMB_H);
    const a = paint(sunset);
    // A grainy copy gives the denoiser something to clean up.
    const noisy = new Uint8ClampedArray(a);
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    for (let i = 0; i < noisy.length; i += 4) {
      const n = rand() * 34;
      for (let k = 0; k < 3; k++) noisy[i + k] = a[i + k] + n + rand() * 14;
    }
    const textures = {
      med_preview_a: upload(a),
      med_preview_b: upload(paint(seaside)),
      med_preview_noisy: upload(noisy),
      med_preview_log: upload(a),
      med_preview_mask: upload(paint((g) => {
        g.fillStyle = "#000";
        g.fillRect(0, 0, THUMB_W, THUMB_H);
        person(g, "#fff");
      })),
    };
    const asset = (id: string): MediaAsset => ({ id, kind: "image", name: id, path: id, width: THUMB_W, height: THUMB_H, hasVideo: true, hasAudio: false, sizeBytes: 0, importedAt: 0 });
    const now = () => 0;
    const session = new Session(createProject({ id: "prj_previews", name: "Previews", canvas: { aspectRatio: "16:9", resolution: "720p" }, ids: randomIds, now: 0 }), { ids: randomIds, now });
    const ids = session.transact("setup", "preview", (ctx) => {
      addMediaAssets(ctx, Object.keys(textures).map(asset));
      const first = addMediaToTimeline(ctx, ctx.draft.media.med_preview_a, { durationSeconds: 4 });
      const second = addMediaToTimeline(ctx, ctx.draft.media.med_preview_b, { durationSeconds: 4 });
      return { a: first.id, b: second.id };
    }).result;
    const out = document.createElement("canvas");
    out.width = THUMB_W;
    out.height = THUMB_H;
    engine = { compositor, session, clipA: ids.a, clipB: ids.b, textures, luts: new Map(), sample: a, out, encoded: new Map(), logTexture: null };
  } catch {
    engine = null; // no WebGL2: tiles keep their text labels
  }
  return engine;
}

/** The sample as a camera would record it in this log profile (so the LUT turns it back). */
function encodedFor(e: Engine, lutId: string) {
  const hit = e.encoded.get(lutId);
  if (hit) return hit;
  const encode = logEncoder(lutId);
  if (!encode) return null;
  // Many pixels share a color: memoize per 8-bit RGB.
  const memo = new Map<number, [number, number, number]>();
  const px = new Uint8ClampedArray(e.sample.length);
  for (let i = 0; i < px.length; i += 4) {
    const key = (e.sample[i] << 16) | (e.sample[i + 1] << 8) | e.sample[i + 2];
    let v = memo.get(key);
    if (!v) {
      v = encode([e.sample[i] / 255, e.sample[i + 1] / 255, e.sample[i + 2] / 255]);
      memo.set(key, v);
    }
    px[i] = v[0] * 255;
    px[i + 1] = v[1] * 255;
    px[i + 2] = v[2] * 255;
    px[i + 3] = 255;
  }
  const entry = { tex: e.compositor.uploadPixels(null, new Uint8Array(px.buffer), THUMB_W, THUMB_H), image: toCanvas(px) };
  e.encoded.set(lutId, entry);
  return entry;
}

function resources(e: Engine): SceneResources {
  return {
    media: (layer) => (layer.mediaId === "med_preview_log" && e.logTexture) || e.textures[layer.mediaId] || null,
    mask: () => e.textures.med_preview_mask,
    lut: (ref) => {
      if (!e.luts.has(ref.id)) {
        const generated = builtinLut(ref.id, 25);
        e.luts.set(ref.id, generated ? e.compositor.createLut(generated.data, generated.size) : null);
      }
      return e.luts.get(ref.id)!;
    },
  };
}

/** Render one frame with the compositor into its canvas. `amount` is 0..1 intensity (or transition progress). */
function renderFrame(e: Engine, kind: PreviewKind, id: string, amount: number, seconds: number) {
  const s = e.session;
  const mark = s.history().undo.length;
  let time = Math.min(3.5, Math.max(0.05, seconds));
  const source = kind === "lut" && id !== "none" ? "med_preview_log" : kind === "effect" && id === "denoise" ? "med_preview_noisy" : null;
  e.logTexture = kind === "lut" ? (encodedFor(e, id)?.tex ?? null) : null;
  try {
    if (id !== "none" || source) {
      s.transact("preview", "preview", (ctx) => {
        const el = ctx.draft.elements[e.clipA];
        if (source) (el as { mediaId: string }).mediaId = source;
        if (id === "none") return;
        const intensity = Math.round(amount * 100);
        if (kind === "effect") applyEffect(ctx, el, { effectId: id, intensity, params: PREVIEW_PARAMS[id] });
        else if (kind === "subject") applyEffect(ctx, el, { effectId: id, intensity, subjectMaskId: "med_preview_mask", params: { color: "#7CF7FF" } });
        else if (kind === "filter") applyFilter(ctx, el, id, intensity);
        else if (kind === "lut") applyLut(ctx, el, { id, intensity: 100 });
        else if (kind === "adjust") {
          const preset = ADJUST_PRESETS.find((p) => p.id === id);
          if (preset) setColorGrade(ctx, el, Object.fromEntries(Object.entries(preset.data.grade).map(([k, v]) => [k, (v as number) * amount])));
        } else if (kind === "transition") addTransition(ctx, { fromElementId: e.clipA, type: id, durationSeconds: 1 });
      }, { skipFinalize: kind !== "transition" });
    }
    if (kind === "transition") {
      const cut = s.state.elements[e.clipB].start;
      time = cut - 0.5 + Math.min(0.999, Math.max(0, amount));
    }
    const scene = evaluateScene(s.state, time, { width: THUMB_W, height: THUMB_H });
    e.compositor.render(scene, resources(e));
    e.compositor.present();
  } finally {
    while (s.history().undo.length > mark) s.undo("preview");
    e.logTexture = null;
  }
}

/** Effects whose still shows a short motion trail (a single frame of camera shake looks like nothing). */
const TRAILS: Record<string, number[]> = { shake: [0.3, 0.42, 0.55, 0.68], zoom_pulse: [0.85, 0.92, 1, 1.08] };

/**
 * Compose a finished preview frame in `e.out`. LUT previews are split: the log footage on the left,
 * the LUT's result on the right, divided at `split` (0..1).
 */
function compose(e: Engine, kind: PreviewKind, id: string, amount: number, seconds: number, split = 0.5) {
  const g = e.out.getContext("2d")!;
  const gl = e.compositor.gl.canvas as HTMLCanvasElement;
  g.globalAlpha = 1;
  const trail = kind === "effect" && amount === 1 && seconds < 0 ? TRAILS[id] : undefined;
  if (trail) {
    trail.forEach((t, i) => {
      renderFrame(e, kind, id, 1, t);
      g.globalAlpha = i === 0 ? 1 : 0.45;
      g.drawImage(gl, 0, 0);
    });
    g.globalAlpha = 1;
    return;
  }
  renderFrame(e, kind, id, amount, Math.max(0, seconds));
  g.drawImage(gl, 0, 0);
  if (kind === "lut" && id !== "none") {
    const log = encodedFor(e, id);
    if (!log) return;
    const x = Math.round(THUMB_W * split);
    g.drawImage(log.image, 0, 0, x, THUMB_H, 0, 0, x, THUMB_H);
    g.fillStyle = "rgba(255,255,255,0.9)";
    g.fillRect(x - 1, 0, 2, THUMB_H);
    g.font = "600 13px system-ui, sans-serif";
    g.textBaseline = "bottom";
    const tag = (text: string, tx: number) => {
      const w = g.measureText(text).width + 10;
      g.fillStyle = "rgba(0,0,0,0.55)";
      g.fillRect(tx, THUMB_H - 22, w, 18);
      g.fillStyle = "#fff";
      g.fillText(text, tx + 5, THUMB_H - 7);
    };
    if (x > 50) tag("LOG", 6);
    if (THUMB_W - x > 60) tag("Rec.709", THUMB_W - 66);
  }
}

const cache = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();
const idle = () => new Promise<void>((r) => setTimeout(r, 0));

function difference(a: Uint8Array, b: Uint8Array) {
  let d = 0;
  for (let i = 0; i < a.length; i += 28) d += Math.abs(a[i] - b[i]);
  return d;
}

/** The still for a tile, as a data URL (null without WebGL2). Rendered one at a time, off the critical path. */
export function thumbnail(kind: PreviewKind, id: string): Promise<string | null> {
  const key = `${kind}:${id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p: Promise<string | null> = queue.then(async () => {
    await idle();
    const e = setup();
    if (!e) return null;
    let seconds = 1;
    let amount = kind === "transition" ? (id === "flash" ? 0.35 : 0.45) : 1;
    if (kind === "effect" && id === "flash") amount = 0.55; // half-way into the flash, not a white frame
    else if (kind === "effect" && TRAILS[id]) seconds = -1;
    else if (kind === "effect" && ANIMATED.has(id)) {
      // Pick the moment the effect shows most (glitches, leaks and grain come and go).
      const read = () => {
        const px = new Uint8Array(THUMB_W * THUMB_H * 4);
        e.compositor.readPixels(px);
        return px;
      };
      renderFrame(e, "effect", "none", 0, 1);
      const plain = read();
      let best = -1;
      for (let t = 0.25; t <= 3; t += 0.25) {
        renderFrame(e, kind, id, 1, t);
        const d = difference(plain, read());
        if (d > best) {
          best = d;
          seconds = t;
        }
      }
    }
    compose(e, kind, id, amount, seconds);
    return e.out.toDataURL("image/jpeg", 0.85);
  });
  // One preview at a time; a failed one must not stop the rest.
  queue = p.catch(() => null);
  cache.set(key, p);
  return p;
}

/**
 * Draw an animation frame for a hovered tile into `target`. Looks sweep from off to full strength;
 * moving effects play in time; transitions play from one clip to the other, with a pause at each
 * end; LUT previews slide the before/after divider.
 */
export function drawHoverFrame(kind: PreviewKind, id: string, elapsedSeconds: number, target: HTMLCanvasElement) {
  const e = setup();
  if (!e) return;
  let amount = 1;
  let seconds = 1;
  let split = 0.5;
  if (kind === "transition") {
    const phase = (elapsedSeconds % 2.2) / 2.2;
    amount = Math.min(1, Math.max(0, (phase - 0.15) / 0.65));
  } else if (kind === "lut") split = 0.5 - 0.42 * Math.cos(elapsedSeconds * 1.6);
  else if (kind === "effect" && (ANIMATED.has(id) || TRAILS[id])) seconds = 0.2 + (elapsedSeconds % 3.2);
  else amount = 0.5 - 0.5 * Math.cos(elapsedSeconds * 2.4);
  compose(e, kind, id, amount, seconds, split);
  target.getContext("2d")?.drawImage(e.out, 0, 0, target.width, target.height);
}

/** Catalog ids that have previews (subject effects are previewed separately). */
export const PREVIEWABLE = {
  effect: new Set(EFFECTS_CATALOG.filter((x) => !x.data.requiresSubjectMask).map((x) => x.id)),
  subject: new Set(EFFECTS_CATALOG.filter((x) => x.data.requiresSubjectMask).map((x) => x.id)),
  filter: new Set(FILTERS_CATALOG.map((x) => x.id)),
};
