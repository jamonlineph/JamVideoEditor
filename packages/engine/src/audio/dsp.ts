/**
 * Audio analysis on mono float PCM. Pure functions: no I/O, deterministic, unit-testable.
 * All times returned are seconds from the start of the buffer.
 */

const DB_FLOOR = -120;
const toDb = (power: number) => (power <= 1e-12 ? DB_FLOOR : 10 * Math.log10(power));

/** In-place iterative radix-2 FFT. Lengths must be a power of two. */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Magnitude spectrogram (Hann window). Returns frames of n/2 magnitudes. */
export function stft(pcm: Float32Array, n: number, hop: number): Float32Array[] {
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  const frames: Float32Array[] = [];
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let start = 0; start + n <= pcm.length; start += hop) {
    for (let i = 0; i < n; i++) {
      re[i] = pcm[start + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
    frames.push(mag);
  }
  return frames;
}

export interface Envelope {
  hopSeconds: number;
  /** RMS level per hop, dBFS. */
  db: Float32Array;
}

/** Short-time RMS envelope in dBFS. */
export function rmsEnvelope(pcm: Float32Array, sampleRate: number, windowSeconds = 0.02, hopSeconds = 0.01): Envelope {
  const win = Math.max(1, Math.round(windowSeconds * sampleRate));
  const hop = Math.max(1, Math.round(hopSeconds * sampleRate));
  const count = pcm.length < win ? (pcm.length ? 1 : 0) : Math.floor((pcm.length - win) / hop) + 1;
  const db = new Float32Array(count);
  for (let f = 0; f < count; f++) {
    const start = f * hop;
    const end = Math.min(pcm.length, start + win);
    let sum = 0;
    for (let i = start; i < end; i++) sum += pcm[i] * pcm[i];
    db[f] = toDb(sum / Math.max(1, end - start));
  }
  return { hopSeconds: hop / sampleRate, db };
}

function percentile(sorted: Float32Array, p: number): number {
  if (!sorted.length) return DB_FLOOR;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];
}

export interface LevelStats {
  peakDb: number;
  rmsDb: number;
  noiseFloorDb: number;
  speechLevelDb: number;
  /** Suggested silence threshold between the noise floor and the programme level. */
  silenceThresholdDb: number;
  /** Fraction of time above the threshold. */
  activeRatio: number;
}

export function levelStats(pcm: Float32Array, env: Envelope): LevelStats {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    if (a > peak) peak = a;
    sum += pcm[i] * pcm[i];
  }
  const sorted = Float32Array.from(env.db).sort();
  const noise = percentile(sorted, 0.1);
  const speech = percentile(sorted, 0.9);
  const range = speech - noise;
  // With little dynamic range there is no meaningful "silence" unless the level is absolutely low.
  const threshold = range < 8 ? -60 : Math.max(noise + Math.min(15, Math.max(4, 0.3 * range)), speech - 35);
  let activeFrames = 0;
  for (const v of env.db) if (v > threshold) activeFrames++;
  return {
    peakDb: toDb(peak * peak),
    rmsDb: toDb(sum / Math.max(1, pcm.length)),
    noiseFloorDb: noise,
    speechLevelDb: speech,
    silenceThresholdDb: threshold,
    activeRatio: env.db.length ? activeFrames / env.db.length : 0,
  };
}

export interface Pause {
  start: number;
  end: number;
  duration: number;
}

/** Stretches of the envelope below `thresholdDb` lasting at least `minSilenceSeconds`. Blips up to 20 ms are bridged. */
export function findPauses(env: Envelope, thresholdDb: number, minSilenceSeconds: number, totalSeconds: number): Pause[] {
  const out: Pause[] = [];
  const bridge = Math.round(0.02 / env.hopSeconds);
  let start = -1;
  let loud = 0;
  const close = (endFrame: number) => {
    if (start < 0) return;
    const s = start * env.hopSeconds;
    const e = Math.min(totalSeconds, endFrame * env.hopSeconds);
    if (e - s >= minSilenceSeconds - 1e-9) out.push({ start: s, end: e, duration: e - s });
    start = -1;
  };
  for (let i = 0; i < env.db.length; i++) {
    if (env.db[i] <= thresholdDb) {
      if (start < 0) start = i;
      loud = 0;
    } else if (start >= 0 && ++loud > bridge) {
      close(i - loud + 1);
      loud = 0;
    }
  }
  close(env.db.length - loud);
  // A pause running to the end of the buffer extends to the exact end.
  const last = out.at(-1);
  if (last && totalSeconds - last.end < env.hopSeconds * 3) {
    last.end = totalSeconds;
    last.duration = last.end - last.start;
  }
  return out;
}

/** Quietest `sliceSeconds` window within ±`windowSeconds` of `centerSeconds` (ties go to the one nearest the center). */
export function quietPoint(pcm: Float32Array, sampleRate: number, centerSeconds: number, windowSeconds = 0.25, sliceSeconds = 0.01): { time: number; rmsDb: number } {
  const slice = Math.max(1, Math.round(sliceSeconds * sampleRate));
  const lo = Math.max(0, Math.round((centerSeconds - windowSeconds) * sampleRate));
  const hi = Math.min(pcm.length, Math.round((centerSeconds + windowSeconds) * sampleRate));
  if (hi - lo <= slice) return { time: Math.min(Math.max(0, centerSeconds), pcm.length / sampleRate), rmsDb: DB_FLOOR };
  const step = Math.max(1, Math.round(sampleRate / 1000));
  let sum = 0;
  for (let i = lo; i < lo + slice; i++) sum += pcm[i] * pcm[i];
  let best = sum;
  let bestStart = lo;
  const centerSample = centerSeconds * sampleRate;
  const dist = (s: number) => Math.abs(s + slice / 2 - centerSample);
  for (let s = lo + 1; s + slice <= hi; s++) {
    sum += pcm[s + slice - 1] * pcm[s + slice - 1] - pcm[s - 1] * pcm[s - 1];
    if ((s - lo) % step) continue;
    const v = Math.max(0, sum);
    if (v < best - 1e-12 || (Math.abs(v - best) <= 1e-12 && dist(s) < dist(bestStart))) {
      best = v;
      bestStart = s;
    }
  }
  return { time: (bestStart + slice / 2) / sampleRate, rmsDb: toDb(best / slice) };
}

export interface OnsetResult {
  onsets: { time: number; strength: number }[];
  bpm: number | null;
  /** 0..1 strength of the tempo peak. */
  bpmConfidence: number;
  beats: number[];
}

/** Spectral-flux onset detection with autocorrelation tempo estimation and a phase-aligned beat grid. */
export function detectOnsets(pcm: Float32Array, sampleRate: number): OnsetResult {
  const n = 1024;
  const hop = Math.max(64, Math.round(sampleRate / 100 / 2) * 2); // ~10 ms
  const frames = stft(pcm, n, hop);
  const hopSec = hop / sampleRate;
  if (frames.length < 4) return { onsets: [], bpm: null, bpmConfidence: 0, beats: [] };
  const flux = new Float32Array(frames.length);
  // Flux as a fraction of the frame's log-spectrum: transients score ~0.9-1.0, codec noise on a steady tone stays under ~0.1.
  const relFlux = new Float32Array(frames.length);
  for (let f = 1; f < frames.length; f++) {
    let s = 0;
    let e = 0;
    const a = frames[f - 1];
    const b = frames[f];
    for (let k = 1; k < b.length; k++) {
      const lb = Math.log1p(20 * b[k]);
      const d = lb - Math.log1p(20 * a[k]);
      if (d > 0) s += d;
      e += lb;
    }
    flux[f] = s;
    relFlux[f] = e > 1e-9 ? s / e : 0;
  }
  let mean = 0;
  for (const v of flux) mean += v;
  mean /= flux.length;
  let variance = 0;
  for (const v of flux) variance += (v - mean) ** 2;
  const std = Math.sqrt(variance / flux.length);
  let max = 0;
  for (const v of flux) if (v > max) max = v;
  const onsets: { time: number; strength: number }[] = [];
  if (max > 1e-6 && std > 1e-6) {
    const local = 15;
    const minGap = Math.max(1, Math.round(0.05 / hopSec));
    let lastPeak = -minGap;
    for (let f = 2; f < flux.length - 2; f++) {
      const v = flux[f];
      if (v < flux[f - 1] || v < flux[f + 1] || v <= flux[f - 2] || v < flux[f + 2]) continue;
      let lm = 0;
      let c = 0;
      for (let j = Math.max(0, f - local); j < Math.min(flux.length, f + local); j++, c++) lm += flux[j];
      if (v < lm / c + 0.8 * std || relFlux[f] < 0.2 || f - lastPeak < minGap) continue;
      onsets.push({ time: (f * hop + n / 2) / sampleRate, strength: Math.min(1, v / max) });
      lastPeak = f;
    }
  }
  // Tempo: autocorrelation of the mean-removed flux over 60..200 BPM with a mild prior around 120.
  let bpm: number | null = null;
  let confidence = 0;
  const beats: number[] = [];
  const minLag = Math.round(60 / 200 / hopSec);
  const maxLag = Math.min(flux.length - 1, Math.round(60 / 60 / hopSec));
  if (onsets.length >= 4 && maxLag > minLag) {
    let zero = 0;
    for (const v of flux) zero += (v - mean) ** 2;
    let bestLag = 0;
    let bestScore = -Infinity;
    let bestRaw = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = lag; i < flux.length; i++) s += (flux[i] - mean) * (flux[i - lag] - mean);
      const raw = s / (zero || 1);
      const tempo = 60 / (lag * hopSec);
      const prior = Math.exp(-0.5 * (Math.log2(tempo / 120) / 0.9) ** 2);
      if (raw * prior > bestScore) {
        bestScore = raw * prior;
        bestLag = lag;
        bestRaw = raw;
      }
    }
    if (bestLag && bestRaw > 0.05) {
      // Parabolic refinement of the lag.
      const ac = (lag: number) => {
        let s = 0;
        for (let i = lag; i < flux.length; i++) s += (flux[i] - mean) * (flux[i - lag] - mean);
        return s;
      };
      const y0 = ac(bestLag - 1);
      const y1 = ac(bestLag);
      const y2 = ac(bestLag + 1);
      const denom = y0 - 2 * y1 + y2;
      const lag = bestLag + (Math.abs(denom) > 1e-12 ? (0.5 * (y0 - y2)) / denom : 0);
      bpm = Math.round((60 / (lag * hopSec)) * 10) / 10;
      confidence = Math.max(0, Math.min(1, bestRaw));
      let bestPhase = 0;
      let bestSum = -Infinity;
      for (let phase = 0; phase < Math.ceil(lag); phase++) {
        let s = 0;
        for (let p = phase; p < flux.length; p += lag) s += flux[Math.round(p)] ?? 0;
        if (s > bestSum) {
          bestSum = s;
          bestPhase = phase;
        }
      }
      for (let p = bestPhase; p < flux.length; p += lag) beats.push((p * hop + n / 2) / sampleRate);
    }
  }
  return { onsets, bpm, bpmConfidence: confidence, beats };
}

export interface Hum {
  frequencyHz: number;
  /** dB above the surrounding spectrum. */
  prominenceDb: number;
  /** Fraction of the clip where the tone is present. */
  persistence: number;
  label: string;
}

function medianAround(values: Float32Array | Float64Array, center: number, radius: number, skip: number): number {
  const buf: number[] = [];
  for (let i = Math.max(1, center - radius); i <= Math.min(values.length - 1, center + radius); i++) {
    if (Math.abs(i - center) > skip) buf.push(values[i]);
  }
  buf.sort((a, b) => a - b);
  return buf.length ? buf[buf.length >> 1] : DB_FLOOR;
}

function humLabel(f: number): string {
  for (const base of [50, 60]) {
    const harmonic = Math.round(f / base);
    if (harmonic >= 1 && harmonic <= 8 && Math.abs(f - harmonic * base) <= 2.5) return harmonic === 1 ? `mains hum (${base} Hz)` : `mains hum harmonic (${harmonic} x ${base} Hz)`;
  }
  return f > 2000 ? "high-pitched whine" : "steady tone";
}

/** Finds steady narrow-band tones (mains hum and harmonics, electrical whine). */
export function detectHums(pcm: Float32Array, sampleRate: number, opts: { minProminenceDb?: number; minPersistence?: number } = {}): Hum[] {
  const n = sampleRate >= 30000 ? 16384 : 8192;
  const frames = stft(pcm, n, n / 2);
  if (!frames.length) return [];
  const bins = n / 2;
  const avg = new Float64Array(bins);
  for (const fr of frames) for (let k = 0; k < bins; k++) avg[k] += fr[k] * fr[k];
  for (let k = 0; k < bins; k++) avg[k] = toDb(avg[k] / frames.length);
  const hzPerBin = sampleRate / n;
  const minProm = opts.minProminenceDb ?? 12;
  const minPersist = opts.minPersistence ?? 0.75;
  const radius = Math.max(12, Math.round(120 / hzPerBin));
  // Persistence is measured on short frames so intermittent sounds are not mistaken for steady tones.
  const shortN = sampleRate >= 30000 ? 4096 : 2048;
  const shortFrames = stft(pcm, shortN, shortN / 2);
  const shortHz = sampleRate / shortN;
  const shortRadius = Math.max(8, Math.round(160 / shortHz));
  const row = new Float32Array(shortN / 2);
  const out: Hum[] = [];
  for (let k = Math.ceil(30 / hzPerBin); k < Math.min(bins - 2, Math.floor(14000 / hzPerBin)); k++) {
    if (avg[k] < avg[k - 1] || avg[k] < avg[k + 1] || avg[k] < -95) continue;
    const prominence = avg[k] - medianAround(avg, k, radius, 3);
    if (prominence < minProm) continue;
    let present = 0;
    const sk = Math.round((k * hzPerBin) / shortHz);
    for (const fr of shortFrames) {
      if (sk < 2 || sk >= fr.length - 1) break;
      const peak = Math.max(fr[sk - 1], fr[sk], fr[sk + 1]);
      for (let i = 0; i < fr.length; i++) row[i] = fr[i];
      if (20 * Math.log10(peak + 1e-9) - 20 * Math.log10(medianAround(row, sk, shortRadius, 3) + 1e-9) >= 8) present++;
    }
    const persistence = present / Math.max(1, shortFrames.length);
    if (persistence < minPersist) continue;
    // Parabolic interpolation for sub-bin frequency.
    const d = avg[k - 1] - 2 * avg[k] + avg[k + 1];
    const shift = Math.abs(d) > 1e-9 ? (0.5 * (avg[k - 1] - avg[k + 1])) / d : 0;
    const f = (k + shift) * hzPerBin;
    out.push({ frequencyHz: Math.round(f * 10) / 10, prominenceDb: Math.round(prominence * 10) / 10, persistence: Math.round(persistence * 100) / 100, label: humLabel(f) });
  }
  return out.sort((a, b) => b.prominenceDb - a.prominenceDb).slice(0, 8);
}

/** Average level per octave band (dBFS). */
export function octaveBands(pcm: Float32Array, sampleRate: number): { centerHz: number; db: number }[] {
  const n = 4096;
  const frames = stft(pcm, n, n / 2);
  const centers = [63, 125, 250, 500, 1000, 2000, 4000, 8000].filter((c) => c * Math.SQRT2 < sampleRate / 2);
  return centers.map((centerHz) => {
    const lo = Math.max(1, Math.floor((centerHz / Math.SQRT2 / sampleRate) * n));
    const hi = Math.min(n / 2 - 1, Math.ceil(((centerHz * Math.SQRT2) / sampleRate) * n));
    let p = 0;
    for (const fr of frames) for (let k = lo; k <= hi; k++) p += fr[k] * fr[k];
    // Normalize by window energy so a full-scale sine reads near 0 dBFS.
    const norm = frames.length * (n / 4) ** 2;
    return { centerHz, db: Math.round(toDb(p / Math.max(1, norm)) * 10) / 10 };
  });
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export interface ChordSegment {
  start: number;
  end: number;
  /** e.g. "C", "Am", or "N" for no chord. */
  chord: string;
  confidence: number;
}

/** 12-bin chromagram for each analysis frame. */
export function chromagram(pcm: Float32Array, sampleRate: number, n = 8192, hop = 4096): { frames: Float32Array[]; hopSeconds: number; energy: Float32Array } {
  const spec = stft(pcm, n, hop);
  const frames: Float32Array[] = [];
  const energy = new Float32Array(spec.length);
  const loBin = Math.ceil((65 / sampleRate) * n);
  const hiBin = Math.min(n / 2 - 1, Math.floor((2100 / sampleRate) * n));
  spec.forEach((mag, f) => {
    const chroma = new Float32Array(12);
    let e = 0;
    for (let k = loBin; k <= hiBin; k++) {
      // Only spectral peaks contribute, which keeps leakage out of neighbouring pitch classes.
      if (mag[k] < mag[k - 1] || mag[k] < mag[k + 1]) continue;
      const freq = (k * sampleRate) / n;
      const pc = ((Math.round(12 * Math.log2(freq / 440)) % 12) + 12 + 9) % 12; // A = 9
      chroma[pc] += mag[k] * mag[k];
      e += mag[k] * mag[k];
    }
    let norm = 0;
    for (const v of chroma) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < 12; i++) chroma[i] /= norm;
    frames.push(chroma);
    energy[f] = e;
  });
  return { frames, hopSeconds: hop / sampleRate, energy };
}

/** Major/minor triad recognition by chroma template matching with mode smoothing. */
export function detectChords(pcm: Float32Array, sampleRate: number): ChordSegment[] {
  const { frames, hopSeconds, energy } = chromagram(pcm, sampleRate);
  if (!frames.length) return [];
  let maxEnergy = 0;
  for (const e of energy) if (e > maxEnergy) maxEnergy = e;
  const names: string[] = [];
  const scores: number[] = [];
  const inv = 1 / Math.sqrt(3);
  frames.forEach((c, f) => {
    let best = "N";
    let bestScore = 0;
    if (energy[f] > maxEnergy * 1e-4) {
      for (let root = 0; root < 12; root++) {
        for (const [third, suffix] of [[4, ""], [3, "m"]] as const) {
          const s = (c[root] + c[(root + third) % 12] + c[(root + 7) % 12]) * inv;
          if (s > bestScore) {
            bestScore = s;
            best = NOTE_NAMES[root] + suffix;
          }
        }
      }
      if (bestScore < 0.75) best = "N";
    }
    names.push(best);
    scores.push(bestScore);
  });
  // Mode filter over 5 frames.
  const smooth = names.map((_, i) => {
    const counts = new Map<string, number>();
    for (let j = Math.max(0, i - 2); j <= Math.min(names.length - 1, i + 2); j++) counts.set(names[j], (counts.get(names[j]) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] === names[i] ? -1 : 1))[0][0];
  });
  const out: ChordSegment[] = [];
  const total = pcm.length / sampleRate;
  let start = 0;
  for (let i = 1; i <= smooth.length; i++) {
    if (i < smooth.length && smooth[i] === smooth[start]) continue;
    let sum = 0;
    for (let j = start; j < i; j++) sum += scores[j];
    out.push({
      start: start * hopSeconds,
      end: i === smooth.length ? total : i * hopSeconds,
      chord: smooth[start],
      confidence: Math.round((sum / (i - start)) * 100) / 100,
    });
    start = i;
  }
  return out;
}

/** Reduce an envelope to at most `maxPoints` (taking the max of each bucket). */
export function downsampleEnvelope(env: Envelope, maxPoints: number): { hopSeconds: number; db: number[] } {
  const factor = Math.max(1, Math.ceil(env.db.length / maxPoints));
  const db: number[] = [];
  for (let i = 0; i < env.db.length; i += factor) {
    let m = DB_FLOOR;
    for (let j = i; j < Math.min(env.db.length, i + factor); j++) if (env.db[j] > m) m = env.db[j];
    db.push(Math.round(m * 10) / 10);
  }
  return { hopSeconds: env.hopSeconds * factor, db };
}
