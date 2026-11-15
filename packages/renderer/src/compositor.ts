import type { AdjustmentLayer, DrawLayer, EffectInstance, Mask, MediaLayer, ResolvedColor, Scene, TransitionLayer } from "@openedits/core";
import {
  BLEND_FS,
  BLEND_MODES,
  BLUR_FS,
  COLOR_FS,
  COPY_FS,
  EFFECT_FS,
  EFFECT_TYPES,
  FULLSCREEN_VS,
  GLOW_ADD,
  LAYER_FS,
  LAYER_VS,
  SUBJECT_FS,
  SUBJECT_TYPES,
  TRANSITION_FS,
  TRANSITION_TYPES,
} from "./shaders.js";
import { rasterCaption, rasterKey, rasterShape, rasterSticker, rasterText, type Raster } from "./raster.js";

export interface TextureInfo {
  tex: WebGLTexture;
  width: number;
  height: number;
}

export interface LutTexture {
  tex: WebGLTexture;
  size: number;
}

/** Supplies decoded media and LUTs for a scene. Returning null skips the layer with a warning. */
export interface SceneResources {
  media(layer: MediaLayer): TextureInfo | null;
  lut(ref: { id: string; cubePath?: string }): LutTexture | null;
  /** The subject mask frame for one subject effect of a layer (red channel = subject). */
  mask?(layer: MediaLayer, instanceId: string): TextureInfo | null;
}

interface Target extends TextureInfo {
  fbo: WebGLFramebuffer;
}

class Program {
  readonly program: WebGLProgram;
  private locations = new Map<string, WebGLUniformLocation | null>();

  constructor(private gl: WebGL2RenderingContext, vs: string, fs: string, name: string) {
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`Shader ${name} failed to compile: ${gl.getShaderInfoLog(sh)}`);
      return sh;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program ${name} failed to link: ${gl.getProgramInfoLog(p)}`);
    this.program = p;
  }

  loc(name: string) {
    if (!this.locations.has(name)) this.locations.set(name, this.gl.getUniformLocation(this.program, name));
    return this.locations.get(name)!;
  }
}

function hexToRgba(hex: string): [number, number, number, number] {
  const h = hex.replace("#", "");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return [n(0), n(2), n(4), h.length >= 8 ? n(6) : 1];
}

/** Monotone cubic interpolation of curve control points into 256 samples. */
export function sampleCurve(points: { x: number; y: number }[]): Float32Array {
  const pts = [...points].sort((a, b) => a.x - b.x);
  const n = pts.length;
  const out = new Float32Array(256);
  const d: number[] = [];
  const m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((pts[i + 1].y - pts[i].y) / Math.max(1e-6, pts[i + 1].x - pts[i].x));
  m[0] = d[0] ?? 0;
  m[n - 1] = d[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-9) m[i] = m[i + 1] = 0;
    else {
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        m[i] = t * a * d[i];
        m[i + 1] = t * b * d[i];
      }
    }
  }
  for (let k = 0; k < 256; k++) {
    const x = k / 255;
    if (x <= pts[0].x) out[k] = pts[0].y;
    else if (x >= pts[n - 1].x) out[k] = pts[n - 1].y;
    else {
      let i = 0;
      while (i < n - 2 && x > pts[i + 1].x) i++;
      const h = pts[i + 1].x - pts[i].x;
      const t = (x - pts[i].x) / h;
      const t2 = t * t;
      const t3 = t2 * t;
      out[k] = (2 * t3 - 3 * t2 + 1) * pts[i].y + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * pts[i + 1].y + (t3 - t2) * h * m[i + 1];
    }
    out[k] = Math.min(1, Math.max(0, out[k]));
  }
  return out;
}

function hueToRgb(hue: number): [number, number, number] {
  const h = (((hue % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const rgb = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
  const mean = (rgb[0] + rgb[1] + rgb[2]) / 3;
  return [rgb[0] - mean, rgb[1] - mean, rgb[2] - mean];
}

const GRADE_ORDER = ["exposure", "brightness", "contrast", "highlights", "shadows", "whites", "blacks", "temperature", "tint", "vibrance", "saturation", "clarity", "fade"] as const;
const HSL_ORDER = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"] as const;
const MASK_TYPES: Record<string, number> = { none: 0, rectangle: 1, ellipse: 2, line: 3, shutter: 4 };

/**
 * WebGL2 compositor: draws a `Scene` (from @openedits/core) into an offscreen accumulation buffer.
 * The same class renders previews, captured frames and exports.
 */
export class Compositor {
  readonly gl: WebGL2RenderingContext;
  width = 0;
  height = 0;
  private programs: Record<"copy" | "layer" | "color" | "blur" | "effect" | "blend" | "transition" | "subject", Program>;
  private vao: WebGLVertexArrayObject;
  private pool = new Map<string, Target[]>();
  private acc!: Target;
  private accAlt!: Target;
  private rasters = new Map<string, { info: TextureInfo; frame: number }>();
  private curves = new Map<string, WebGLTexture>();
  private identityLut: WebGLTexture;
  private frame = 0;
  private warnings = new Set<string>();

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.programs = {
      copy: new Program(gl, FULLSCREEN_VS, COPY_FS, "copy"),
      layer: new Program(gl, LAYER_VS, LAYER_FS, "layer"),
      color: new Program(gl, FULLSCREEN_VS, COLOR_FS, "color"),
      blur: new Program(gl, FULLSCREEN_VS, BLUR_FS, "blur"),
      effect: new Program(gl, FULLSCREEN_VS, EFFECT_FS, "effect"),
      blend: new Program(gl, FULLSCREEN_VS, BLEND_FS, "blend"),
      transition: new Program(gl, FULLSCREEN_VS, TRANSITION_FS, "transition"),
      subject: new Program(gl, FULLSCREEN_VS, SUBJECT_FS, "subject"),
    };
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // 2x2x2 identity LUT so the sampler3D is always complete.
    this.identityLut = this.createLut(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]), 2).tex;
  }

  setSize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    const canvas = this.gl.canvas as HTMLCanvasElement;
    canvas.width = width;
    canvas.height = height;
    if (this.acc) this.release(this.acc);
    if (this.accAlt) this.release(this.accAlt);
    this.acc = this.acquire(width, height);
    this.accAlt = this.acquire(width, height);
  }

  // ---------------------------------------------------------------- textures

  /** Texture unit used only for creating and uploading textures, so uploads never disturb the units a pass has bound. */
  private static readonly SCRATCH_UNIT = 15;

  private newTexture(): WebGLTexture {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + Compositor.SCRATCH_UNIT);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** Upload opaque RGBA pixels (row 0 = top), reusing `existing` when the size matches. */
  uploadPixels(existing: TextureInfo | null, data: Uint8Array, width: number, height: number): TextureInfo {
    const gl = this.gl;
    const info = existing && existing.width === width && existing.height === height ? existing : { tex: this.newTexture(), width, height };
    if (existing && info !== existing) gl.deleteTexture(existing.tex);
    gl.activeTexture(gl.TEXTURE0 + Compositor.SCRATCH_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, info.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return info;
  }

  private uploadCanvas(r: Raster): TextureInfo {
    const gl = this.gl;
    const tex = this.newTexture();
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, r.canvas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    return { tex, width: r.width, height: r.height };
  }

  /** Create a 3D LUT texture from `size^3` RGB triples (red varies fastest, as in .cube files). */
  createLut(data: Float32Array, size: number): LutTexture {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + Compositor.SCRATCH_UNIT);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    // RGBA16F with float input is filterable on every WebGL2 implementation (RGB16F is not reliable on ANGLE/Metal).
    const rgba = new Float32Array(size * size * size * 4);
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      rgba[j] = data[i];
      rgba[j + 1] = data[i + 1];
      rgba[j + 2] = data[i + 2];
      rgba[j + 3] = 1;
    }
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, size, size, size, 0, gl.RGBA, gl.FLOAT, rgba);
    return { tex, size };
  }

  deleteTexture(info: TextureInfo | null | undefined) {
    if (info) this.gl.deleteTexture(info.tex);
  }

  private acquire(width: number, height: number): Target {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const free = this.pool.get(`${w}x${h}`);
    if (free?.length) return free.pop()!;
    const gl = this.gl;
    const tex = this.newTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, width: w, height: h };
  }

  private release(t: Target) {
    const key = `${t.width}x${t.height}`;
    const list = this.pool.get(key) ?? [];
    list.push(t);
    this.pool.set(key, list);
  }

  private trimPool() {
    let total = 0;
    for (const list of this.pool.values()) total += list.length;
    if (total <= 24) return;
    for (const [key, list] of this.pool) {
      if (key === `${this.width}x${this.height}`) continue;
      for (const t of list) {
        this.gl.deleteFramebuffer(t.fbo);
        this.gl.deleteTexture(t.tex);
      }
      this.pool.delete(key);
    }
  }

  // ---------------------------------------------------------------- passes

  private bind(unit: number, tex: WebGLTexture, target: number = this.gl.TEXTURE_2D) {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(target, tex);
  }

  /** Full-screen pass into `target` (null = the canvas). */
  private pass(prog: Program, target: Target | null, setup: (p: Program) => void, opts: { blend?: boolean; flipY?: boolean } = {}) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.width : this.width, target ? target.height : this.height);
    gl.useProgram(prog.program);
    gl.uniform1f(prog.loc("uFlipY"), opts.flipY ? 1 : 0);
    if (opts.blend) gl.enable(gl.BLEND);
    else gl.disable(gl.BLEND);
    setup(prog);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private clear(target: Target, rgba: [number, number, number, number]) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.clearColor(rgba[0], rgba[1], rgba[2], rgba[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private curvesTexture(curves: ResolvedColor["curves"]): WebGLTexture {
    const key = JSON.stringify(curves);
    let tex = this.curves.get(key);
    if (tex) return tex;
    const [r, g, b, luma] = [sampleCurve(curves.red), sampleCurve(curves.green), sampleCurve(curves.blue), sampleCurve(curves.luma)];
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      data[i * 4] = Math.round(r[i] * 255);
      data[i * 4 + 1] = Math.round(g[i] * 255);
      data[i * 4 + 2] = Math.round(b[i] * 255);
      data[i * 4 + 3] = Math.round(luma[i] * 255);
    }
    tex = this.newTexture();
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, 256, 1, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, data);
    if (this.curves.size > 32) {
      for (const t of this.curves.values()) this.gl.deleteTexture(t);
      this.curves.clear();
    }
    this.curves.set(key, tex);
    return tex;
  }

  private colorPass(src: TextureInfo, color: ResolvedColor, res: SceneResources): Target {
    const gl = this.gl;
    const out = this.acquire(src.width, src.height);
    let lut: LutTexture | null = null;
    if (color.lut && color.lut.intensity > 0) {
      lut = res.lut(color.lut);
      if (!lut) this.warnings.add(`LUT "${color.lut.id}" is not available; it was skipped`);
    }
    const curvesIdentity = Object.values(color.curves).every((pts) => pts.every((p) => Math.abs(p.x - p.y) < 1e-6));
    const curves = this.curvesTexture(color.curves);
    this.pass(this.programs.color, out, (p) => {
      this.bind(0, src.tex);
      gl.uniform1i(p.loc("uTex"), 0);
      this.bind(1, curves);
      gl.uniform1i(p.loc("uCurves"), 1);
      this.bind(2, lut?.tex ?? this.identityLut, gl.TEXTURE_3D);
      gl.uniform1i(p.loc("uLut"), 2);
      gl.uniform1fv(p.loc("uGrade"), GRADE_ORDER.map((k) => color.grade[k] / 100));
      const wheels = (["shadows", "midtones", "highlights", "global"] as const).flatMap((k) => hueToRgb(color.wheels[k].hue).map((v) => v * (color.wheels[k].intensity / 100) * 0.3));
      gl.uniform3fv(p.loc("uWheels"), wheels);
      const hsl = HSL_ORDER.flatMap((k) => [color.hsl[k].hue / 100, color.hsl[k].saturation / 100, color.hsl[k].luminance / 100]);
      gl.uniform3fv(p.loc("uHsl"), hsl);
      gl.uniform1f(p.loc("uHasHsl"), hsl.some((v) => v !== 0) ? 1 : 0);
      gl.uniform1f(p.loc("uHasCurves"), curvesIdentity ? 0 : 1);
      gl.uniform1f(p.loc("uLutIntensity"), lut ? color.lut!.intensity / 100 : 0);
      gl.uniform1f(p.loc("uLutSize"), lut?.size ?? 2);
    });
    return out;
  }

  /** Gaussian blur with a radius of about `px` pixels (separable, repeated for large radii). */
  private blurTexture(src: TextureInfo, px: number): Target | null {
    const gl = this.gl;
    if (px < 0.5) return null;
    const iterations = Math.min(6, Math.max(1, Math.ceil(px / 12)));
    const r = px / Math.sqrt(iterations);
    let cur: TextureInfo = src;
    let last: Target | null = null;
    for (let i = 0; i < iterations * 2; i++) {
      const out = this.acquire(src.width, src.height);
      const horizontal = i % 2 === 0;
      const input = cur;
      this.pass(this.programs.blur, out, (p) => {
        this.bind(0, input.tex);
        gl.uniform1i(p.loc("uTex"), 0);
        gl.uniform2f(p.loc("uStep"), horizontal ? r / 8 / src.width : 0, horizontal ? 0 : r / 8 / src.height);
      });
      if (last) this.release(last);
      last = out;
      cur = out;
    }
    return last;
  }

  /** One subject effect: blur the background, or draw a glow/outline around the subject mask. */
  private subjectPass(src: TextureInfo, mask: TextureInfo, fx: EffectInstance): Target | null {
    const gl = this.gl;
    const type = SUBJECT_TYPES[fx.effectId];
    if (!type) {
      this.warnings.add(`Subject effect "${fx.effectId}" is not rendered yet; it was skipped`);
      return null;
    }
    const num = (name: string, fallback: number) => (typeof fx.params[name] === "number" ? (fx.params[name] as number) : fallback);
    const short = Math.min(src.width, src.height);
    const blurred = type === 1 ? this.blurTexture(src, (num("radius", 40) / 100) * 0.06 * short) : null;
    const maskBlur = type !== 1 ? this.blurTexture(mask, ((type === 2 ? num("radius", 30) : num("width", 8)) / 100) * (type === 2 ? 0.12 : 0.25) * Math.min(mask.width, mask.height)) : null;
    const color = hexToRgba(typeof fx.params.color === "string" ? fx.params.color : "#FFFFFF");
    const out = this.acquire(src.width, src.height);
    this.pass(this.programs.subject, out, (p) => {
      this.bind(0, src.tex);
      gl.uniform1i(p.loc("uTex"), 0);
      this.bind(1, (blurred ?? src).tex);
      gl.uniform1i(p.loc("uBlurTex"), 1);
      this.bind(2, mask.tex);
      gl.uniform1i(p.loc("uMask"), 2);
      this.bind(3, (maskBlur ?? mask).tex);
      gl.uniform1i(p.loc("uMaskBlur"), 3);
      gl.uniform1i(p.loc("uType"), type);
      gl.uniform3f(p.loc("uColor"), color[0], color[1], color[2]);
      gl.uniform1f(p.loc("uAmount"), fx.intensity / 100);
    });
    if (blurred) this.release(blurred);
    if (maskBlur) this.release(maskBlur);
    return out;
  }

  /** One EFFECT_FS pass over `src`. */
  private runEffect(src: TextureInfo, type: number, params: [number, number, number, number], amount: number, time: number, aux?: TextureInfo): Target {
    const gl = this.gl;
    const out = this.acquire(src.width, src.height);
    this.pass(this.programs.effect, out, (p) => {
      this.bind(0, src.tex);
      gl.uniform1i(p.loc("uTex"), 0);
      this.bind(1, (aux ?? src).tex);
      gl.uniform1i(p.loc("uAux"), 1);
      gl.uniform1i(p.loc("uType"), type);
      gl.uniform1f(p.loc("uAmount"), amount);
      gl.uniform4f(p.loc("uParams"), ...params);
      gl.uniform2f(p.loc("uTexel"), 1 / src.width, 1 / src.height);
      gl.uniform1f(p.loc("uTime"), Math.floor(time * 30) % 997);
      gl.uniform1f(p.loc("uSeconds"), time);
    });
    return out;
  }

  private effectPass(src: TextureInfo, fx: EffectInstance, time: number): Target | null {
    const amount = fx.intensity / 100;
    const num = (name: string, fallback: number) => (typeof fx.params[name] === "number" ? (fx.params[name] as number) : fallback);
    if (amount <= 0) return null;
    const short = Math.min(src.width, src.height);
    if (fx.effectId === "blur") return this.blurTexture(src, amount * (num("radius", 50) / 50) * 0.04 * short);
    const type = EFFECT_TYPES[fx.effectId];
    if (!type) {
      this.warnings.add(`Effect "${fx.effectId}" is not rendered yet; it was skipped`);
      return null;
    }
    if (fx.effectId === "glow") {
      // Bright pass, blurred, added back over the layer.
      const bright = this.runEffect(src, type, [num("threshold", 70) / 100, 0, 0, 0], 1, time);
      const blurred = this.blurTexture(bright, Math.max(1, (num("radius", 30) / 100) * 0.08 * short));
      if (blurred) this.release(bright);
      const glow = blurred ?? bright;
      const out = this.runEffect(src, GLOW_ADD, [0, 0, 0, 0], amount, time, glow);
      this.release(glow);
      return out;
    }
    const scale = short / 1080;
    const pct = (name: string, fallback: number) => num(name, fallback) / 100;
    const rad = (name: string, fallback: number) => (num(name, fallback) * Math.PI) / 180;
    const params: Record<string, [number, number, number, number]> = {
      vignette: [pct("softness", 60), 0, 0, 0],
      film_grain: [num("size", 1.5) * scale, 0, 0, 0],
      chromatic_aberration: [rad("angle", 0), 0, 0, 0],
      pixelate: [Math.max(1, num("size", 20) * scale), 0, 0, 0],
      posterize: [num("levels", 6), 0, 0, 0],
      mirror: [num("axis", 0), 0, 0, 0],
      motion_blur: [rad("angle", 0), pct("amount", 30), 0, 0],
      zoom_blur: [pct("amount", 30), 0, 0, 0],
      tilt_shift: [num("focus", 0.5), num("width", 0.3), 0, 0],
      light_leak: [num("hue", 30), num("speed", 1), 0, 0],
      flash: [num("frequency", 2), 0, 0, 0],
      vhs: [pct("tracking", 30), pct("noise", 20), 0, 0],
      glitch: [pct("amount", 40), num("speed", 3), 0, 0],
      halftone: [Math.max(2, num("dotSize", 8) * scale), 0, 0, 0],
      kaleidoscope: [num("segments", 6), 0, 0, 0],
      fisheye: [pct("amount", 40), 0, 0, 0],
      shake: [pct("amount", 30), num("frequency", 8), 0, 0],
      zoom_pulse: [pct("amount", 15), num("frequency", 2), 0, 0],
      denoise: [pct("amount", 40), 0, 0, 0],
    };
    // Effects with an "amount" parameter scale their strength by it (the catalog default gives 1x).
    const AMOUNT_DEFAULTS: Record<string, number> = { film_grain: 25, sharpen: 40, chromatic_aberration: 20 };
    const strength =
      fx.effectId === "vignette" ? amount * (num("amount", 40) / 40) * 0.6
      : fx.effectId in AMOUNT_DEFAULTS ? amount * (num("amount", AMOUNT_DEFAULTS[fx.effectId]) / AMOUNT_DEFAULTS[fx.effectId])
      : amount;
    return this.runEffect(src, type, params[fx.effectId] ?? [0, 0, 0, 0], strength, time);
  }

  /** Runs color and effect passes over a source texture. Returns the result and the targets to release afterwards. */
  private process(src: TextureInfo, color: ResolvedColor | null, effects: EffectInstance[], res: SceneResources, time: number): { tex: TextureInfo; owned: Target | null } {
    let cur: TextureInfo = src;
    let owned: Target | null = null;
    const advance = (next: Target | null) => {
      if (!next) return;
      if (owned) this.release(owned);
      owned = next;
      cur = next;
    };
    if (color) advance(this.colorPass(cur, color, res));
    for (const fx of effects) advance(this.effectPass(cur, fx, time));
    return { tex: cur, owned };
  }

  private drawQuad(target: Target, tex: TextureInfo, g: { cx: number; cy: number; width: number; height: number; rotationDegrees: number; opacity: number; mask: Mask; uv: [number, number, number, number] }) {
    const gl = this.gl;
    const p = this.programs.layer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
    gl.useProgram(p.program);
    gl.enable(gl.BLEND);
    this.bind(0, tex.tex);
    gl.uniform1i(p.loc("uTex"), 0);
    gl.uniform2f(p.loc("uCanvas"), target.width, target.height);
    gl.uniform2f(p.loc("uCenter"), g.cx, g.cy);
    gl.uniform2f(p.loc("uSize"), g.width, g.height);
    gl.uniform1f(p.loc("uRotation"), (g.rotationDegrees * Math.PI) / 180);
    gl.uniform4f(p.loc("uUvRect"), ...g.uv);
    gl.uniform1f(p.loc("uOpacity"), g.opacity);
    const m = g.mask;
    const type = MASK_TYPES[m.type] ?? 0;
    gl.uniform1i(p.loc("uMaskType"), type);
    if (type) {
      const halfW = (m.sizeW * g.width) / 2;
      const halfH = (m.sizeH * g.height) / 2;
      gl.uniform2f(p.loc("uMaskCenter"), (m.centerX - 0.5) * g.width, (m.centerY - 0.5) * g.height);
      gl.uniform2f(p.loc("uMaskHalf"), halfW, halfH);
      gl.uniform1f(p.loc("uMaskRadius"), m.cornerRadius * Math.min(halfW, halfH));
      gl.uniform1f(p.loc("uMaskFeather"), (m.feather * Math.min(g.width, g.height)) / 2);
      gl.uniform1f(p.loc("uMaskRotation"), (m.rotation * Math.PI) / 180);
      gl.uniform1f(p.loc("uMaskInvert"), m.invert ? 1 : 0);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private raster(layer: Exclude<DrawLayer, MediaLayer>): TextureInfo {
    const key = rasterKey(layer);
    const hit = this.rasters.get(key);
    if (hit) {
      hit.frame = this.frame;
      return hit.info;
    }
    const r = layer.kind === "text" ? rasterText(layer) : layer.kind === "caption" ? rasterCaption(layer) : layer.kind === "shape" ? rasterShape(layer) : rasterSticker(layer);
    const info = this.uploadCanvas(r);
    this.rasters.set(key, { info, frame: this.frame });
    if (this.rasters.size > 64) {
      for (const [k, v] of this.rasters) {
        if (this.frame - v.frame > 30) {
          this.gl.deleteTexture(v.info.tex);
          this.rasters.delete(k);
        }
      }
    }
    return info;
  }

  private drawLayer(target: Target, layer: DrawLayer, res: SceneResources, time: number) {
    if (layer.opacity <= 0) return;
    let src: TextureInfo | null;
    let width: number;
    let height: number;
    let uv: [number, number, number, number] = [0, 0, 1, 1];
    if (layer.kind === "media") {
      src = res.media(layer);
      if (!src) {
        this.warnings.add(`No frame available for media ${layer.mediaId}`);
        return;
      }
      width = layer.width;
      height = layer.height;
      const c = layer.crop;
      uv = [c.left, c.top, 1 - c.right, 1 - c.bottom];
      if (layer.flip.horizontal) [uv[0], uv[2]] = [uv[2], uv[0]];
      if (layer.flip.vertical) [uv[1], uv[3]] = [uv[3], uv[1]];
    } else {
      src = this.raster(layer);
      width = src.width;
      height = src.height;
    }
    let { tex, owned } = this.process(src, layer.color, layer.effects, res, time);
    if (layer.kind === "media" && layer.subjectEffects.length) {
      for (const fx of layer.subjectEffects) {
        const mask = res.mask?.(layer, fx.instanceId) ?? null;
        if (!mask) {
          this.warnings.add(`No subject mask frame for ${layer.elementId}; "${fx.effectId}" was skipped`);
          continue;
        }
        const next = this.subjectPass(tex, mask, fx);
        if (!next) continue;
        if (owned) this.release(owned);
        owned = next;
        tex = next;
      }
    }
    const geometry = { cx: layer.cx, cy: layer.cy, width, height, rotationDegrees: layer.rotationDegrees, opacity: layer.opacity, mask: layer.mask, uv };
    const mode = BLEND_MODES[layer.blendMode] ?? 0;
    if (mode === 0 || target !== this.acc) this.drawQuad(target, tex, geometry);
    else {
      const tmp = this.acquire(this.width, this.height);
      this.clear(tmp, [0, 0, 0, 0]);
      this.drawQuad(tmp, tex, geometry);
      const gl = this.gl;
      this.pass(this.programs.blend, this.accAlt, (p) => {
        this.bind(0, this.acc.tex);
        gl.uniform1i(p.loc("uBase"), 0);
        this.bind(1, tmp.tex);
        gl.uniform1i(p.loc("uLayer"), 1);
        gl.uniform1i(p.loc("uMode"), mode);
      });
      [this.acc, this.accAlt] = [this.accAlt, this.acc];
      this.release(tmp);
    }
    if (owned) this.release(owned);
  }

  private drawAdjustment(layer: AdjustmentLayer, res: SceneResources, time: number) {
    if (layer.opacity <= 0 || (!layer.color && layer.effects.length === 0)) return;
    const { tex, owned } = this.process(this.acc, layer.color, layer.effects, res, time);
    if (!owned) return;
    const gl = this.gl;
    this.pass(this.programs.copy, this.acc, (p) => {
      this.bind(0, tex.tex);
      gl.uniform1i(p.loc("uTex"), 0);
      gl.uniform1f(p.loc("uOpacity"), layer.opacity);
    }, { blend: true });
    this.release(owned);
  }

  private drawTransition(layer: TransitionLayer, background: [number, number, number, number], res: SceneResources, time: number) {
    const gl = this.gl;
    const a = this.acquire(this.width, this.height);
    const b = this.acquire(this.width, this.height);
    this.clear(a, background);
    this.clear(b, background);
    if (layer.from) this.drawLayer(a, layer.from, res, time);
    if (layer.to) this.drawLayer(b, layer.to, res, time);
    this.pass(this.programs.transition, this.acc, (p) => {
      this.bind(0, a.tex);
      gl.uniform1i(p.loc("uFrom"), 0);
      this.bind(1, b.tex);
      gl.uniform1i(p.loc("uTo"), 1);
      gl.uniform1i(p.loc("uType"), TRANSITION_TYPES[layer.type] ?? 0);
      gl.uniform1f(p.loc("uProgress"), layer.progress);
      gl.uniform1f(p.loc("uAspect"), this.width / this.height);
    });
    this.release(a);
    this.release(b);
  }

  /** Draw a scene into the accumulation buffer. Returns warnings (skipped effects, missing frames). */
  render(scene: Scene, res: SceneResources): string[] {
    this.setSize(scene.width, scene.height);
    this.frame++;
    this.warnings.clear();
    const bg = hexToRgba(scene.backgroundColor);
    bg[3] = 1;
    this.clear(this.acc, bg);
    for (const layer of scene.layers) {
      if (layer.kind === "adjustment") this.drawAdjustment(layer, res, scene.timeSeconds);
      else if (layer.kind === "transition") this.drawTransition(layer, bg, res, scene.timeSeconds);
      else this.drawLayer(this.acc, layer, res, scene.timeSeconds);
    }
    this.trimPool();
    return [...this.warnings];
  }

  /** Read the rendered frame as RGBA bytes, top row first. `out` must hold width*height*4 bytes. */
  readPixels(out: Uint8Array) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.acc.fbo);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
  }

  /** Copy the rendered frame to the canvas (for toBlob / on-screen display). */
  present() {
    const gl = this.gl;
    this.pass(this.programs.copy, null, (p) => {
      this.bind(0, this.acc.tex);
      gl.uniform1i(p.loc("uTex"), 0);
      gl.uniform1f(p.loc("uOpacity"), 1);
    }, { flipY: true });
    gl.flush();
  }
}
