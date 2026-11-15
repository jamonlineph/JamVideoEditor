import { describe, expect, it } from "vitest";
import {
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
