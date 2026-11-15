import { describe, expect, it } from "vitest";
import {
  addMediaToTimeline,
  applyTranscriptOps,
  captionSegments,
  findRetakes,
  formatTranscript,
  isRetake,
  mainTrack,
  timelineWords,
  trimElement,
  type MediaTranscript,
  type TranscriptOp,
  type TranscriptWord,
} from "../src/index.js";
import { makeSession } from "./fixtures.js";

/** "Here are tips." [1.2 s pause] "Um, first keep hooks short." "Second cut the silences." "Second cut every silence." [1 s] "Uh third add captions." */
const SCRIPT: [string, number, number][] = [
  ["Here", 0.2, 0.4], ["are", 0.45, 0.6], ["tips.", 0.65, 1.0],
  ["Um,", 2.2, 2.5], ["first", 2.6, 2.9], ["keep", 2.95, 3.2], ["hooks", 3.25, 3.6], ["short.", 3.65, 4.0],
  ["Second,", 4.5, 4.9], ["cut", 4.95, 5.1], ["the", 5.15, 5.25], ["silences.", 5.3, 5.8],
  ["Second,", 6.2, 6.6], ["cut", 6.65, 6.8], ["every", 6.85, 7.1], ["silence.", 7.15, 7.6],
  ["Uh,", 8.6, 8.9], ["third", 9.0, 9.2], ["add", 9.25, 9.4], ["captions.", 9.45, 9.8],
];

const transcript: MediaTranscript = {
  mediaId: "med_a",
  language: "en",
  model: "test",
  createdAt: 0,
  durationSourceSeconds: 10,
  words: SCRIPT.map(([text, s, e], i): TranscriptWord => ({ id: i + 1, text, startSourceSeconds: s, endSourceSeconds: e, confidence: 0.9, isFiller: /^(um|uh),?$/i.test(text) })),
};
const transcripts = { med_a: transcript };
const OPTS = { cutPaddingSeconds: 0.08, minSilenceSeconds: 0.35, defaultCaptionStyle: "bold" };

function setup() {
  const s = makeSession();
  const r = s.transact("add", "t", (ctx) => ({ a: addMediaToTimeline(ctx, ctx.draft.media.med_a, {}).id, b: addMediaToTimeline(ctx, ctx.draft.media.med_b, {}).id }));
  const run = (ops: TranscriptOp[]) => s.transact("edit", "t", (ctx) => applyTranscriptOps(ctx, ops, transcripts, OPTS), { skipFinalize: true });
  const words = () => timelineWords(s.state, transcripts).words;
  const text = () => words().map((w) => w.text).join(" ");
  return { s, run, words, text, ...r.result };
}

describe("transcript mapping", () => {
  it("maps words onto the timeline and follows trims", () => {
    const { s, a, words } = setup();
    expect(words()).toHaveLength(20);
    expect(words()[3]).toMatchObject({ id: 4, text: "Um,", start: 2.2, end: 2.5, elementId: a, isFiller: true });
    s.transact("trim", "t", (ctx) => trimElement(ctx, ctx.draft.elements[a], "left", 2));
    expect(words()[0]).toMatchObject({ id: 4, start: 0.2 });
    expect(words()).toHaveLength(17);
    const text = formatTranscript(words());
    expect(text).toContain("#4 Um,(filler)");
    expect(text).toMatch(/\[pause 0\.50s\]/);
  });

  it("detects retakes and false starts, not list items", () => {
    expect(isRetake(["second", "cut", "the", "silence"], ["second", "cut", "every", "single", "silence"])).toBe(true);
    expect(isRetake(["so", "the"], ["so", "the", "main", "thing"])).toBe(true);
    expect(isRetake(["first", "keep", "hook", "short"], ["second", "cut", "the", "silence"])).toBe(false);
    expect(isRetake(["here", "are", "tip"], ["first", "keep", "hook", "short"])).toBe(false);
    const { words } = setup();
    const takes = findRetakes(words());
    expect(takes).toHaveLength(1);
    expect(words()[takes[0].from].id).toBe(9);
    expect(words()[takes[0].keptFrom].id).toBe(13);
  });

  it("groups caption segments by word count, punctuation and pauses", () => {
    const { words } = setup();
    const segs = captionSegments(words(), 3);
    expect(segs.map((s) => s.words.map((w) => w.text).join(" ")).slice(0, 4)).toEqual(["Here are tips.", "Um, first keep", "hooks short.", "Second, cut the"]);
    expect(segs.every((s) => s.words.length <= 3)).toBe(true);
  });
});

describe("transcript ops", () => {
  it("removes silences, keeping padding around words, inside transcribed clips only", () => {
    const { s, run, words, b } = setup();
    const before = s.state.elements[b].duration;
    const r = run([{ op: "remove_silences" }]).result[0];
    // Gaps >= 0.35 s: leading 0.2 is shorter; 1.0->2.2, 4.0->4.5, 5.8->6.2, 7.6->8.6, and the 0.2 s tail is kept.
    expect(r.ranges).toHaveLength(4);
    // Each gap keeps 0.08 s on both sides; edges round inward to whole frames, so at most 1/30 s more is kept per edge.
    const ideal = 1.2 + 0.5 + 0.4 + 1.0 - 8 * 0.08;
    expect(r.removedSeconds).toBeLessThanOrEqual(ideal + 1e-6);
    expect(r.removedSeconds).toBeGreaterThan(ideal - 8 / 30);
    const w = words();
    expect(w).toHaveLength(20);
    for (let k = 1; k < w.length; k++) {
      const gap = w[k].start - w[k - 1].end;
      expect(gap).toBeLessThan(0.35);
      // Words that had a long pause between them still have the padding on both sides.
      if ([3, 8, 12, 16].includes(k)) expect(gap).toBeGreaterThanOrEqual(0.16 - 1e-6);
    }
    // The B-roll clip (no transcript) is untouched.
    expect(s.state.elements[b].duration).toBe(before);
  });

  it("removes fillers and retakes", () => {
    const { run, text } = setup();
    run([{ op: "remove_fillers" }]);
    expect(text()).not.toMatch(/\bUm,|\bUh,/);
    const r = run([{ op: "remove_retakes" }]).result[0];
    expect(r.retakes).toEqual([{ removed: "Second, cut the silences.", keptStartsAt: "#13" }]);
    expect(text()).toBe("Here are tips. first keep hooks short. Second, cut every silence. third add captions.");
  });

  it("cuts by word id and moves the hook to the start, all as one undo step", () => {
    const { s, run, words, text } = setup();
    const v = s.version;
    const res = run([{ op: "cut", from: 1, to: 3 }, { op: "move_to_start", from: 13, to: 16 }]);
    expect(s.version).toBe(v + 1);
    expect(res.result[0].removedWordIds).toEqual([1, 2, 3]);
    expect(text().startsWith("Second, cut every silence. Um, first")).toBe(true);
    // The hook starts with just its padding (0.08 s, frame-aligned), not the pause that preceded it.
    expect(words()[0].start).toBeGreaterThan(0.05);
    expect(words()[0].start).toBeLessThan(0.08 + 1 / 30);
    s.undo();
    expect(text().startsWith("Here are tips.")).toBe(true);
    expect(() => run([{ op: "cut", from: 50, to: 60 }])).toThrow(/not on the timeline/);
    expect(() => run([{ op: "cut", from: 5, to: 2 }])).toThrow(/invalid/);
  });

  it("adds captions with word ids and re-syncs them after later cuts", () => {
    const { s, run } = setup();
    run([{ op: "captions", style: "word_highlight_box_2", maxWords: 3 }, { op: "auto_zoom", scale: 1.1 }]);
    const caps = () => Object.values(s.state.elements).filter((e) => e.type === "caption");
    expect(caps().length).toBe(captionSegments(timelineWords(s.state, transcripts).words, 3).length);
    const first = caps().sort((x, y) => x.start - y.start)[0];
    expect(first.type === "caption" && first.words.map((w) => w.id)).toEqual([1, 2, 3]);
    const res = run([{ op: "remove_fillers" }, { op: "remove_silences" }]);
    expect(res.result.at(-1)).toMatchObject({ op: "captions", detail: expect.stringMatching(/re-synced/) });
    const allWords = caps().flatMap((c) => (c.type === "caption" ? c.words.map((w) => w.id) : []));
    expect(allWords).not.toContain(4);
    // Each caption still lines up with its words on the timeline.
    const tw = new Map(timelineWords(s.state, transcripts).words.map((w) => [w.id, w]));
    for (const c of caps()) if (c.type === "caption") expect(Math.abs(c.start - tw.get(Number(c.words[0].id))!.start)).toBeLessThan(0.05);
  });

  it("alternates punch-in zoom on talking clips and adds a hook title", () => {
    const { s, run } = setup();
    run([{ op: "cut", from: 9, to: 12 }, { op: "auto_zoom", scale: 1.12 }, { op: "title", text: "3 editing tips" }, { op: "brief", text: "tips reel" }]);
    const talking = mainTrack(s.state).elementIds.map((id) => s.state.elements[id]).filter((e) => e.type === "video" && e.mediaId === "med_a");
    expect(talking.length).toBe(2);
    expect(talking.map((e) => (e.type === "video" ? e.transform.scale : 0))).toEqual([1, 1.12]);
    expect(Object.values(s.state.elements).some((e) => e.type === "text" && e.text === "3 editing tips")).toBe(true);
    expect(s.state.brief).toBe("tips reel");
  });
});
