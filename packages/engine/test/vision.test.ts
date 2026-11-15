import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMediaToTimeline, addSticker, addText, reframeElement, setCanvas, sourceToCanvas, stackTwoSpeakers, type VideoElement } from "@openedits/core";
import { EngineHost, primarySubject, twoSpeakerSplit, visionHelperPath, type SubjectFrame } from "../src/index.js";
import { tempWorkspace, testMedia } from "./media.js";

const det = (x: number, y: number, w: number, h: number, confidence = 0.9) => ({ box: { x, y, w, h }, confidence });

describe("subject choice", () => {
  it("prefers the largest face, framed slightly below the eyes, then people, then salient regions", () => {
    const face = primarySubject({ faces: [det(0.1, 0.1, 0.1, 0.1), det(0.6, 0.2, 0.2, 0.2)], people: [] })!;
    expect(face.kind).toBe("face");
    expect(face.x).toBeCloseTo(0.7);
    expect(face.y).toBeCloseTo(0.37);
    const person = primarySubject({ faces: [], people: [det(0.2, 0.1, 0.2, 0.8)] })!;
    expect(person.kind).toBe("person");
    expect(person.x).toBeCloseTo(0.3);
    const salient = primarySubject({ faces: [], people: [], salient: det(0.5, 0.5, 0.2, 0.2) })!;
    expect(salient.kind).toBe("salient");
    expect(salient.x).toBeCloseTo(0.6);
    expect(salient.y).toBeCloseTo(0.6);
    expect(primarySubject({ faces: [], people: [] })).toBeUndefined();
  });

  it("asks for a split screen only when two speakers cannot share one vertical frame", () => {
    const frame = (a: number, b: number): SubjectFrame => ({ time: 0, sourceSeconds: 0, faces: [det(a, 0.3, 0.08, 0.14), det(b, 0.3, 0.08, 0.14)], people: [] });
    const apart = [frame(0.15, 0.75), frame(0.16, 0.74), frame(0.14, 0.76)];
    // A 9:16 crop of 16:9 footage shows 0.316 of the width.
    expect(twoSpeakerSplit(apart, 0.316)).toEqual({ a: 0.19, b: 0.79 });
    expect(twoSpeakerSplit([frame(0.4, 0.5), frame(0.41, 0.5)], 0.316)).toBeNull();
    expect(twoSpeakerSplit(apart, 1)).toBeNull(); // a 16:9 canvas shows both
  });
});

let host: EngineHost;
let clip: string;
const m = testMedia();
let mark = 0;

beforeAll(async () => {
  host = EngineHost.create({ workspaceRoot: tempWorkspace("vision"), validate: true });
  host.newProject({ name: "Vision", canvas: { aspectRatio: "16:9", resolution: "720p" } });
  const imp = await host.importMedia([m.object]);
  clip = host.mutate("add", "t", (c) => addMediaToTimeline(c, c.draft.media[imp.assets[0].id], {}).id).result;
});
afterAll(() => host.dispose());
beforeEach(() => {
  mark = host.session.history().undo.length;
});
afterEach(() => {
  while (host.session.history().undo.length > mark) host.undo("t");
});

const pixel = (file: string, x: number, y: number) => [...execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `crop=1:1:${x}:${y}`, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])];

describe("framing math", () => {
  it("centers the subject in a vertical crop without exposing the canvas edge", () => {
    host.mutate("reframe", "t", (c) => {
      setCanvas(c, { aspectRatio: "9:16" });
      const el = c.draft.elements[clip] as VideoElement;
      // Subject at the far left: the frame clamps so the clip still covers the canvas.
      reframeElement(c, el, [{ time: 1, x: 0.05, y: 0.5 }], "static");
      // 640x360 covering 720x1280 is 3.16 canvas widths wide; the clip's left edge stops at the canvas edge.
      const halfWidth = ((640 * (1280 / 360)) / 720) / 2;
      expect(el.transform.x).toBeCloseTo(halfWidth, 3);
      const p = sourceToCanvas(c.draft, el, 0, 0.5, 1);
      expect(p.x).toBeCloseTo(0, 3);
      reframeElement(c, el, [{ time: 1, x: 0.5, y: 0.5 }], "static");
      expect(el.transform.x).toBeCloseTo(0.5);
      // Follow: keyframes track a moving subject, with a dead zone.
      const r = reframeElement(c, el, [0, 0.5, 1, 1.5, 2, 2.5].map((t) => ({ time: t, x: 0.3 + t * 0.1, y: 0.5 })), "follow");
      expect(r.keyframes).toBeGreaterThan(2);
      expect(el.keyframes.x!.length).toBe(r.keyframes);
      expect(el.keyframes.x![0].value).toBeGreaterThan(el.keyframes.x!.at(-1)!.value); // subject moves right, frame moves left
    });
  });

  it("clamps a panel crop at the frame edge", () => {
    host.mutate("stack", "t", (c) => {
      setCanvas(c, { aspectRatio: "9:16" });
      const r = stackTwoSpeakers(c, c.draft.elements[clip] as VideoElement, 0.05, 0.95);
      const [top, bottom] = r.panelIds.map((id) => c.draft.elements[id] as VideoElement);
      expect(top.crop!.left).toBe(0);
      expect(bottom.crop!.right).toBeCloseTo(0, 6);
    });
  });

  it("stacks two far-apart speakers, each panel cropped onto one person", () => {
    host.mutate("stack", "t", (c) => {
      setCanvas(c, { aspectRatio: "9:16" });
      const r = stackTwoSpeakers(c, c.draft.elements[clip] as VideoElement, 0.35, 0.65);
      const [top, bottom] = r.panelIds.map((id) => c.draft.elements[id] as VideoElement);
      const centerOf = (e: VideoElement) => (e.crop!.left + (1 - e.crop!.right)) / 2;
      expect(centerOf(top)).toBeCloseTo(0.35, 3);
      expect(centerOf(bottom)).toBeCloseTo(0.65, 3);
      // Each panel shows the same width of the source (about 64% for 16:9 into a half-height 9:16 panel).
      expect(1 - top.crop!.left - top.crop!.right).toBeCloseTo(1 - bottom.crop!.left - bottom.crop!.right, 6);
    });
  });
});

describe.runIf(process.platform === "darwin" && (() => { try { return !!visionHelperPath(); } catch { return false; } })())("Apple Vision pipeline", () => {
  it("finds the moving object when there are no faces", { timeout: 60_000 }, async () => {
    const r = await host.vision.subjects({ elementId: clip, perSecond: 1 });
    expect(r.frames.length).toBe(3);
    expect(r.frames.every((f) => f.faces.length === 0 && f.primary?.kind === "salient")).toBe(true);
    // The salient region moves right with the object.
    expect(r.frames[2].primary!.x).toBeGreaterThan(r.frames[0].primary!.x);
  });

  it("tracks the object frame to frame", { timeout: 60_000 }, async () => {
    // At t = 0 the square is at x = 80..200, y = 120..240 of 640x360.
    const r = await host.vision.track({ elementId: clip, box: { x: 80 / 640, y: 120 / 360, w: 120 / 640, h: 120 / 360 }, perSecond: 15 });
    expect(r.lost).toBe(false);
    for (const f of r.frames) expect(f.box.x).toBeCloseTo((80 + 100 * f.time) / 640, 1);
    expect(r.frames.at(-1)!.time).toBeGreaterThan(2.5);
  });

  it("cuts the subject out into a sticker placed where it was", { timeout: 60_000 }, async () => {
    const cut = await host.vision.cutout({ elementId: clip, time: 1, kind: "subject" });
    expect([cut.width, cut.height]).toEqual([120, 121]);
    expect(cut.box!.x).toBeCloseTo(180 / 640, 2);
    const probe = await host.prober(cut.path);
    expect(probe.kind).toBe("image");
    const imp = await host.importMedia([cut.path]);
    host.mutate("sticker", "t", (c) => {
      const el = c.draft.elements[clip] as VideoElement;
      // Hide the clip so only the sticker can produce orange pixels; place the sticker at the left edge.
      el.opacity = 0;
      const p = sourceToCanvas(c.draft, el, 0.1, 0.5, 1);
      addSticker(c, { cutoutMaskId: imp.assets[0].id, start: 0, duration: 3, transform: { x: p.x, y: p.y, scale: 0.2 } });
    });
    const f = await host.render.captureFrame({ timeSeconds: 1, shortSide: 360, format: "png" });
    const [r, g, b] = pixel(f.path, 64, 180);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(140);
    expect(b).toBeLessThan(80);
    expect(pixel(f.path, 400, 180)[0]).toBeLessThan(10);
  });

  it("draws a subject outline that follows the object", { timeout: 120_000 }, async () => {
    const r = await host.vision.subjectMask(host.project.elements[clip] as VideoElement, "subject", { signal: new AbortController().signal, progress: () => {} });
    expect(r.frames).toBe(90);
    expect(fs.existsSync(r.path)).toBe(true);
    const imp = await host.importMedia([r.path]);
    host.mutate("fx", "t", (c) => {
      const el = c.draft.elements[clip] as VideoElement;
      el.effects.push({ instanceId: "fx_outline", effectId: "outline", intensity: 100, params: { color: "#FF00FF", width: 20, maskStartSourceSeconds: r.startSourceSeconds }, subjectMaskId: imp.assets[0].id });
    });
    // At t = 2 the square spans x = 280..400; just outside its left edge the outline is magenta.
    const f = await host.render.captureFrame({ timeSeconds: 2, shortSide: 360, format: "png" });
    expect(f.warnings).toEqual([]);
    const ring = pixel(f.path, 272, 180);
    expect(ring[0]).toBeGreaterThan(150);
    expect(ring[2]).toBeGreaterThan(150);
    expect(ring[1]).toBeLessThan(110);
    // Inside the square stays orange, far away stays blue.
    expect(pixel(f.path, 340, 180)[0]).toBeGreaterThan(200);
    expect(pixel(f.path, 600, 40)[2]).toBeGreaterThan(110);
    void addText;
  });
});
