import { describe, expect, it } from "vitest";
import {
  BUILTIN_LUT_IDS,
  LUTS_CATALOG,
  builtinLut,
  logEncoder,
  addAdjustmentLayer,
  addMediaToTimeline,
  addText,
  addTransition,
  applyFilter,
  buildAudioPlan,
  clipGainAt,
  evaluateScene,
  extractAudio,
  frameTimes,
  renderSizeFor,
  resolveColor,
  sceneMediaLayers,
  setFade,
  setKeyframe,
  setReversed,
  setSpeed,
  setSpeedCurve,
  setTextAnimation,
  sourceTimeAt,
  speedSegments,
  timelineTimeOfSource,
  trimElement,
  defaultColor,
  type MediaLayer,
  type TextLayer,
  type TransitionLayer,
  type VideoElement,
} from "../src/index.js";
import { makeSession } from "./fixtures.js";

const SIZE = { width: 540, height: 960 };

function setup() {
  const s = makeSession();
  const r = s.transact("add", "t", (ctx) => ({
    a: addMediaToTimeline(ctx, ctx.draft.media.med_a, {}).id,
    b: addMediaToTimeline(ctx, ctx.draft.media.med_b, {}).id,
  }));
  return { s, ...r.result };
}

describe("time mapping", () => {
  it("maps timeline time to source time through speed and reverse", () => {
    const { s, a } = setup();
    const el = () => s.state.elements[a] as VideoElement;
    expect(sourceTimeAt(s.state, el(), 2.5)).toBeCloseTo(2.5);
    s.transact("speed", "t", (ctx) => setSpeed(ctx, ctx.draft.elements[a], 2));
    expect(sourceTimeAt(s.state, el(), 2.5)).toBeCloseTo(5);
    expect(timelineTimeOfSource(el(), 5)).toBeCloseTo(2.5);
    s.transact("rev", "t", (ctx) => setReversed(ctx, ctx.draft.elements[a], true));
    expect(sourceTimeAt(s.state, el(), 0)).toBeCloseTo(10);
    expect(sourceTimeAt(s.state, el(), 2.5)).toBeCloseTo(5);
    expect(timelineTimeOfSource(el(), 10)).toBeCloseTo(0);
  });

  it("segments a speed curve so the pieces add up to the clip", () => {
    const { s, a } = setup();
    s.transact("curve", "t", (ctx) => setSpeedCurve(ctx, ctx.draft.elements[a], { preset: "HERO" }));
    const el = s.state.elements[a] as VideoElement;
    const segs = speedSegments(el);
    const tl = segs.reduce((acc, g) => acc + ((g.p1 - g.p0) * el.sourceDurationSourceSeconds) / g.rate, 0);
    expect(tl).toBeCloseTo(el.duration, 6);
    expect(segs[0].p0).toBe(0);
    expect(segs.at(-1)!.p1).toBeCloseTo(1, 9);
  });
});

describe("scene evaluation", () => {
  it("orders layers bottom-up and sizes media by fit", () => {
    const { s } = setup();
    s.transact("text", "t", (ctx) => addText(ctx, { text: "Hi", start: 0, duration: 4, transform: { x: 0.25, y: 0.75 } }));
    const scene = evaluateScene(s.state, 1, SIZE);
    expect(scene.layers.map((l) => l.kind)).toEqual(["media", "text"]);
    const m = scene.layers[0] as MediaLayer;
    expect([m.width, m.height, m.cx, m.cy]).toEqual([540, 960, 270, 480]);
    expect(m.sourceSeconds).toBeCloseTo(1);
    const t = scene.layers[1] as TextLayer;
    expect([t.cx, t.cy]).toEqual([135, 720]);
    expect(t.fontPx).toBeCloseTo(0.06 * 540);
    // Landscape media on a portrait canvas covers by height.
    const b = evaluateScene(s.state, 12, SIZE).layers[0] as MediaLayer;
    expect(b.height).toBeCloseTo(960);
    expect(b.width).toBeCloseTo((960 * 1920) / 1080);
  });

  it("evaluates keyframes and text animations", () => {
    const { s, a } = setup();
    const text = s.transact("kf", "t", (ctx) => {
      setKeyframe(ctx, ctx.draft.elements[a], { property: "scale", offsetSeconds: 0, value: 1 });
      setKeyframe(ctx, ctx.draft.elements[a], { property: "scale", offsetSeconds: 2, value: 1.5 });
      const el = addText(ctx, { text: "Pop", start: 0, duration: 2 });
      setTextAnimation(ctx, el.id, { in: { id: "fade_in", durationSeconds: 1 }, out: { id: "typewriter", durationSeconds: 0.5 } });
      return el.id;
    }).result;
    const at = (t: number) => evaluateScene(s.state, t, SIZE);
    expect((at(1).layers[0] as MediaLayer).width).toBeCloseTo(540 * 1.25);
    const fading = at(0.1).layers.find((l) => l.kind === "text" && l.elementId === text) as TextLayer;
    expect(fading.opacity).toBeGreaterThan(0);
    expect(fading.opacity).toBeLessThan(1);
    expect((at(1.2).layers[1] as TextLayer).opacity).toBe(1);
    expect((at(1.75).layers[1] as TextLayer).reveal).toBeCloseTo(0.5);
  });

  it("emits a transition with both clips reaching into their handles", () => {
    const { s, a, b } = setup();
    s.transact("handles", "t", (ctx) => {
      trimElement(ctx, ctx.draft.elements[a], "right", 1);
      trimElement(ctx, ctx.draft.elements[b], "left", 1);
      addTransition(ctx, { fromElementId: a, type: "dissolve", durationSeconds: 1 });
    });
    const scene = evaluateScene(s.state, 9.25, SIZE); // cut at 9, transition spans 8.5..9.5
    const tr = scene.layers[0] as TransitionLayer;
    expect(tr.kind).toBe("transition");
    expect(tr.progress).toBeCloseTo(0.75);
    expect(tr.from!.sourceSeconds).toBeCloseTo(9.25); // past a's out-point (9) into its tail handle
    expect(tr.to!.sourceSeconds).toBeCloseTo(1.25);
    expect(sceneMediaLayers(scene).length).toBe(2);
    expect((evaluateScene(s.state, 8.4, SIZE).layers[0] as MediaLayer).kind).toBe("media");
    const early = evaluateScene(s.state, 8.75, SIZE).layers[0] as TransitionLayer;
    expect(early.to!.sourceSeconds).toBeCloseTo(0.75); // before b's in-point (1)
  });

  it("folds filters into the grade and skips identity color", () => {
    const { s } = setup();
    expect(resolveColor(defaultColor())).toBeNull();
    const adj = s.transact("adj", "t", (ctx) => {
      const el = addAdjustmentLayer(ctx, { start: 0, duration: 3 });
      applyFilter(ctx, el, "warm", 50);
      return el.id;
    }).result;
    const layer = evaluateScene(s.state, 1, SIZE).layers.find((l) => l.kind === "adjustment" && l.elementId === adj);
    expect(layer && layer.kind === "adjustment" && layer.color?.grade.temperature).toBe(15);
  });

  it("derives render sizes and frame times", () => {
    const { s } = setup();
    expect(renderSizeFor(s.state, 540)).toEqual({ width: 540, height: 960 });
    expect(frameTimes(s.state).length).toBe(18 * 30);
    expect(frameTimes(s.state, { startSeconds: 1, endSeconds: 2 }, 10)).toHaveLength(10);
  });
});

describe("audio plan", () => {
  it("lists audible clips and skips muted or detached audio", () => {
    const { s, a, b } = setup();
    s.transact("music", "t", (ctx) => {
      const m = addMediaToTimeline(ctx, ctx.draft.media.med_music, {});
      setFade(ctx, m, { fadeInSeconds: 2, fadeOutSeconds: 1 });
    });
    let plan = buildAudioPlan(s.state);
    expect(plan.map((c) => c.role).sort()).toEqual(["music", "video", "video"]);
    expect(plan.find((c) => c.elementId === a)!.isVoice).toBe(true);
    const music = plan.find((c) => c.role === "music")!;
    expect(clipGainAt(music, 1)).toBeCloseTo(0.5);
    expect(clipGainAt(music, 15)).toBe(1);
    expect(clipGainAt(music, 29.5)).toBeCloseTo(0.5);
    s.transact("x", "t", (ctx) => {
      extractAudio(ctx, ctx.draft.elements[a]);
      (ctx.draft.elements[b] as VideoElement).muted = true;
    });
    plan = buildAudioPlan(s.state);
    expect(plan.map((c) => c.role).sort()).toEqual(["extracted", "music"]);
  });
});

describe("built-in camera LUTs", () => {
  // Each vendor's 18% grey as a decoded (video-range) pixel value; a good Rec.709 conversion shows it near 0.43.
  const videoRange = (fullCode: number) => (fullCode * 1023 - 64) / 876;
  const MID_GREY: Record<string, number> = {
    apple_log_to_rec709: 0.488,
    sony_slog2_sgamut3_to_rec709: 0.308,
    sony_slog3_sgamut3_to_rec709: videoRange(420 / 1023),
    canon_clog_to_rec709: 0.328,
    canon_clog3_to_rec709: 0.328,
    dji_dlog_to_rec709: 0.3988,
    fuji_flog_to_rec709: videoRange(470 / 1023),
    fuji_flog2_to_rec709: videoRange(400 / 1023),
    panasonic_vlog_to_rec709: videoRange(433 / 1023),
  };

  it("generates every catalog camera LUT with black at 0, grey near 0.43 and a monotone curve", () => {
    const catalog = LUTS_CATALOG.map((l) => l.id).filter((id) => id !== "custom");
    expect(BUILTIN_LUT_IDS.sort()).toEqual([...catalog].sort());
    for (const id of catalog) {
      const lut = builtinLut(id, 33)!;
      expect(lut.data.length).toBe(33 ** 3 * 3);
      const grey = (v: number) => {
        const i = Math.round(v * 32);
        return lut.data[((i * 33 + i) * 33 + i) * 3];
      };
      expect(grey(0), id).toBeLessThan(0.02);
      for (let i = 1; i <= 32; i++) expect(grey(i / 32), `${id} at ${i}`).toBeGreaterThanOrEqual(grey((i - 1) / 32) - 1e-6);
      expect(grey(1), `${id} white`).toBeGreaterThan(0.9);
      if (MID_GREY[id]) {
        expect(grey(MID_GREY[id]), id).toBeGreaterThan(0.38);
        expect(grey(MID_GREY[id]), id).toBeLessThan(0.5);
      }
    }
    expect(builtinLut("nope")).toBeNull();
  });
});

describe("log encoding for LUT previews", () => {
  it("is undone by the matching LUT (round trip within a few percent)", () => {
    for (const id of BUILTIN_LUT_IDS) {
      const encode = logEncoder(id)!;
      const lut = builtinLut(id, 65)!;
      const n = lut.size;
      // Trilinear lookup, as the GPU does it.
      const apply = ([r, g, b]: number[]) => {
        const p = [r, g, b].map((v) => Math.min(n - 1 - 1e-6, Math.max(0, v * (n - 1))));
        const i = p.map(Math.floor);
        const f = p.map((v, k) => v - i[k]);
        const out = [0, 0, 0];
        for (let dz = 0; dz < 2; dz++)
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) {
              const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
              const o = (((i[2] + dz) * n + (i[1] + dy)) * n + (i[0] + dx)) * 3;
              for (let c = 0; c < 3; c++) out[c] += w * lut.data[o + c];
            }
        return out;
      };
      for (const rgb of [[0.5, 0.5, 0.5], [0.8, 0.4, 0.2], [0.2, 0.5, 0.7], [0.9, 0.9, 0.6]] as [number, number, number][]) {
        const back = apply(encode(rgb));
        for (let c = 0; c < 3; c++) expect(Math.abs(back[c] - rgb[c]), `${id} ${rgb}`).toBeLessThan(0.04);
      }
    }
  });
});
