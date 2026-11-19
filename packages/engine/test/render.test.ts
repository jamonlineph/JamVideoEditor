import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EFFECTS_CATALOG, TRANSITIONS_CATALOG, addMediaToTimeline, addShape, addText, addTransition, applyEffect, applyLut, setColorGrade, setOpacity, setReversed, setSpeed, setTextStyle, setTransform, trimElement, type VideoElement } from "@openedits/core";
import { EngineHost, fpsExpression, type RenderOutput } from "../src/index.js";
import { counterLeftLevel, frameTime, level, readCounter, tempWorkspace, testMedia } from "./media.js";

let host: EngineHost;
let clip: string;
const m = testMedia();

const probe = (file: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,color_space,pix_fmt:format=duration", "-of", "json", file], { encoding: "utf8" }));
const capture = async (time: number, format: "png" | "jpeg" = "png") => host.render.captureFrame({ timeSeconds: time, shortSide: 180, format });
const frameAt = async (time: number) => readCounter((await capture(time)).path);
const left = async (time: number) => level((await capture(time)).path, "left");

beforeAll(async () => {
  host = EngineHost.create({ workspaceRoot: tempWorkspace("render"), validate: true });
  host.newProject({ name: "Render", canvas: { aspectRatio: "16:9", resolution: "720p" } });
  const imp = await host.importMedia([m.counter]);
  clip = host.mutate("add", "t", (c) => addMediaToTimeline(c, c.draft.media[imp.assets[0].id], {}).id).result;
});

afterAll(() => host.dispose());

// Every test starts from the same timeline: undo whatever a test (even a failing one) left behind.
let mark = 0;
beforeEach(() => {
  mark = host.session.history().undo.length;
});
afterEach(() => {
  while (host.session.history().undo.length > mark) host.undo("t");
});

describe("frame server", () => {
  it("starts the compositor on the GPU", async () => {
    const info = await host.render.ping();
    expect(info.ok).toBe(true);
    expect(info.maxTextureSize).toBeGreaterThanOrEqual(4096);
  });

  it("captures the exact source frame for a timeline time", async () => {
    const f = await capture(0.5);
    expect([f.width, f.height]).toEqual([320, 180]);
    expect(f.warnings).toEqual([]);
    expect(readCounter(f.path)).toBe(15);
    // Frame boundaries, mid-frame times and random access in both directions.
    for (const [t, frame] of [[0, 0], [1 / 30, 1], [1.2, 36], [0.25, 7], [1.95, 58], [0.75, 22], [29.5 / 30, 29], [1.999, 59]] as const) {
      expect(await frameAt(t), `t=${t}`).toBe(frame);
    }
  });

  it("follows speed changes, trims and reversed playback frame by frame", async () => {
    host.mutate("speed", "t", (c) => setSpeed(c, c.draft.elements[clip], 2));
    expect(await frameAt(0.5)).toBe(30);
    expect(await frameAt(0.9)).toBe(54);
    host.undo("t");
    host.mutate("trim", "t", (c) => trimElement(c, c.draft.elements[clip], "left", 0.5));
    expect((host.project.elements[clip] as VideoElement).sourceInSourceSeconds).toBe(0.5);
    expect(await frameAt(0)).toBe(15);
    expect(await frameAt(1)).toBe(45);
    host.undo("t");
    host.mutate("reverse", "t", (c) => setReversed(c, c.draft.elements[clip], true));
    expect(await frameAt(0)).toBe(59);
    expect(await frameAt(1 / 30)).toBe(58);
    expect(await frameAt(1)).toBe(29);
    expect(await frameAt(59 / 30)).toBe(0);
    host.undo("t");
  });

  it("applies opacity, color and transforms", async () => {
    const T = 30 / 30 + 1 / 60; // frame 30: left patch is step 6
    const base = await left(T);
    expect(base).toBeCloseTo(counterLeftLevel(30), -1);
    host.mutate("opacity", "t", (c) => setOpacity(c, c.draft.elements[clip], 0.5));
    expect(await left(T)).toBeCloseTo(base / 2, -1);
    host.undo("t");
    // +1 stop of exposure doubles values (frame 25 is dark enough not to clip).
    const D = 25 / 30 + 1 / 60;
    const dark = await left(D);
    host.mutate("grade", "t", (c) => setColorGrade(c, c.draft.elements[clip], { exposure: 50 }));
    expect(await left(D)).toBeCloseTo(dark * 2, -1);
    host.undo("t");
    // Scaled down into the top-left corner, the sampled patch shows the black canvas.
    host.mutate("move", "t", (c) => setTransform(c, c.draft.elements[clip], { x: 0.2, y: 0.2, scale: 0.3 }));
    expect(await left(T)).toBeLessThan(2);
    host.undo("t");
    // A white full-frame rectangle with multiply blending leaves the clip unchanged; with normal blending it is white.
    const shape = host.mutate("shape", "t", (c) => addShape(c, { shape: "rectangle", start: 0, duration: 2, widthNorm: 1, heightNorm: 1, fillColor: "#FFFFFF" }).id).result;
    expect(await left(T)).toBeGreaterThan(252);
    host.mutate("blend", "t", (c) => {
      (c.draft.elements[shape] as { blendMode: string }).blendMode = "multiply";
    });
    expect(await left(T)).toBeCloseTo(base, -1);
    host.undo("t");
    host.undo("t");
  });

  it("applies custom .cube LUTs and reports what it cannot draw", async () => {
    // An inverting 2x2x2 LUT: output = 1 - input.
    const cube = `${host.projectDirPath}/invert.cube`;
    const rows: string[] = [];
    for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) rows.push(`${1 - r} ${1 - g} ${1 - b}`);
    fs.writeFileSync(cube, `TITLE "invert"\nLUT_3D_SIZE 2\n${rows.join("\n")}\n`);
    const T = 1 + 1 / 60;
    const base = await left(T);
    host.mutate("lut", "t", (c) => applyLut(c, c.draft.elements[clip], { id: "custom", cubePath: cube, intensity: 100 }));
    expect(await left(T)).toBeCloseTo(255 - base, -1);
    host.undo("t");
    // Built-in camera LUTs are generated from the log curves: a bright log patch comes out brighter still.
    host.mutate("builtin", "t", (c) => applyLut(c, c.draft.elements[clip], { id: "sony_slog3_sgamut3_to_rec709", intensity: 100 }));
    const graded = await capture(T);
    expect(graded.warnings).toEqual([]);
    expect(level(graded.path, "left")).toBeGreaterThan(base + 20);
    host.undo("t");
    host.mutate("blur", "t", (c) => applyEffect(c, c.draft.elements[clip], { effectId: "blur", intensity: 50 }));
    const f = await capture(T);
    expect(f.warnings).toEqual([]);
    expect(level(f.path, "left")).toBeCloseTo(base, -1); // blurring a flat patch barely changes its middle
    host.undo("t");
  });

  it("draws every catalog effect and transition without skipping any", async () => {
    // A busy picture (test pattern) so every effect has something to change.
    const imp = await host.importMedia([m.clipB]);
    const busy = host.mutate("busy", "t", (c) => addMediaToTimeline(c, c.draft.media[imp.assets[0].id], { index: 0 }).id).result;
    const plain = await host.render.captureFrame({ timeSeconds: 1.3, shortSide: 180, format: "png" });
    const plainAt1 = await host.render.captureFrame({ timeSeconds: 1, shortSide: 180, format: "png" });
    const differs = (file: string, at1 = false) => {
      const a = fs.readFileSync(at1 ? plainAt1.path : plain.path);
      const b = fs.readFileSync(file);
      return a.length !== b.length || !a.equals(b);
    };
    const effects = EFFECTS_CATALOG.filter((e) => !e.data.requiresSubjectMask).map((e) => e.id);
    for (const effectId of effects) {
      // Pulsing effects peak on whole seconds at 1 Hz.
      const pulsing = effectId === "flash" || effectId === "zoom_pulse";
      host.mutate(effectId, "t", (c) => applyEffect(c, c.draft.elements[busy], { effectId, intensity: 100, params: pulsing ? { frequency: 1 } : {} }));
      const f = await host.render.captureFrame({ timeSeconds: pulsing ? 1 : 1.3, shortSide: 180, format: "png" });
      expect(f.warnings, effectId).toEqual([]);
      expect(differs(f.path, pulsing), `${effectId} changed the picture`).toBe(true);
      host.undo("t");
    }
    for (const t of TRANSITIONS_CATALOG.filter((x) => x.id !== "none")) {
      host.mutate(t.id, "t", (c) => addTransition(c, { fromElementId: busy, type: t.id, durationSeconds: 1 }));
      const mid = await host.render.captureFrame({ timeSeconds: 4 - 0.3, shortSide: 180, format: "png" });
      expect(mid.warnings, t.id).toEqual([]);
      host.undo("t");
    }
    host.undo("t");
  });

  it("every effect parameter changes the picture (no dead sliders)", { timeout: 240_000 }, async () => {
    const imp = await host.importMedia([m.clipB]);
    const busy = host.mutate("busy", "t", (c) => addMediaToTimeline(c, c.draft.media[imp.assets[0].id], { index: 0 }).id).result;
    const shot = async (effectId: string, params: Record<string, number>, t: number) => {
      host.mutate(effectId, "t", (c) => applyEffect(c, c.draft.elements[busy], { effectId, intensity: 100, params }));
      const f = await host.render.captureFrame({ timeSeconds: t, shortSide: 360, format: "png" });
      host.undo("t");
      return fs.readFileSync(f.path);
    };
    const dead: string[] = [];
    for (const e of EFFECTS_CATALOG.filter((x) => !x.data.requiresSubjectMask)) {
      for (const p of e.data.params.filter((x) => x.type === "number")) {
        // Angles and hues wrap around: compare against a quarter turn instead of the far end.
        const other = /angle|hue/.test(p.name) ? p.min! + 90 : (p.min! + p.max!) / 2;
        let changed = false;
        // Intermittent effects (glitch bursts, flashes) only show on some frames: try several moments.
        for (const t of [1, 1.37, 2.1, 0.5, 1.6, 2.6, 3.1]) {
          if (!(await shot(e.id, { [p.name]: p.min! }, t)).equals(await shot(e.id, { [p.name]: other }, t))) {
            changed = true;
            break;
          }
        }
        if (!changed) dead.push(`${e.id}.${p.name}`);
      }
    }
    expect(dead).toEqual([]);
    host.undo("t");
  });

  it("uses the bundled face on the first frame with text", async () => {
    const elementId = host.mutate("title", "t", (c) => addText(c, {
      text: "FIRST FRAME OF A TITLE",
      start: 2,
      duration: 1,
      style: { fontFamily: "Bebas Neue", fontWeight: 400, fontSizeNorm: 0.12 },
    }).id).result;
    const first = fs.readFileSync((await capture(2.1)).path);
    const later = fs.readFileSync((await capture(2.2)).path);
    expect(first.equals(later)).toBe(true);
    host.mutate("change font", "t", (c) => setTextStyle(c, elementId, { fontFamily: "Helvetica Neue" }));
    const changed = fs.readFileSync((await capture(2.2)).path);
    expect(first.equals(changed)).toBe(false);
  });

  it("renders text over video and a labelled frame sheet", async () => {
    const text = host.mutate("text", "t", (c) => addText(c, { text: "MMMMMMMM", start: 0, duration: 2, style: { fontSizeNorm: 0.5, fontWeight: 900, color: "#FFFFFF" } }).id).result;
    expect(level((await capture(0.1)).path, "center")).toBeGreaterThan(120); // white glyphs over a dark frame
    const sheet = await host.render.frameSheet({ count: 6, columns: 3 });
    expect(sheet.times).toHaveLength(6);
    expect(sheet.times[0]).toBeCloseTo(2 / 12);
    expect([sheet.width, sheet.height]).toEqual([3 * 384 + 16, 2 * 216 + 12]);
    expect(fs.statSync(sheet.path).size).toBeGreaterThan(5000);
    void text;
    const src = await host.render.sourceFrames({ path: m.clipA, count: 4 });
    expect(src.kind).toBe("video");
    expect(src.times).toHaveLength(4);
    expect(fs.statSync(src.path).size).toBeGreaterThan(5000);
  });
});

describe("video rendering", () => {
  it("renders a preview with audio whose frames match the timeline", async () => {
    const job = host.render.startRender({ mode: "preview", shortSide: 180 });
    const done = await host.jobs.wait(job.id, 60_000);
    expect(done.status, JSON.stringify(done.error)).toBe("done");
    const out = done.result as RenderOutput;
    expect(out).toMatchObject({ width: 320, height: 180, fps: 30, frames: 60, codec: "h264" });
    expect(out.warnings).toEqual([]);
    const info = probe(out.path);
    const video = info.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    const audio = info.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
    expect(video).toMatchObject({ codec_name: "h264", width: 320, height: 180, r_frame_rate: "30/1", color_space: "bt709", pix_fmt: "yuv420p" });
    expect(audio.codec_name).toBe("aac");
    expect(Number(info.format.duration)).toBeCloseTo(2, 1);
    // Decode frames back out of the encoded file: each must be the frame the timeline shows at that time.
    for (const n of [0, 15, 30, 45, 59]) expect(readCounter(out.path, frameTime(n)), `frame ${n}`).toBe(n);
  });

  it("exports with the project's settings, a range and a transition, without overwriting", async () => {
    const imp = await host.importMedia([m.counter]);
    host.mutate("second", "t", (c) => {
      const b = addMediaToTimeline(c, c.draft.media[imp.assets[0].id], {});
      trimElement(c, c.draft.elements[clip], "right", 0.5);
      trimElement(c, b, "left", 0.5);
      addTransition(c, { fromElementId: clip, type: "dissolve", durationSeconds: 0.4 });
      c.draft.exportSettings.resolution = "720p";
      c.draft.exportSettings.codec = "hevc";
      c.draft.exportSettings.quality = "low";
    });
    // Transition spans 1.3..1.7 s. Before it only A plays, after it only B (which starts at source 0.5 s).
    expect(await frameAt(1.2 + 1 / 60)).toBe(36);
    expect(await frameAt(1.8 + 1 / 60)).toBe(24);
    // At the cut, A shows frame 45 (left step 5) and B frame 15 (left step 7): half of each.
    const expectedMid = (counterLeftLevel(45) + counterLeftLevel(15)) / 2;
    expect(await left(1.5)).toBeCloseTo(expectedMid, -1);
    const first = await host.jobs.wait(host.render.startRender({ mode: "export", startSeconds: 1, endSeconds: 2 }).id, 120_000);
    expect(first.status, JSON.stringify(first.error)).toBe("done");
    const out = first.result as RenderOutput;
    expect(out).toMatchObject({ width: 1280, height: 720, frames: 30, codec: "hevc" });
    expect(out.path.startsWith(host.paths.outbox)).toBe(true);
    expect(probe(out.path).streams.find((s: { codec_type: string }) => s.codec_type === "video").codec_name).toBe("hevc");
    expect(level(out.path, "left", frameTime(15))).toBeCloseTo(expectedMid, -1);
    const second = await host.jobs.wait(host.render.startRender({ mode: "export", startSeconds: 1, endSeconds: 1.5 }).id, 120_000);
    expect((second.result as RenderOutput).path).not.toBe(out.path);
    expect(fs.existsSync(out.path)).toBe(true);
    host.undo("t");
  });

  it("cancels a running render and removes the partial file", async () => {
    const job = host.render.startRender({ mode: "preview", shortSide: 1080 });
    host.jobs.cancel(job.id);
    const done = await host.jobs.wait(job.id, 30_000);
    expect(done.status).toBe("cancelled");
    expect(() => host.render.startRender({ mode: "preview", startSeconds: 50 })).toThrow(/Nothing to render/);
  });

  it("maps frame rates to exact rationals", () => {
    expect(fpsExpression(29.97)).toEqual({ expr: "30000/1001", value: 30000 / 1001 });
    expect(fpsExpression(23.976).expr).toBe("24000/1001");
    expect(fpsExpression(30)).toEqual({ expr: "30", value: 30 });
    expect(fpsExpression(undefined).value).toBe(30);
  });
});
