/**
 * Built-in camera log → Rec.709 LUTs, generated from the manufacturers' published log curves.
 * Each LUT decodes the log signal to scene-linear light, converts the camera gamut to Rec.709
 * primaries, then applies a filmic highlight roll-off and the display gamma.
 *
 * These are a good-looking starting point, not the vendors' own technical LUTs: Apple Log 2 uses the
 * Apple Log curve, D-Log M uses the D-Log curve, and gamuts without a published matrix are
 * approximated by Rec.2020.
 */

type Curve = (x: number) => number;
type Matrix = readonly [number, number, number, number, number, number, number, number, number];

const log10Inv = (v: number) => Math.pow(10, v);

/**
 * Decoded pixels are video-range normalized (10-bit code 64 → 0, 940 → 1). Sony, Panasonic and
 * Fujifilm define their curves on full-range code values, so those convert first.
 */
const fullRange = (p: number) => (p * 876 + 64) / 1023;

/** Decoded pixel value (0..1) → scene-linear reflectance (0.18 = mid grey). */
const CURVES: Record<string, Curve> = {
  appleLog: (x) => {
    const R0 = -0.05641088, c = 47.28711236, beta = 0.00964052, gamma = 0.08550479, delta = 0.69336945;
    const Pt = c * (0.01 - R0) ** 2;
    if (x >= Pt) return Math.pow(2, (x - delta) / gamma) - beta;
    return x >= 0 ? Math.sqrt(x / c) + R0 : R0;
  },
  slog2: (ire) => ((log10Inv((ire - 0.616596 - 0.03) / 0.432699) - 0.037584) * 219) / 155,
  slog3: (p) => {
    const cv = fullRange(p) * 1023;
    if (cv >= 171.2102946929) return log10Inv((cv - 420) / 261.5) * 0.19 - 0.01;
    return ((cv - 95) * 0.01125) / (171.2102946929 - 95);
  },
  clog: (x) => (0.9 * (log10Inv((x - 0.0730597) / 0.529136) - 1)) / 10.1596,
  clog2: (x) => (0.9 * (log10Inv((x - 0.092864125) / 0.24136077) - 1)) / 87.09937546,
  clog3: (x) => {
    if (x < 0.04076162) return (-0.9 * (log10Inv((0.069886632 - x) / 0.42889912) - 1)) / 14.98325;
    if (x <= 0.105357102) return (0.9 * (x - 0.073059361)) / 2.3069815;
    return (0.9 * (log10Inv((x - 0.069886632) / 0.42889912) - 1)) / 14.98325;
  },
  dlog: (x) => (x <= 0.14 ? (x - 0.0929) / 6.025 : (log10Inv(3.89616 * x - 2.27752) - 0.0108) / 0.9892),
  flog: (p) => {
    const x = fullRange(p);
    return x >= 0.100537775223865 ? (log10Inv((x - 0.790453) / 0.344676) - 0.009468) / 0.555556 : (x - 0.092864) / 8.735631;
  },
  flog2: (p) => {
    const x = fullRange(p);
    return x >= 0.100686685370811 ? (log10Inv((x - 0.384316) / 0.245281) - 0.064829) / 5.555556 : (x - 0.092864) / 8.799461;
  },
  vlog: (p) => {
    const x = fullRange(p);
    return x < 0.181 ? (x - 0.125) / 5.6 : log10Inv((x - 0.598206) / 0.241514) - 0.00873;
  },
};

/** Camera gamut → Rec.709 primaries (row-major, rows sum to 1 so white stays white). */
const GAMUTS: Record<string, Matrix> = {
  rec2020: [1.6605, -0.5876, -0.0728, -0.1246, 1.1329, -0.0083, -0.0182, -0.1006, 1.1187],
  sgamut3: [1.8467789, -0.5259861, -0.3207928, -0.4441449, 1.2594437, 0.1847013, 0.0408167, -0.0156923, 0.9748756],
  sgamut3cine: [1.6269474, -0.5401385, -0.0868089, -0.1785155, 1.4179409, -0.2394254, -0.0444361, -0.1959199, 1.240356],
  vgamut: [1.806576, -0.695697, -0.110879, -0.17009, 1.305955, -0.135865, -0.025206, -0.154468, 1.179674],
};

const PROFILES: Record<string, { curve: string; gamut: string }> = {
  apple_log_to_rec709: { curve: "appleLog", gamut: "rec2020" },
  apple_log_2_to_rec709: { curve: "appleLog", gamut: "rec2020" },
  sony_slog2_sgamut_to_rec709: { curve: "slog2", gamut: "sgamut3" },
  sony_slog2_sgamut3_to_rec709: { curve: "slog2", gamut: "sgamut3" },
  sony_slog2_sgamut3cine_to_rec709: { curve: "slog2", gamut: "sgamut3cine" },
  sony_slog3_sgamut3_to_rec709: { curve: "slog3", gamut: "sgamut3" },
  sony_slog3_sgamut3cine_to_rec709: { curve: "slog3", gamut: "sgamut3cine" },
  canon_clog_to_rec709: { curve: "clog", gamut: "rec2020" },
  canon_clog2_to_rec709: { curve: "clog2", gamut: "rec2020" },
  canon_clog3_to_rec709: { curve: "clog3", gamut: "rec2020" },
  dji_dlog_to_rec709: { curve: "dlog", gamut: "rec2020" },
  dji_dlogm_to_rec709: { curve: "dlog", gamut: "rec2020" },
  fuji_flog_to_rec709: { curve: "flog", gamut: "rec2020" },
  fuji_flog2_to_rec709: { curve: "flog2", gamut: "rec2020" },
  panasonic_vlog_to_rec709: { curve: "vlog", gamut: "vgamut" },
  panasonic_vlogl_to_rec709: { curve: "vlog", gamut: "vgamut" },
};

/** Ids of the camera LUTs that can be generated. */
export const BUILTIN_LUT_IDS = Object.keys(PROFILES);

export function isBuiltinLut(id: string): boolean {
  return id in PROFILES;
}

/** Filmic roll-off (ACES fit) on scene-linear light, then the Rec.709 display gamma (2.4). */
function display(linear: number): number {
  const x = Math.max(0, linear) * 0.6;
  const toned = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  return Math.pow(Math.min(1, Math.max(0, toned)), 1 / 2.4);
}

/**
 * The LUT for a built-in camera profile as `size^3` RGB triples, red varying fastest (as in .cube
 * files), or null for an unknown id.
 */
export function builtinLut(id: string, size = 33): { size: number; data: Float32Array } | null {
  const profile = PROFILES[id];
  if (!profile) return null;
  const curve = CURVES[profile.curve];
  const m = GAMUTS[profile.gamut];
  const decoded = Array.from({ length: size }, (_, i) => curve(i / (size - 1)));
  const data = new Float32Array(size * size * size * 3);
  let o = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const R = decoded[r];
        const G = decoded[g];
        const B = decoded[b];
        data[o++] = display(m[0] * R + m[1] * G + m[2] * B);
        data[o++] = display(m[3] * R + m[4] * G + m[5] * B);
        data[o++] = display(m[6] * R + m[7] * G + m[8] * B);
      }
    }
  }
  return { size, data };
}

function invert3(m: Matrix): Matrix {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** Inverse of a monotone increasing function on [lo, hi], by bisection. */
function inverseOf(fn: (x: number) => number, lo: number, hi: number): (y: number) => number {
  return (y) => {
    let a = lo;
    let b = hi;
    for (let k = 0; k < 40; k++) {
      const mid = (a + b) / 2;
      if (fn(mid) < y) a = mid;
      else b = mid;
    }
    return (a + b) / 2;
  };
}

/**
 * The opposite of a built-in camera LUT: turns a Rec.709 display color (0..1) into the log signal a
 * camera in that profile would record, so that the LUT brings it back. Used for previews (what a
 * LUT does to its camera's footage). Null for an unknown id.
 */
export function logEncoder(id: string): ((rgb: [number, number, number]) => [number, number, number]) | null {
  const profile = PROFILES[id];
  if (!profile) return null;
  const curve = CURVES[profile.curve];
  const toCamera = invert3(GAMUTS[profile.gamut]);
  const fromDisplay = inverseOf(display, 0, 64);
  const toCode = inverseOf(curve, 0, 1);
  const floor = curve(0);
  return ([r, g, b]) => {
    const lin = [fromDisplay(r), fromDisplay(g), fromDisplay(b)];
    const cam = [0, 1, 2].map((k) => Math.max(floor, toCamera[k * 3] * lin[0] + toCamera[k * 3 + 1] * lin[1] + toCamera[k * 3 + 2] * lin[2]));
    return [toCode(cam[0]), toCode(cam[1]), toCode(cam[2])];
  };
}
