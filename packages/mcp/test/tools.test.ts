import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EngineHost, visionHelperPath } from "@openedits/engine";
import { validateProject } from "@openedits/core";
import { allTools, createMcpServer, unwrap } from "../src/index.js";
import { canSpeak, haveWhisper, speechClip, tempWorkspace, testMedia } from "../../engine/test/media.js";
import { FakeAi } from "../../engine/test/fakeAi.js";

/** Canned model answers so describeClip, AI retakes and prompt tracking run without the real API. */
const fakeAi = new FakeAi((req) => {
  if (req.system.includes("assistant editor"))
    return { summary: "An orange square slides across a blue screen.", setting: "graphic", peopleCount: 0, shotType: "other", topics: ["motion"], vibes: ["simple"], suggestedCaption: "Slide", hookIdeas: ["Watch it move"], aestheticScore: 5, aestheticNotes: "flat" };
  if (req.system.includes("spoken-word")) {
    const transcript = (req.content[0] as { text: string }).text;
    const ids = [...transcript.matchAll(/#(\d+) (\S+)/g)];
    const second = ids.filter((x) => /^second/i.test(x[2])).map((x) => Number(x[1]));
    const silences = ids.find((x) => /^silences/i.test(x[2]));
    return { retakes: second.length > 1 && silences ? [{ fromId: second[0], toId: Number(silences[1]), reason: "repeated take" }] : [] };
  }
  // At the first frame the square is at x 80..200, y 120..240 of 640x360.
  return { found: true, label: "orange square", box: { x: 0.125, y: 0.333, w: 0.1875, h: 0.333 } };
});

/** Transcription needs whisper.cpp and its model; subject detection needs the Apple Vision helper (macOS). */
const haveVision = process.platform === "darwin" && (() => { try { return !!visionHelperPath(); } catch { return false; } })();
const fullStack = haveWhisper && canSpeak && haveVision;
const NEEDS_FULL_STACK = ["transcribeClip", "get_transcript", "edit", "auto_edit", "generateCaptions", "detectSubjects", "trackObject", "addStickerFromCutout", "applySubjectEffect", "autoReframe", "describeClip"];

let host: EngineHost;
let client: Client;
const called = new Set<string>();

type Json = Record<string, any>;

async function call(name: string, args: Json = {}): Promise<Json> {
  called.add(name);
  const waitSeconds = args.waitSeconds ?? args.wait_seconds;
  const options = typeof waitSeconds === "number" ? { timeout: (waitSeconds + 30) * 1000 } : undefined;
  const res = unwrap(await client.callTool({ name, arguments: args }, undefined, options));
  if (!res.ok) throw new Error(`${name} failed: ${JSON.stringify(res.value)}`);
  if (host.isOpen) expect(validateProject(host.project)).toEqual([]);
  return res.value as Json;
}

async function callError(name: string, args: Json = {}): Promise<Json> {
  called.add(name);
  const res = unwrap(await client.callTool({ name, arguments: args }));
  expect(res.ok).toBe(false);
  return res.value as Json;
}

beforeAll(async () => {
  host = EngineHost.create({ workspaceRoot: tempWorkspace("mcp"), validate: true, ai: fakeAi });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(host).connect(b);
  client = new Client({ name: "vitest", version: "1" });
  await client.connect(a);
});

afterAll(async () => {
  await client.close();
  host.dispose();
});

describe("MCP tool surface", () => {
  it("lists every registered tool with schemas and annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(allTools().map((t) => t.name).sort());
    const del = tools.find((t) => t.name === "delete")!;
    expect(del.annotations?.destructiveHint).toBe(true);
    const caps = tools.find((t) => t.name === "getCapabilities")!;
    expect(caps.annotations?.readOnlyHint).toBe(true);
    const split = tools.find((t) => t.name === "splitAt")!;
    expect((split.inputSchema.properties as Json).times).toBeDefined();
  });

  it("returns typed errors", async () => {
    const e1 = await callError("clips");
    expect(e1.error.code).toBe("NO_PROJECT_OPEN");
    const e2 = await callError("openProject", { projectId: "prj_missing" });
    expect(e2.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("inspects a saved project without changing the active edit or recent projects", async () => {
    const { clipA, music } = testMedia();
    const { projectId: savedId, mediaIds: [clipId] } = await call("create_project", { files: [clipA], brief: "Saved brief" });
    const { addedIds: [musicId] } = await call("importToMediaPanel", { paths: [music] });
    host.store.saveTranscript({ mediaId: clipId, language: "en", model: "test", createdAt: 1, durationSourceSeconds: 6, words: [] });
    await call("saveRevision", { label: "Initial cut" });
    await call("setBrief", { brief: "Discarded brief" });
    await call("undo");
    const savedVersion = host.session.version;

    const { projectId: activeId } = await call("newProject");
    const { elementId } = await call("addText", { text: "Active edit", start: 0, duration: 2 });
    await call("setSelection", { elementIds: [elementId] });
    await call("setPlayhead", { seconds: 1 });
    const before = host.appState;
    const openedAt = host.requireProjectRow(savedId).openedAt;
    const sessionFile = fs.readFileSync(host.paths.sessionFile, "utf8");

    expect(await call("get_project", { projectId: savedId })).toMatchObject({
      project: { id: savedId, version: savedVersion, canUndo: true, canRedo: true },
      brief: "Saved brief",
      clips: [{ mediaId: clipId }],
      revisions: [{ label: "Initial cut" }],
      analysis: { transcripts: { available: expect.any(Boolean), transcribedMediaIds: [clipId], missingMediaIds: [musicId] } },
    });
    expect(await call("get_project")).toMatchObject({ project: { id: activeId } });
    expect(host.appState).toEqual(before);
    expect(host.requireProjectRow(savedId).openedAt).toBe(openedAt);
    expect(fs.readFileSync(host.paths.sessionFile, "utf8")).toBe(sessionFile);

    await call("closeProject");
    expect(await call("get_project", { projectId: savedId })).toMatchObject({ project: { id: savedId } });
    expect(host.isOpen).toBe(false);
    expect((await callError("get_project")).error.code).toBe("NO_PROJECT_OPEN");
    expect((await callError("get_project", { projectId: "prj_missing" })).error.code).toBe("PROJECT_NOT_FOUND");
    await call("deleteProject", { projectId: savedId });
    await call("deleteProject", { projectId: activeId });
  });

  it("blocks final export with a missing source and relinks the original without changing clips", async () => {
    const source = path.join(host.paths.inbox, "missing-move.mp4");
    const moved = path.join(host.paths.inbox, "found-move.mp4");
    fs.copyFileSync(testMedia().counter, source);
    const { projectId, mediaIds: [mediaId] } = await call("create_project", { files: [source] });
    const elementIds = [...host.project.tracks[0].elementIds];
    try {
      fs.renameSync(source, moved);
      expect((await call("checkExportMedia")).missing).toEqual([{ mediaId, name: "missing-move.mp4", path: source }]);
      expect((await callError("export", { preset: "fast-720p" })).error.code).toBe("FILE_NOT_FOUND");
      expect(host.jobs.latest("export", projectId)).toBeUndefined();
      expect((await callError("relinkMedia", { mediaId, path: testMedia().clipB })).error.code).toBe("UNSUPPORTED_MEDIA");
      await call("relinkMedia", { mediaId, path: moved, projectId, expectedVersion: host.session.version });
      expect((await call("checkExportMedia")).missing).toEqual([]);
      expect(host.project.tracks[0].elementIds).toEqual(elementIds);
      expect(host.project.media[mediaId].path).toBe(moved);
    } finally {
      await call("deleteProject", { projectId });
      fs.rmSync(source, { force: true });
      fs.rmSync(moved, { force: true });
    }
  });

  it("round-trips subtitles, restores a collected project and reuses a creator template", async () => {
    expect((await call("projectTemplates")).templates.map((item: Json) => item.id)).toContain("product-review");
    const { projectId } = await call("newProjectFromTemplate", { templateId: "product-review" });
    const source = path.join(host.paths.inbox, "review-capture.mp4");
    const subtitle = path.join(host.paths.inbox, "review-caption.srt");
    const projects = [projectId];
    fs.copyFileSync(testMedia().counter, source);
    fs.writeFileSync(subtitle, "\uFEFF1\r\n00:00:00,200 --> 00:00:01,100\r\nA useful review.\r\n");
    try {
      const { addedIds: [mediaId] } = await call("importToMediaPanel", { paths: [source] });
      await call("addMedia", { mediaId });
      const { elementIds } = await call("importSubtitles", { path: subtitle });
      expect(elementIds).toHaveLength(1);
      const exported = await call("exportSubtitles");
      expect(fs.readFileSync(exported.path, "utf8")).toContain("00:00:00,200 --> 00:00:01,100\nA useful review.");
      const model = await call("captionSetup");
      expect(model).toMatchObject({ runtime: expect.any(Boolean), model: expect.any(Boolean) });
      const { template } = await call("saveProjectTemplate", { name: "Recurring reviews" });
      const backup = await call("backupProject", { destination: host.paths.root, collectMedia: true });
      const deleted = await call("deleteProject", { projectId });
      const { projects: trash } = await call("projectTrash");
      const entry = trash.find((item: Json) => item.entry === path.basename(deleted.trashedTo));
      expect(entry?.name).toBe("Product review");
      await call("restoreProject", { entry: entry.entry });
      await call("openProject", { projectId });
      expect(host.project.media[mediaId].path).toBe(source);
      fs.rmSync(source);
      const restored = await call("openProjectBackup", { path: backup.path });
      projects.push(restored.projectId);
      expect(restored.projectId).not.toBe(projectId);
      expect((await call("checkExportMedia")).missing).toEqual([]);
      expect(host.project.elements[elementIds[0]].type).toBe("caption");
      const reuse = await call("newProjectFromTemplate", { templateId: template.id });
      projects.push(reuse.projectId);
      expect(host.project.tracks[0].elementIds).toHaveLength(0);
      expect(Object.values(host.project.elements).map((element) => element.type)).toEqual(["text"]);
      expect(host.project.preferredCaptionStyle).toBe("clean");
    } finally {
      for (const id of projects) if (host.library.get(id)) await call("deleteProject", { projectId: id });
      fs.rmSync(source, { force: true });
      fs.rmSync(subtitle, { force: true });
    }
  });

  it("only applies the reviewed rough-cut suggestions and can undo them together", async () => {
    const { projectId, mediaIds: [mediaId] } = await call("create_project", { files: [testMedia().counter] });
    try {
      host.store.saveTranscript({
        mediaId, language: "en", model: "test", createdAt: 1, durationSourceSeconds: 2,
        words: [
          { id: 1, text: "Uh", startSourceSeconds: 0.45, endSourceSeconds: 0.55, confidence: 1, isFiller: true },
          { id: 2, text: "Hello.", startSourceSeconds: 1.0, endSourceSeconds: 1.35, confidence: 1, isFiller: false },
        ],
      });
      const before = host.project;
      const plan = await call("planRoughCut");
      expect(plan.useWords).toBe(true);
      expect(host.project).toBe(before);
      expect(plan.suggestions.some((item: Json) => item.reasons.includes("Filler"))).toBe(true);
      const range = plan.suggestions[0];
      const result = await call("applyRoughCut", { projectId, version: plan.version, ranges: [{ start: range.start, end: range.end }] });
      expect(result.removedSeconds).toBeCloseTo(range.end - range.start, 5);
      expect((await callError("applyRoughCut", { projectId, version: plan.version, ranges: [range] })).error.code).toBe("VERSION_CONFLICT");
      await call("undo");
      expect(host.project).toEqual(before);
    } finally {
      await call("deleteProject", { projectId });
    }
  });

  it("composes caption edits in scope and replaces or resets presets in one undo step", async () => {
    const { projectId } = await call("newProject", { name: "Styling" });
    const { elementId: title } = await call("addText", { text: "Title", start: 0, duration: 2, presetId: "label_black" });
    const { elementIds: [first, second] } = await call("addCaptions", {
      styleId: "clean",
      segments: [
        { start: 0, end: 1, words: [{ text: "First", start: 0, end: 1 }] },
        { start: 1, end: 2, words: [{ text: "Second", start: 1, end: 2 }] },
      ],
    });
    await call("setTextStyle", { elementIds: [first], fontSizeNorm: 0.08, color: "#ABCDEF" });
    const before = host.session.version;
    await call("setTextStyle", { elementIds: [first, second], fontFamily: "Bebas Neue", fontWeight: 400 });
    expect(host.session.version).toBe(before + 1);
    expect(host.project.elements[first]).toMatchObject({ styleOverrides: { fontFamily: "Bebas Neue", fontSizeNorm: 0.08, color: "#ABCDEF" } });
    expect(host.project.elements[second]).toMatchObject({ styleOverrides: { fontFamily: "Bebas Neue", fontWeight: 400 } });
    await call("undo");
    expect(host.project.elements[first]).toMatchObject({ styleOverrides: { fontSizeNorm: 0.08, color: "#ABCDEF" } });
    expect(host.project.elements[second]).toMatchObject({ styleOverrides: {} });

    await call("setCaptionStyle", { elementIds: [first], styleId: "bold", usePresetHighlight: true });
    expect(host.project.elements[first]).toMatchObject({ styleId: "bold", styleOverrides: {}, highlightColor: "#FFE14D" });
    expect(host.project.elements[second]).toMatchObject({ styleId: "clean" });
    await call("setTextStyle", { elementIds: [first], color: "#ABCDEF" });
    await call("setCaptionHighlightColor", { elementIds: [first], color: "#123456" });
    await call("setTextStyle", { elementIds: [first], reset: true });
    expect(host.project.elements[first]).toMatchObject({ styleId: "bold", styleOverrides: {}, highlightColor: "#FFE14D" });

    await call("applyTextPreset", { elementId: title, presetId: "classic", replaceStyle: true });
    expect((host.project.elements[title] as { style: Record<string, unknown> }).style).not.toHaveProperty("backgroundColor");
    await call("setTextStyle", { elementIds: [title], fontFamily: "Bebas Neue" });
    await call("setTextStyle", { elementIds: [title], reset: true });
    expect(host.project.elements[title]).toMatchObject({ presetId: "classic", style: { fontFamily: "Helvetica Neue" } });
    await call("deleteProject", { projectId });
  });

  it("drives every tool through a full editing session", { timeout: 300_000 }, async () => {
    const m = testMedia();
    fs.copyFileSync(m.clipA, path.join(host.paths.inbox, "talk.mp4"));

    // Discovery, catalog, style guide, inbox.
    const caps = await call("getCapabilities");
    expect(caps.toolCount).toBe(allTools().length);
    expect(caps.planned.every((p: Json) => p.phase >= 4)).toBe(true);
    expect(caps.rendering.effects).toContain("blur");
    await call("appState");
    expect((await call("listCatalogKinds")).kinds.length).toBeGreaterThan(10);
    expect((await call("listCatalog", { kind: "captionStyles", query: "box" })).total).toBe(4);
    expect((await call("getCatalogItem", { kind: "luts", id: "apple_log_to_rec709" })).data.vendor).toBe("Apple");
    expect((await call("get_style_guide")).markdown).toMatch(/Style Guide/);
    await call("save_style_guide", { markdown: "# Style\n- Captions bold\n" });
    expect((await call("list_inbox", { probe: true })).files[0].probe.kind).toBe("video");

    // Projects.
    const created = await call("create_project", { name: "Talk", files: ["talk.mp4"], brief: "A quick tip" });
    const p1 = created.projectId;
    const second = await call("newProject", { name: "Scratch", canvas: { aspectRatio: "1:1" } });
    await call("renameProject", { projectId: second.projectId, name: "Scratch 2" });
    expect((await call("togglePin", { projectId: second.projectId })).pinned).toBe(true);
    expect((await call("toggleFavorite", { projectId: second.projectId })).favorite).toBe(true);
    expect((await call("projects", { filter: "pinned" })).projects.length).toBe(1);
    await call("openProject", { projectId: p1 });
    await call("deleteProject", { projectId: second.projectId });
    expect((await call("projects")).projects.length).toBe(1);
    const overview = await call("get_project");
    expect(overview.brief).toBe("A quick tip");
    expect(overview.clips.length).toBe(1);
    await call("setBrief", { brief: "A quick tip for beginners" });
    const clipA = overview.clips[0].id as string;

    // Media panel and placement.
    const imported = await call("importToMediaPanel", { paths: [m.clipB, m.music, m.photo] });
    const [medB, medMusic, medPhoto] = imported.addedIds as string[];
    const thumbnail = await call("mediaThumbnail", { mediaId: medB, sourceSeconds: 0.5 });
    expect(fs.statSync(thumbnail.path).size).toBeGreaterThan(0);
    expect((await call("mediaThumbnail", { mediaId: medB, sourceSeconds: 0.6 })).path).toBe(thumbnail.path);
    const folder = await call("createMediaFolder", { name: "B-roll" });
    expect(folder.folder.name).toBe("B-roll");
    expect((await call("mediaPanel", { filter: "video", unreferencedOnly: true })).total).toBe(1);
    const placed = await call("addMediaPanelItemsToTimeline", { mediaIds: [medB] });
    const proxyJob = await call("generateEditingProxies", { mediaIds: [medB] });
    const proxyResult = await call("editingProxyStatus", { jobId: proxyJob.jobId, waitSeconds: 20 });
    expect(proxyResult.status).toBe("done");
    expect((await call("cancelEditingProxies", { jobId: proxyJob.jobId })).status).toBe("done");
    const editingCache = await call("editingCacheStatus");
    expect(editingCache.proxyBytes).toBeGreaterThan(0);
    expect(editingCache.proxies[medB]).toMatchObject({ width: 960, height: 540 });
    expect(fs.existsSync(editingCache.proxies[medB].path)).toBe(true);
    const clearedCache = await call("clearEditingCache", { scope: "proxies" });
    expect(clearedCache.removedBytes).toBe(editingCache.proxyBytes);
    expect(fs.existsSync(editingCache.proxies[medB].path)).toBe(false);
    expect(fs.existsSync(m.clipB)).toBe(true);
    const clipB = placed.elementIds[0];
    const music = (await call("addMedia", { mediaId: medMusic, role: "music", start: 0 })).elementId;
    const overlay = (await call("addOverlay", { mediaId: medPhoto, start: 1, durationSeconds: 2 })).elementId;
    const adj = (await call("addAdjustmentLayer", { start: 0, duration: 2, filterId: "warm", grade: { contrast: 10 } })).elementId;
    const scrim = (await call("addShape", { shape: "scrim", start: 0, duration: 3 })).elementId;
    const text = (await call("addText", { text: "Three tips", start: 0, duration: 2, presetId: "headline" })).elementId;
    const sticker = (await call("addSticker", { stickerId: "star", start: 1, duration: 1 })).elementId;

    // Inspection.
    expect((await call("clips")).items.map((c: Json) => c.id)).toEqual([clipA, clipB]);
    expect((await call("elements", { type: "text" })).items[0].text).toBe("Three tips");
    expect((await call("tracks")).tracks[0].kind).toBe("main");
    expect((await call("state", { omit: ["media"] })).project.media).toBeUndefined();
    expect((await call("getCanvas")).pixelSize).toEqual({ width: 1080, height: 1920 });
    expect((await call("getElement", { elementId: clipA, time: 1 })).evaluated.x).toBe(0.5);
    await call("setSelection", { elementIds: [clipA] });
    await call("setPlayhead", { seconds: 1 });
    expect((await call("tools")).panels.some((p: Json) => p.id === "speed")).toBe(true);
    expect((await call("selectTool", { toolId: "transform" })).activeTool).toBe("transform");
    expect((await call("rippleState")).magnetEnabled).toBe(true);
    await call("setRippleTiers", { tier2RippleEnabled: true });
    await call("setCanvas", { aspectRatio: "4:5" });
    const musicTrack = host.project.elements[music].trackId;
    await call("setTrackFlags", { trackId: musicTrack, muted: true });

    // Cutting and trimming.
    const right = (await call("split", { elementId: clipA, time: 3 })).rightId;
    const splits = await call("splitAt", { times: [0.5, 1.0, 1.5], elementIds: [clipA] });
    expect(splits.splits).toBe(3);
    await call("trim", { elementId: right, side: "right", deltaSeconds: 0.5 });
    const rEl = host.project.elements[right];
    await call("trimStart", { elementId: right, time: rEl.start + 0.2 });
    await call("trimEnd", { elementId: right, time: host.project.elements[right].start + 1.8 });
    expect((await call("slipClip", { elementId: right, deltaSourceSeconds: 0.1 })).appliedDeltaSourceSeconds).toBeCloseTo(0.1);
    const tr = await call("addTransition", { fromElementId: clipA, type: "dissolve", durationSeconds: 0.2 });
    expect(tr.transition.durationSeconds).toBeCloseTo(0.2);

    // Arrangement.
    const moved = await call("move", { elementId: text, start: 3, snap: false });
    expect(moved.start).toBe(3);
    await call("moveToLayer", { elementId: sticker, direction: "up" });
    await call("reorderClip", { elementId: clipB, toIndex: 0 });
    await call("convertToOverlay", { elementId: clipB });
    await call("convertToMain", { elementId: clipB, index: 0 });
    const dup = (await call("duplicate", { elementId: overlay })).elementId;
    const audio = (await call("extractAudio", { elementId: clipB })).audioElementId;
    expect(host.project.elements[audio].type).toBe("audio");
    await call("replaceElementMedia", { elementId: dup, mediaId: medB });
    expect(host.project.elements[dup].type).toBe("video");

    // Transform, keyframes, masks, speed.
    expect((await call("getTransform", { elementId: overlay })).transform.fit).toBe("contain");
    await call("setTransform", { elementId: overlay, x: 0.3, y: 0.3, scale: 0.5, rotationDegrees: 10 });
    await call("setTransforms", { items: [{ elementId: overlay, x: 0.4 }, { elementId: sticker, y: 0.2 }] });
    await call("setTransformKeyframe", { elementId: overlay, property: "scale", offsetSeconds: 0, value: 0.5 });
    await call("setTransformKeyframes", {
      items: [
        { elementId: overlay, property: "scale", offsetSeconds: 1.5, value: 0.8, easing: { type: "easeOut" } },
        { elementId: overlay, property: "opacity", offsetSeconds: 0, value: 0 },
        { elementId: overlay, property: "opacity", offsetSeconds: 0.5, value: 1 },
      ],
    });
    await call("setKeyframeEasing", { elementId: overlay, property: "scale", offsetSeconds: 0, easing: { type: "cubicBezier", bezier: [0.2, 0, 0.2, 1] } });
    const tf = await call("getTransform", { elementId: overlay, time: host.project.elements[overlay].start + 0.75 });
    expect(tf.evaluated.scale).toBeGreaterThan(0.5);
    await call("removeTransformKeyframe", { elementId: overlay, property: "opacity", all: true });
    await call("setCrop", { elementId: dup, left: 0.1, top: 0, right: 0.1, bottom: 0 });
    await call("clearCrop", { elementId: dup });
    await call("setFlip", { elementId: dup, horizontal: true });
    await call("setOpacity", { elementId: dup, opacity: 0.8 });
    await call("setBlendMode", { elementId: dup, blendMode: "screen" });
    expect(host.project.elements[dup]).toMatchObject({ blendMode: "screen" });
    expect((await call("setMask", { elementId: dup, type: "ellipse", feather: 0.2 })).mask.type).toBe("ellipse");
    const ss = await call("splitScreen", { elementIds: [clipA], background: "solid", backgroundColor: "#101010" });
    expect(ss.panelIds.length).toBe(2);
    await call("setSpeed", { elementId: clipB, rate: 2 });
    await call("setSpeedCurve", { elementId: clipB, preset: "HERO" });
    await call("setReversed", { elementId: clipB, reversed: true });

    // Color.
    expect((await call("getColor", { elementId: clipB })).color.grade.contrast).toBe(0);
    expect((await call("setColorGrade", { elementId: clipB, contrast: 20, presetId: "brighten" })).grade.exposure).toBe(15);
    await call("setColorWheel", { elementId: clipB, wheel: "shadows", hue: 200, intensity: 30 });
    await call("setHSL", { elementId: clipB, band: "orange", saturation: -20 });
    await call("setCurve", { elementId: clipB, channel: "luma", points: [{ x: 0, y: 0.05 }, { x: 0.5, y: 0.55 }, { x: 1, y: 1 }] });
    await call("applyFilter", { elementId: adj, filterId: "moody", intensity: 50 });
    await call("applyLUT", { elementId: clipB, lutId: "sony_slog3_sgamut3cine_to_rec709" });
    expect((await call("applyEffect", { elementId: clipB, effectId: "vignette", intensity: 40 })).effect.effectId).toBe("vignette");

    // Text.
    await call("editText", { elementId: text, text: "Three quick tips" });
    await call("setTextFont", { elementId: text, fontFamily: "Futura", fontWeight: 800 });
    await call("setTextStyle", { elementId: text, color: "#FFE14D", fontSizeNorm: 0.08 });
    await call("setTextPosition", { elementId: text, preset: "top" });
    await call("setEmphasis", { elementId: text, ranges: [{ startChar: 0, endChar: 5, color: "#FF3B5C" }] });
    await call("applyTextPreset", { elementId: text, presetId: "label_black" });
    await call("setTextAnimation", { elementId: text, in: { id: "pop_in" }, out: { id: "fade_out" } });

    // Captions.
    const caps1 = await call("addCaptions", {
      segments: [
        { start: 0.2, end: 1.4, words: [{ text: "hey", start: 0.2, end: 0.5 }, { text: "there", start: 0.6, end: 1.0 }, { text: "friends", start: 1.0, end: 1.4 }] },
        { start: 1.5, end: 2.2, words: [{ text: "listen", start: 1.5, end: 2.2 }] },
      ],
    });
    const [c1, c2] = caps1.elementIds;
    expect((await call("captions")).items.length).toBe(2);
    await call("editCaption", { elementId: c1, wordId: "w2", text: "there," });
    const c3 = (await call("splitCaption", { elementId: c1, beforeWordId: "w3" })).newElementId;
    await call("mergeCaptions", { elementIds: [c1, c3] });
    await call("setCaptionStyle", { styleId: "word_highlight_box_2" });
    await call("setCaptionHighlights", { elementId: c2, wordIds: ["w1"] });
    await call("setCaptionHighlightColor", { color: "#4BFF7A" });
    expect((await call("captions")).items[0].styleId).toBe("word_highlight_box_2");

    // Teleprompter.
    expect((await call("openTeleprompter", { fontSize: 64 })).teleprompterOpen).toBe(true);
    expect((await call("setTeleprompterText", { text: "Hook. Tip one. Tip two." })).words).toBe(5);

    // Audio.
    expect((await call("setSound", { elementId: music, volumeDb: -6 })).volume).toBeCloseTo(0.501, 3);
    await call("setVoiceEnhance", { elementId: audio, reduceNoise: 60, enhanceVoice: 40 });
    await call("setDucking", { elementId: music, amountDb: -15 });
    await call("setFade", { elementId: music, fadeInSeconds: 0.5, fadeOutSeconds: 1 });
    const marker = (await call("addBeatMarker", { time: 1.25 })).marker;
    expect((await call("beatMarkers")).markers.length).toBe(1);
    await call("removeBeatMarker", { markerId: marker.id });
    await call("setBeatDensity", { density: "medium" });
    expect((await call("setExportSettings", { codec: "hevc", quality: "max" })).exportSettings.codec).toBe("hevc");

    // Audio analysis (Phase 3).
    const lufs = await call("loudness", { elementId: music });
    expect(lufs.integratedLufs).toBeLessThan(-5);
    expect(lufs.truePeakDbtp).toBeLessThan(0);
    const levels = await call("audioLevels", { mediaId: medMusic, maxPoints: 50 });
    expect(levels.envelope.rmsDb.length).toBeLessThanOrEqual(50);
    expect(levels.timeBase).toBe("source");
    expect((await call("findPauses", { mediaId: medMusic })).count).toBe(0);
    const mixPauses = await call("findPauses", { minSilenceSeconds: 0.2 });
    expect(mixPauses.timeBase).toBe("timeline");
    const qp = await call("quietPoint", { time: 1, windowSeconds: 0.2 });
    expect(Math.abs(qp.time - 1)).toBeLessThanOrEqual(0.2 + 1e-6);
    const onsets = await call("audioOnsets", { mediaId: medMusic });
    expect(onsets.bpm).toBeNull();
    const beats = await call("audioOnsets", { elementId: music, addBeatMarkers: true });
    expect(beats.warnings ?? []).toEqual(expect.any(Array));
    expect(Array.isArray((await call("audioChords", { mediaId: medMusic })).chords)).toBe(true);
    const spectrum = await call("audioSpectrum", { mediaId: medMusic });
    expect(spectrum.hums.map((h: Json) => Math.round(h.frequencyHz))).toContain(220); // the test tone is a steady 220 Hz sine
    const processed = await call("processAudio", { elementId: music, normalizeLufs: -16, highpassHz: 60 });
    expect(processed.loudnessAfter.integratedLufs).toBeCloseTo(-16, 0);
    expect(host.project.elements[music].type === "audio" && host.project.elements[music].mediaId).toBe(processed.mediaId);

    // Frame server: images come back as MCP image content, not just paths.
    called.add("captureFrame");
    const frameRaw = await client.callTool({ name: "captureFrame", arguments: { time: 1, shortSide: 360 } });
    const content = frameRaw.content as { type: string; mimeType?: string; data?: string }[];
    expect(content.map((c) => c.type)).toEqual(["text", "image"]);
    expect(content[1].mimeType).toBe("image/jpeg");
    expect(Buffer.from(content[1].data!, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
    expect((frameRaw.structuredContent as Json)._images).toBeUndefined();
    const sheet = await call("frameSheet", { count: 4, columns: 4, returnImage: false });
    expect(sheet.times).toHaveLength(4);
    expect((await call("captureSourceFrames", { elementId: clipB, count: 3, returnImage: false })).timesSourceSeconds).toHaveLength(3);
    expect((await call("view_media", { file: "talk.mp4", count: 4, returnImage: false })).kind).toBe("video");
    const preview = await call("previewVideo", { to: 1, shortSide: 180, waitSeconds: 120 });
    expect(preview.status, JSON.stringify(preview.error)).toBe("done");
    expect(preview.output.frames).toBe(30);
    expect((await call("previewVideoStatus")).jobId).toBe(preview.jobId);
    expect((await call("previewVideoFrames", { count: 2, returnImage: false })).times).toHaveLength(2);
    expect((await call("view_render", { count: 2, returnImage: false })).jobId).toBe(preview.jobId);
    const exported = await call("export", { to: 0.5, waitSeconds: 120 });
    expect(exported.status, JSON.stringify(exported.error)).toBe("done");
    expect(exported.output.path.startsWith(host.paths.outbox)).toBe(true);
    expect(exported.output.codec).toBe("hevc");
    expect((await call("exportStatus")).jobId).toBe(exported.jobId);
    const rendered = await call("render", { quality: "preview", wait_seconds: 120 });
    expect(rendered.status).toBe("done");
    expect(rendered.output.durationSeconds).toBeCloseTo(rendered.timelineSeconds, 1);
    const running = await call("previewVideo", { shortSide: 1080 });
    expect((await call("cancelRender", { jobId: running.jobId })).status).toBe("cancelled");

    // History and revisions.
    const rev = (await call("saveRevision", { label: "first pass" })).revision.number;
    expect((await call("revisions")).revisions.length).toBe(1);
    const before = host.project;
    const v = host.session.version;
    await call("delete", { elementIds: [scrim, sticker] });
    await call("undo", { expectedVersion: v + 1 });
    expect(host.project).toEqual(before);
    await call("redo");
    const stale = await callError("setOpacity", { elementId: dup, opacity: 0.5, expectedVersion: 1 });
    expect(stale.error.code).toBe("VERSION_CONFLICT");
    const reverted = await call("revert", { revision: rev });
    expect(host.project).toEqual(before);
    expect(reverted.backupRevision).toBe(2);
    expect((await call("saveProject", { revisionLabel: "checkpoint" })).revision.number).toBe(3);
    expect((await call("closeProject")).closedProjectId).toBe(p1);

  });

  it.runIf(fullStack)("drives the transcript, vision, speech and autopilot tools", { timeout: 300_000 }, async () => {
    const speech = speechClip();
    const m = testMedia();
    await call("newProject", { name: "Phase 4", canvas: { aspectRatio: "16:9", resolution: "720p" } });
    const imp = await call("importToMediaPanel", { paths: [speech, m.object] });
    const [medSpeech, medObject] = imp.addedIds as string[];
    await call("addMediaPanelItemsToTimeline", { mediaIds: [medSpeech] });

    // Transcript workflow.
    const tr = await call("transcribeClip", { waitSeconds: 110 });
    expect(tr.status, JSON.stringify(tr.error)).toBe("done");
    const text = await call("get_transcript");
    expect(text.transcript).toMatch(/#1 Here/);
    expect(text.fillers.length).toBe(2);
    const edited = await call("edit", { ops: [{ op: "remove_retakes" }, { op: "remove_fillers" }, { op: "remove_silences" }] });
    expect(edited.notes.join(" ")).toMatch(/chosen by fake-model/);
    expect(edited.revisionBefore).toBeGreaterThan(0);
    const caps = await call("generateCaptions", { style: "bold", maxWords: 3 });
    expect(caps.captions).toBeGreaterThan(5);
    const auto = await call("auto_edit", { zoomScale: 1.1, wait_seconds: 120 });
    expect(auto.status, JSON.stringify(auto.error)).toBe("done");
    expect(auto.result.ops.map((o: Json) => o.op)).toContain("auto_zoom");

    // Vision on the moving-object clip.
    const obj = (await call("addMedia", { mediaId: medObject })).elementId;
    expect((await call("detectShots", { elementId: obj })).shotCount).toBe(1);
    expect((await call("detectCuts", { mediaId: medObject })).cuts).toEqual([]);
    const subjects = await call("detectSubjects", { elementId: obj, perSecond: 1 });
    expect(subjects.frames.every((f: Json) => f.primary?.kind === "salient")).toBe(true);
    const tracked = await call("trackObject", { elementId: obj, prompt: "the orange square", perSecond: 10 });
    expect(tracked.located).toBe("orange square");
    expect(tracked.lost).toBe(false);
    const sticker = await call("addStickerFromCutout", { elementId: obj, kind: "subject" });
    expect(host.project.elements[sticker.elementId].type).toBe("sticker");
    const fx = await call("applySubjectEffect", { elementId: obj, effectId: "outline", kind: "subject", color: "#FF00FF", waitSeconds: 120 });
    expect(fx.status, JSON.stringify(fx.error)).toBe("done");
    const reframed = await call("autoReframe", { elementIds: [obj], mode: "static", aspectRatio: "9:16" });
    expect(reframed.clips[0].result).toBe("static");
    expect(reframed.canvas.aspectRatio).toBe("9:16");
    const described = await call("describeClip", { elementId: obj });
    expect(described.summary).toBe("An orange square slides across a blue screen.");

    // Speech and autopilot.
    expect((await call("ttsVoices", { locale: "en" })).count).toBeGreaterThan(0);
    const tts = await call("applyTextToSpeech", { text: "Three quick tips.", start: 0 });
    expect(host.project.elements[tts.elementId].type).toBe("audio");
    expect(tts.durationSeconds).toBeGreaterThan(0.5);
    expect((await call("list_autopilot_jobs")).folder).toBe(host.paths.autoEdit);
  });

  it("drives shot detection and text to speech on any platform", { timeout: 120_000 }, async () => {
    const m = testMedia();
    await call("newProject", { name: "Portable", canvas: { aspectRatio: "16:9", resolution: "720p" } });
    const imp = await call("importToMediaPanel", { paths: [m.object, m.clipA] });
    const [medObject] = imp.addedIds as string[];
    const obj = (await call("addMedia", { mediaId: medObject })).elementId;
    expect((await call("detectShots", { elementId: obj })).shotCount).toBe(1);
    expect((await call("detectCuts", { mediaId: medObject })).cuts).toEqual([]);
    expect((await call("list_autopilot_jobs")).folder).toBe(host.paths.autoEdit);
    if (canSpeak) {
      expect((await call("ttsVoices", { locale: "en" })).count).toBeGreaterThan(0);
      const tts = await call("applyTextToSpeech", { text: "Three quick tips.", start: 0 });
      expect(host.project.elements[tts.elementId].type).toBe("audio");
      expect(tts.durationSeconds).toBeGreaterThan(0.5);
    } else {
      // Without a system voice the tools say so instead of crashing.
      expect(JSON.stringify(await callError("ttsVoices"))).toMatch(/not available/i);
      expect(JSON.stringify(await callError("applyTextToSpeech", { text: "Hello" }))).toMatch(/not available/i);
    }
    // Tools that need software this machine lacks answer with a clear error, never a hang.
    if (!haveVision) expect(JSON.stringify(await callError("detectSubjects", { elementId: obj }))).toMatch(/Vision/);
    if (!haveWhisper) {
      await call("addMedia", { mediaId: (imp.addedIds as string[])[1] });
      const tr = await call("transcribeClip", { waitSeconds: 30 });
      expect(tr.status).toBe("failed");
      expect(tr.error.message).toMatch(/whisper/i);
    }
  });

  it("drives the desktop-app support tools", { timeout: 120_000 }, async () => {
    // Playback mix for the app's audio clock, cached per project version.
    const mix = await call("previewAudio");
    expect(fs.existsSync(mix.path)).toBe(true);
    expect(mix.version).toBe(host.session.version);
    expect((await call("previewAudio")).path).toBe(mix.path);
    // Waveform peaks for timeline clips.
    const audioMedia = Object.values(host.project.media).find((m) => m.hasAudio)!;
    const wave = await call("waveform", { mediaId: audioMedia.id, pointsPerSecond: 20 });
    expect(wave.peaks.length).toBeGreaterThan(10);
    expect(Math.max(...wave.peaks)).toBeGreaterThan(0.01);
    // Settings the app's home screen edits.
    const settings = await call("getSettings");
    expect(settings.shortcutMap).toBe("edits");
    // What this computer can do, so the app can grey out the rest.
    expect(settings.features).toEqual({ transcription: haveWhisper && fs.existsSync(host.settings.whisperModelPath), speech: canSpeak, vision: haveVision });
    expect((await call("updateSettings", { shortcutMap: "premiere", minSilenceSeconds: 0.4 })).shortcutMap).toBe("premiere");
    expect((await call("getSettings")).minSilenceSeconds).toBe(0.4);
    // Voiceover recording needs the desktop app (tested end to end in apps/desktop/test).
    expect(JSON.stringify(await callError("startVoiceoverRecording", { preRollSeconds: 0 }))).toContain("desktop app");
    expect(JSON.stringify(await callError("stopVoiceoverRecording"))).toContain("desktop app");
  });

  it("covers every registered tool", () => {
    const missing = allTools().map((t) => t.name).filter((n) => !called.has(n) && (fullStack || !NEEDS_FULL_STACK.includes(n)));
    expect(missing).toEqual([]);
  });
});
