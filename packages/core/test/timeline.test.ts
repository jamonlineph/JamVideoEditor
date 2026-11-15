import { describe, expect, it } from "vitest";
import {
  addCaptions,
  addMediaToTimeline,
  addText,
  addTransition,
  convertToMain,
  convertToOverlay,
  deleteElements,
  duplicateElement,
  extractAudio,
  mainTrack,
  moveElement,
  moveToLayer,
  reorderMain,
  setKeyframe,
  setSpeed,
  setSpeedCurve,
  slipElement,
  splitAt,
  splitElement,
  splitScreen,
  trimElement,
  trimEndTo,
  trimStartTo,
  validateProject,
  evaluateProperty,
  mergeCaptions,
  splitCaption,
  setCanvas,
  setRippleTiers,
  timelineDurationFor,
  type Project,
  type VideoElement,
} from "../src/index.js";
import { makeSession } from "./fixtures.js";

function mainIds(p: Project) {
  return mainTrack(p).elementIds;
}

function twoClips() {
  const s = makeSession();
  const r = s.transact("add", "test", (ctx) => {
    const a = addMediaToTimeline(ctx, ctx.draft.media.med_a, {});
    const b = addMediaToTimeline(ctx, ctx.draft.media.med_b, {});
    return { a: a.id, b: b.id };
  });
  return { s, ...r.result };
}

describe("main track", () => {
  it("appends gaplessly", () => {
    const { s, a, b } = twoClips();
    expect(mainIds(s.state)).toEqual([a, b]);
    expect(s.state.elements[a].start).toBe(0);
    expect(s.state.elements[b].start).toBe(10);
    expect(s.state.elements[b].duration).toBe(8);
  });

  it("inserting at a time inside a clip splits it", () => {
    const { s, a } = twoClips();
    s.transact("insert", "test", (ctx) => addMediaToTimeline(ctx, ctx.draft.media.med_img, { start: 4 }));
    const ids = mainIds(s.state);
    expect(ids.length).toBe(4);
    expect(ids[0]).toBe(a);
    expect(s.state.elements[ids[0]].duration).toBe(4);
    expect(s.state.elements[ids[1]].type).toBe("image");
    expect(s.state.elements[ids[2]].start).toBe(7);
  });

  it("split keeps source windows contiguous and is one undo step", () => {
    const { s, a } = twoClips();
    const v0 = s.version;
    s.transact("split", "test", (ctx) => splitElement(ctx, ctx.draft.elements[a], 3.5));
    const [l, r] = mainIds(s.state).slice(0, 2).map((id) => s.state.elements[id] as VideoElement);
    expect(l.duration).toBeCloseTo(3.5);
    expect(r.sourceInSourceSeconds).toBeCloseTo(3.5);
    expect(l.sourceDurationSourceSeconds + r.sourceDurationSourceSeconds).toBeCloseTo(10);
    s.undo();
    expect(mainIds(s.state).length).toBe(2);
    expect(s.version).toBe(v0 + 2);
  });

  it("splitAt with 1000 times is a single atomic, frame-snapped step", () => {
    const s = makeSession();
    s.transact("add", "test", (ctx) => {
      addMediaToTimeline(ctx, ctx.draft.media.med_music, { asOverlay: true });
      addMediaToTimeline(ctx, ctx.draft.media.med_a, {});
      addMediaToTimeline(ctx, ctx.draft.media.med_b, {});
    });
    const before = s.state;
    const times = Array.from({ length: 1000 }, (_, i) => 0.0101 + i * 0.0177);
    const res = s.transact("splitAt", "test", (ctx) => splitAt(ctx, { times, snap: "projectFrame" }));
    expect(res.result.splits).toBeGreaterThan(400);
    const total = mainIds(s.state).reduce((acc, id) => acc + s.state.elements[id].duration, 0);
    expect(total).toBeCloseTo(18, 6);
    for (const id of mainIds(s.state)) {
      const el = s.state.elements[id];
      expect(Math.abs(el.start * 30 - Math.round(el.start * 30))).toBeLessThan(1e-6);
    }
    // Audio on a free track was untouched (default scope is the main track).
    const audioTrack = s.state.tracks.find((t) => t.kind === "music")!;
    expect(audioTrack.elementIds.length).toBe(1);
    s.undo();
    expect(s.state).toEqual(before);
  });

  it("rejects more than 1000 times", () => {
    const { s } = twoClips();
    expect(() => s.transact("x", "t", (ctx) => splitAt(ctx, { times: Array.from({ length: 1001 }, (_, i) => i / 100) }))).toThrow(/At most 1000/);
  });

  it("trims ripple downstream and clamp to media", () => {
    const { s, a, b } = twoClips();
    s.transact("trim", "t", (ctx) => trimElement(ctx, ctx.draft.elements[a], "right", 2));
    expect(s.state.elements[b].start).toBe(8);
    s.transact("trimStart", "t", (ctx) => trimStartTo(ctx, ctx.draft.elements[a], 1));
    expect((s.state.elements[a] as VideoElement).sourceInSourceSeconds).toBe(1);
    expect(s.state.elements[a].duration).toBe(7);
    expect(s.state.elements[b].start).toBe(7);
    // Extend beyond available media: clamps with a warning.
    const r = s.transact("extend", "t", (ctx) => trimElement(ctx, ctx.draft.elements[a], "left", -5));
    expect(r.warnings.join(" ")).toMatch(/extended only/);
    expect((s.state.elements[a] as VideoElement).sourceInSourceSeconds).toBe(0);
    s.transact("trimEnd", "t", (ctx) => trimEndTo(ctx, ctx.draft.elements[a], 5));
    expect(s.state.elements[a].duration).toBe(5);
  });

  it("slip shifts the source window only", () => {
    const { s, a } = twoClips();
    s.transact("trim", "t", (ctx) => trimElement(ctx, ctx.draft.elements[a], "right", 4));
    s.transact("slip", "t", (ctx) => slipElement(ctx, ctx.draft.elements[a], 3));
    const el = s.state.elements[a] as VideoElement;
    expect(el.sourceInSourceSeconds).toBe(3);
    expect(el.duration).toBe(6);
    const r = s.transact("slip", "t", (ctx) => slipElement(ctx, ctx.draft.elements[a], 10));
    expect(r.result).toBe(1);
  });

  it("reorder, delete and duplicate keep the main track gapless", () => {
    const { s, a, b } = twoClips();
    s.transact("reorder", "t", (ctx) => reorderMain(ctx, ctx.draft.elements[b], 0));
    expect(mainIds(s.state)).toEqual([b, a]);
    expect(s.state.elements[a].start).toBe(8);
    const dup = s.transact("dup", "t", (ctx) => duplicateElement(ctx, ctx.draft.elements[b]).id).result;
    expect(mainIds(s.state)).toEqual([b, dup, a]);
    s.transact("del", "t", (ctx) => deleteElements(ctx, [b]));
    expect(s.state.elements[dup].start).toBe(0);
    expect(s.state.elements[a].start).toBe(8);
  });

  it("speed changes recompute duration and ripple", () => {
    const { s, a, b } = twoClips();
    s.transact("speed", "t", (ctx) => setSpeed(ctx, ctx.draft.elements[a], 2));
    expect(s.state.elements[a].duration).toBe(5);
    expect(s.state.elements[b].start).toBe(5);
    s.transact("curve", "t", (ctx) => setSpeedCurve(ctx, ctx.draft.elements[a], { preset: "HERO" }));
    const el = s.state.elements[a] as VideoElement;
    expect(el.duration).toBeCloseTo(timelineDurationFor(10, el.speed), 9);
    // Split a curve clip: durations and source spans stay consistent.
    s.transact("split", "t", (ctx) => splitElement(ctx, ctx.draft.elements[a], el.duration / 2));
    expect(validateProject(s.state)).toEqual([]);
  });

  it("splitting a keyframed clip keeps the animation", () => {
    const { s, a } = twoClips();
    s.transact("kf", "t", (ctx) => {
      const el = ctx.draft.elements[a];
      setKeyframe(ctx, el, { property: "scale", offsetSeconds: 0, value: 1 });
      setKeyframe(ctx, el, { property: "scale", offsetSeconds: 10, value: 2, easing: { type: "linear" } });
    });
    const samples = [0, 2, 4.9, 6, 9.5].map((t) => evaluateProperty(s.state.elements[a], "scale", t));
    const right = s.transact("split", "t", (ctx) => splitElement(ctx, ctx.draft.elements[a], 5)!.id).result;
    const at = (t: number) => (t < 5 ? evaluateProperty(s.state.elements[a], "scale", t) : evaluateProperty(s.state.elements[right], "scale", t));
    [0, 2, 4.9, 6, 9.5].forEach((t, i) => expect(at(t)).toBeCloseTo(samples[i], 9));
  });
});

describe("free tracks and ripple tiers", () => {
  function withOverlay(tiers: { tier1RippleEnabled: boolean; tier2RippleEnabled: boolean }) {
    const { s, a, b } = twoClips();
    s.transact("tiers", "t", (ctx) => setRippleTiers(ctx, tiers));
    const o = s.transact("overlay", "t", (ctx) => addText(ctx, { text: "Hi", start: 12, duration: 2 }).id).result;
    return { s, a, b, o };
  }

  it("tier 1: overlays follow their anchor clip", () => {
    const { s, a, b, o } = withOverlay({ tier1RippleEnabled: true, tier2RippleEnabled: false });
    expect(s.state.elements[o].anchor).toEqual({ elementId: b, offsetSeconds: 2 });
    s.transact("trim", "t", (ctx) => trimElement(ctx, ctx.draft.elements[a], "right", 3));
    expect(s.state.elements[o].start).toBe(9);
  });

  it("tier 2: unanchored elements downstream shift", () => {
    const { s, a, o } = withOverlay({ tier1RippleEnabled: false, tier2RippleEnabled: true });
    s.transact("del", "t", (ctx) => deleteElements(ctx, [a]));
    expect(s.state.elements[o].start).toBe(2);
  });

  it("tiers off: free elements never move", () => {
    const { s, a, o } = withOverlay({ tier1RippleEnabled: false, tier2RippleEnabled: false });
    s.transact("del", "t", (ctx) => deleteElements(ctx, [a]));
    expect(s.state.elements[o].start).toBe(12);
  });

  it("overlapping free elements get their own lane", () => {
    const { s } = twoClips();
    const t1 = s.transact("t1", "t", (ctx) => addText(ctx, { text: "A", start: 1, duration: 4 }).id).result;
    const t2 = s.transact("t2", "t", (ctx) => addText(ctx, { text: "B", start: 2, duration: 4 }).id).result;
    expect(s.state.elements[t1].trackId).not.toBe(s.state.elements[t2].trackId);
    s.transact("move", "t", (ctx) => moveElement(ctx, ctx.draft.elements[t2], { start: 6, trackId: ctx.draft.elements[t1].trackId, snap: false }));
    expect(s.state.elements[t2].trackId).toBe(s.state.elements[t1].trackId);
    // The emptied lane is pruned.
    expect(s.state.tracks.filter((t) => t.kind === "text").length).toBe(1);
  });

  it("moveToLayer up creates a lane above", () => {
    const { s } = twoClips();
    const t1 = s.transact("t1", "t", (ctx) => addText(ctx, { text: "A", start: 1, duration: 4 }).id).result;
    const t2 = s.transact("t2", "t", (ctx) => addText(ctx, { text: "B", start: 6, duration: 2 }).id).result;
    s.transact("layer", "t", (ctx) => moveToLayer(ctx, ctx.draft.elements[t2], { direction: "up" }));
    const idx = (id: string) => s.state.tracks.findIndex((t) => t.id === s.state.elements[id].trackId);
    expect(idx(t2)).toBeGreaterThan(idx(t1));
  });

  it("convert between main and overlay", () => {
    const { s, a, b } = twoClips();
    s.transact("toOverlay", "t", (ctx) => convertToOverlay(ctx, ctx.draft.elements[a]));
    expect(s.state.elements[b].start).toBe(0);
    expect(s.state.tracks.find((t) => t.id === s.state.elements[a].trackId)!.kind).toBe("overlay");
    s.transact("toMain", "t", (ctx) => convertToMain(ctx, ctx.draft.elements[a], { index: 1 }));
    expect(mainIds(s.state)).toEqual([b, a]);
  });

  it("extractAudio creates a linked audio element", () => {
    const { s, a } = twoClips();
    const audio = s.transact("x", "t", (ctx) => extractAudio(ctx, ctx.draft.elements[a]).id).result;
    const v = s.state.elements[a] as VideoElement;
    expect(v.audioDetached).toBe(true);
    expect(v.linkedAudioId).toBe(audio);
    expect(s.state.elements[audio].start).toBe(0);
    expect(() => s.transact("x", "t", (ctx) => extractAudio(ctx, ctx.draft.elements[a]))).toThrow(/already extracted/);
  });
});

describe("transitions, split screen, captions", () => {
  it("transitions work on untrimmed clips (edge frames are held), clamp to the shorter clip and drop when clips separate", () => {
    const { s, a, b } = twoClips();
    // Two whole clips have no spare footage at the cut: the transition is still added, with a note.
    const whole = s.transact("tr", "t", (ctx) => addTransition(ctx, { fromElementId: a, type: "dissolve", durationSeconds: 1 }));
    expect(whole.result!.durationSeconds).toBe(1);
    expect(whole.warnings.join(" ")).toMatch(/edge frames are held/);
    s.undo("t");
    s.transact("trim", "t", (ctx) => {
      trimElement(ctx, ctx.draft.elements[a], "right", 0.6);
      trimElement(ctx, ctx.draft.elements[b], "left", 1);
    });
    // With handles on both sides there is nothing to warn about.
    const r = s.transact("tr", "t", (ctx) => addTransition(ctx, { fromElementId: a, type: "dissolve", durationSeconds: 1 }));
    expect(r.result!.durationSeconds).toBe(1);
    expect(r.warnings).toEqual([]);
    const shorter = Math.min(s.state.elements[a].duration, s.state.elements[b].duration);
    const long = s.transact("tr", "t", (ctx) => addTransition(ctx, { fromElementId: a, type: "dissolve", durationSeconds: 100 }));
    expect(long.result!.durationSeconds).toBeCloseTo(shorter);
    expect(long.warnings.join(" ")).toMatch(/shortened/);
    s.transact("reorder", "t", (ctx) => reorderMain(ctx, ctx.draft.elements[b], 0));
    expect(s.state.transitions).toEqual([]);
  });

  it("split screen stacks two panels with a background", () => {
    const { s, a, b } = twoClips();
    const r = s.transact("ss", "t", (ctx) => splitScreen(ctx, { elementIds: [a, b], layout: "stack2", gap: 0.02, background: { type: "solid", color: "#111111" } }));
    const [top, bottom] = r.result.panelIds.map((id) => s.state.elements[id] as VideoElement);
    expect(top.transform.y).toBeCloseTo(0.245);
    expect(bottom.transform.y).toBeCloseTo(0.755);
    expect(top.crop).toBeDefined();
    expect(s.state.elements[r.result.backgroundId].type).toBe("shape");
    expect(validateProject(s.state)).toEqual([]);
  });

  it("captions split and merge", () => {
    const { s } = twoClips();
    const [c] = s.transact("cap", "t", (ctx) =>
      addCaptions(ctx, [{ start: 1, end: 3, words: [
        { text: "hello", start: 1, end: 1.5 },
        { text: "big", start: 1.6, end: 2 },
        { text: "world", start: 2.1, end: 2.8 },
      ] }], { styleId: "bold", highlightColor: "#FFE14D" }),
    ).result;
    const right = s.transact("split", "t", (ctx) => splitCaption(ctx, c.id, "w3").id).result;
    expect(s.state.elements[right].start).toBeCloseTo(2.1);
    s.transact("merge", "t", (ctx) => mergeCaptions(ctx, [c.id, right]));
    const merged = s.state.elements[c.id];
    expect(merged.type === "caption" && merged.words.map((w) => w.text)).toEqual(["hello", "big", "world"]);
    expect(s.state.elements[right]).toBeUndefined();
  });

  it("canvas changes keep normalized positions", () => {
    const { s } = twoClips();
    const t = s.transact("text", "t", (ctx) => addText(ctx, { text: "A", start: 0, duration: 1, transform: { x: 0.3, y: 0.7 } }).id).result;
    s.transact("canvas", "t", (ctx) => setCanvas(ctx, { aspectRatio: "16:9", resolution: "4K" }));
    const el = s.state.elements[t];
    expect(el.type === "text" && el.transform.x).toBe(0.3);
    expect(el.type === "text" && el.transform.y).toBe(0.7);
  });
});
