import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { level, tempWorkspace, testMedia } from "../../../packages/engine/test/media.js";
import { AppHarness, clickButton, connectAgent, setSlider } from "./harness.js";

/**
 * End-to-end tests of the desktop app: a hidden Electron window driven over the test IPC channel,
 * with an MCP agent connected to the same engine. Screenshots land in the temp workspace.
 */
describe("desktop app", () => {
  let app: AppHarness;
  let agent: Awaited<ReturnType<typeof connectAgent>>;
  let ws: string;
  const media = testMedia();
  const project = () => app.eval<{ elements: Record<string, Record<string, unknown>>; tracks: { kind: string; elementIds: string[] }[] }>("window.openedits.live.state.project");
  const mainIds = async () => (await project()).tracks.find((t) => t.kind === "main")!.elementIds;
  const shot = (name: string) => app.capture(path.join(ws, `${name}.png`));

  beforeAll(async () => {
    ws = tempWorkspace("ui");
    app = await AppHarness.launch(ws);
    agent = await connectAgent(ws);
  }, 90_000);

  afterAll(async () => {
    await agent?.close();
    await app?.quit();
  });

  it("opens on the home screen and creates a project from the UI", async () => {
    await app.waitFor(`document.querySelector(".home") && document.body.textContent.includes("No projects yet")`);
    expect(await app.eval(clickButton("New project", ".titlebar"))).toBe(true);
    await app.waitFor(`!!document.querySelector(".editor .timeline")`);
    expect(await app.eval(`document.querySelector(".inspector .kind")?.textContent`)).toBe("Project");
  });

  it("shows media, clips and agent edits live", async () => {
    await app.call("importToMediaPanel", { paths: [media.clipA, media.music] });
    await app.waitFor(`document.querySelectorAll(".media-item").length === 2`);
    const items = await app.call<{ items: { id: string; kind: string }[] }>("mediaPanel");
    const video = items.items.find((m) => m.kind === "video")!.id;
    const music = items.items.find((m) => m.kind === "audio")!.id;
    await app.call("addMedia", { mediaId: video });
    await app.call("addMedia", { mediaId: music, start: 0, role: "music" });
    await app.waitFor(`document.querySelectorAll(".lane.main .clip").length === 1 && document.querySelectorAll(".clip").length === 2`);

    // An agent over MCP edits the same composition: the UI follows, and says who did it.
    await agent.call("addMedia", { mediaId: video });
    await agent.call("addText", { text: "Hello Edits", start: 1, duration: 3 });
    await agent.call("setPlayhead", { seconds: 2 });
    await app.waitFor(`document.querySelectorAll(".lane.main .clip").length === 2 && [...document.querySelectorAll(".clip .name")].some((n) => n.textContent.includes("Hello Edits"))`);
    await app.waitFor(`[...document.querySelectorAll(".toast.agent")].some((t) => t.textContent.includes("test-agent"))`);
    await app.waitFor(`document.querySelector(".transport .time")?.textContent.startsWith("00:02:00")`);
    expect(await app.eval(`window.openedits.live.state.project.tracks.length`)).toBeGreaterThanOrEqual(3);
  });

  it("draws the composition in the viewport", async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const file = path.join(ws, "editor.png");
    await shot("editor");
    expect(fs.statSync(file).size).toBeGreaterThan(10_000);
    // The middle of the window is the 9:16 preview of the colorful test pattern, not the dark UI.
    expect(level(file, "center")).toBeGreaterThan(40);
  });

  it("edits through the inspector as one undo step per gesture", async () => {
    const [first] = await mainIds();
    await app.call("setSelection", { elementIds: [first] });
    await app.waitFor(`document.querySelector(".inspector .kind")?.textContent.startsWith("video")`);
    expect(await app.eval(clickButton("Color", ".prop-tabs"))).toBe(true);
    await app.waitFor(`!!document.querySelector(".inspector .field input[type=range]")`);
    const before = await app.eval<number>("window.openedits.live.state.version");
    expect(await app.eval(setSlider("Exposure", 40))).toBe(true);
    await app.waitFor(`window.openedits.live.state.project.elements[${JSON.stringify(first)}].color.grade.exposure === 40`);
    expect(await app.eval<number>("window.openedits.live.state.version")).toBe(before + 1);
    await shot("inspector-adjust");
  });

  it("shows rendered previews on effect, transition, filter and LUT tiles, animated on hover", async () => {
    for (const [tab, kind, chip] of [["Effects", "effect"], ["Transitions", "transition"], ["Filters", "filter"], ["Adjust", "lut", "LUTs"]] as const) {
      expect(await app.eval(clickButton(tab, ".dock .tabs"))).toBe(true);
      if (chip) expect(await app.eval(clickButton(chip, ".dock .chips"))).toBe(true);
      // The first tiles get a still rendered by the compositor (a JPEG data URL).
      await app.waitFor(`[...document.querySelectorAll('.dock .tile.preview[data-preview^="${kind}:"] img')].filter((i) => i.src.startsWith("data:image/jpeg")).length >= 4`, 30_000);
    }
    // Hovering a transition plays it.
    await app.eval(clickButton("Transitions", ".dock .tabs"));
    const sel = `.dock .tile.preview[data-preview="transition:slide_left"]`;
    await app.waitFor(`!!document.querySelector('${sel} img')`, 30_000);
    await app.eval(`document.querySelector('${sel} img').dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }))`);
    await app.waitFor(`!!document.querySelector('${sel} canvas')`, 5000);
    const frame = `(() => { const d = document.querySelector('${sel} canvas').getContext("2d").getImageData(0, 0, 320, 180).data; let s = 0; for (let i = 0; i < d.length; i += 101) s += d[i]; return s; })()`;
    const seen = new Set<number>();
    for (let i = 0; i < 8 && seen.size < 2; i++) {
      seen.add(await app.eval<number>(frame));
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(seen.size).toBeGreaterThan(1);
    await app.eval(`document.querySelector('${sel} canvas').dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }))`);
    await app.waitFor(`!!document.querySelector('${sel} img')`, 5000);
    await shot("previews");
  }, 90_000);

  it("double-clicking a slider restores its default", async () => {
    const [first] = await mainIds();
    await app.call("setSelection", { elementIds: [first] });
    await app.waitFor(`!!document.querySelector(".panel-list")`);
    expect(await app.eval(clickButton("Basic", ".prop-tabs"))).toBe(true);
    const scaleInput = `[...document.querySelectorAll(".inspector .field")].find((f) => f.querySelector("label")?.textContent?.trim().endsWith("Scale")).querySelector("input")`;
    await app.eval(`(() => {
      const input = ${scaleInput};
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "2.5");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    })()`);
    await app.waitFor(`window.openedits.live.state.project.elements[${JSON.stringify(first)}].transform.scale > 2`);
    await app.eval(`${scaleInput}.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
    await app.waitFor(`window.openedits.live.state.project.elements[${JSON.stringify(first)}].transform.scale === 1`);
  });

  it("trims a clip by dragging its edge on the timeline", async () => {
    const [first] = await mainIds();
    const before = (await project()).elements[first].duration as number;
    const dragged = await app.eval(`(() => {
      const handle = document.querySelector('.clip[data-id=${JSON.stringify(first)}] .trim.r');
      const lanes = document.querySelector(".lanes");
      if (!handle) return false;
      const r = handle.getBoundingClientRect();
      const y = r.top + r.height / 2;
      const opts = (x) => ({ bubbles: true, clientX: x, clientY: y, pointerId: 7 });
      handle.dispatchEvent(new PointerEvent("pointerdown", opts(r.right - 2)));
      lanes.dispatchEvent(new PointerEvent("pointermove", opts(r.right - 62)));
      lanes.dispatchEvent(new PointerEvent("pointerup", opts(r.right - 62)));
      return true;
    })()`);
    expect(dragged).toBe(true);
    await app.waitFor(`window.openedits.live.state.project.elements[${JSON.stringify(first)}].duration < ${before - 0.5}`);
    const after = (await project()).elements[first].duration as number;
    expect(after).toBeCloseTo(before - 1, 1); // 60 px at the default 60 px/s
  });

  it("shows film-strip frames on video clips and pictures in the media grid", async () => {
    await app.waitFor(`[...document.querySelectorAll(".lane.main .clip .filmstrip .frame")].some((f) => f.style.backgroundImage.includes("blob:"))`, 30_000);
    await app.eval(clickButton("Media", ".dock .tabs"));
    await app.waitFor(`[...document.querySelectorAll(".media-item .thumb img")].some((i) => i.src.startsWith("blob:"))`, 30_000);
  });

  it("animates a clip from the Animation tab (in, then a combo)", async () => {
    const [first] = await mainIds();
    await app.call("setSelection", { elementIds: [first] });
    await app.waitFor(`!!document.querySelector(".prop-tabs")`);
    expect(await app.eval(clickButton("Animation", ".prop-tabs"))).toBe(true);
    await app.waitFor(`!!document.querySelector('.anim-tile[data-anim="zoom_in"]')`);
    await app.eval(`document.querySelector('.anim-tile[data-anim="zoom_in"]').click()`);
    await app.waitFor(`window.openedits.live.state.project.elements[${JSON.stringify(first)}].animation?.in?.id === "zoom_in"`);
    expect(await app.eval(clickButton("Combo", ".anim-slots"))).toBe(true);
    await app.waitFor(`!!document.querySelector('.anim-tile[data-anim="ken_burns"]')`);
    await app.eval(`document.querySelector('.anim-tile[data-anim="ken_burns"]').click()`);
    await app.waitFor(`window.openedits.live.state.project.elements[${JSON.stringify(first)}].animation?.loop?.id === "ken_burns"`);
    // The clip on the timeline says it is animated.
    await app.waitFor(`!!document.querySelector('.clip[data-id=${JSON.stringify(first)}] .chip-mini[title="Animated"]')`);
    await shot("animation");
  });

  it("puts a transition on a cut from the button between clips", async () => {
    const [first] = await mainIds();
    await app.call("setSelection", { elementIds: [] });
    await app.waitFor(`!!document.querySelector('.tr-btn[data-from=${JSON.stringify(first)}]')`);
    await app.eval(`document.querySelector('.tr-btn[data-from=${JSON.stringify(first)}]').click()`);
    // The library switches to transitions, aimed at that cut.
    await app.waitFor(`document.querySelector(".dock .tabs button.active")?.textContent.trim() === "Transitions"`);
    await app.waitFor(`window.openedits.live.state.appState.selection.elementIds[0] === ${JSON.stringify(first)}`);
    await app.waitFor(`!!document.querySelector('.dock .tile.preview[data-preview="transition:heart"]')`, 30_000);
    await app.eval(`document.querySelector('.dock .tile.preview[data-preview="transition:heart"]').click()`);
    await app.waitFor(`window.openedits.live.state.project.transitions.some((t) => t.fromElementId === ${JSON.stringify(first)} && t.type === "heart")`);
    await app.waitFor(`document.querySelector('.tr-btn[data-from=${JSON.stringify(first)}]')?.classList.contains("on")`);
    // Apply to all copies it onto every cut.
    expect(await app.eval(clickButton("Apply to all", ".dock"))).toBe(true);
    const cuts = (await mainIds()).length - 1;
    await app.waitFor(`window.openedits.live.state.project.transitions.filter((t) => t.type === "heart").length === ${cuts}`);
  });

  it("adds an effect with nothing selected on its own layer, and colorful stickers and text styles", async () => {
    await app.call("setSelection", { elementIds: [] });
    await app.call("setPlayhead", { seconds: 1 });
    expect(await app.eval(clickButton("Effects", ".dock .tabs"))).toBe(true);
    await app.waitFor(`!!document.querySelector('.dock .tile.preview[data-preview="effect:snow"]')`, 30_000);
    await app.eval(`document.querySelector('.dock .tile.preview[data-preview="effect:snow"]').click()`);
    await app.waitFor(`Object.values(window.openedits.live.state.project.elements).some((e) => e.type === "adjustment" && e.effects.some((f) => f.effectId === "snow"))`);
    expect(await app.eval(clickButton("Stickers", ".dock .tabs"))).toBe(true);
    await app.waitFor(`!!document.querySelector('.sticker-tile[data-sticker="fire"] svg path')`);
    await app.eval(`document.querySelector('.sticker-tile[data-sticker="fire"]').click()`);
    await app.waitFor(`Object.values(window.openedits.live.state.project.elements).some((e) => e.type === "sticker" && e.stickerId === "fire")`);
    expect(await app.eval(clickButton("Text", ".dock .tabs"))).toBe(true);
    const added = await app.eval<boolean>(`(() => { const t = [...document.querySelectorAll(".dock .text-tile")].find((x) => x.querySelector(".label")?.textContent === "Bold Pop"); t?.click(); return !!t; })()`);
    expect(added).toBe(true);
    await app.waitFor(`Object.values(window.openedits.live.state.project.elements).some((e) => e.type === "text" && e.presetId === "bold_pop")`);
    // A new text is selected and its properties open on the Text tab.
    await app.waitFor(`document.querySelector(".inspector")?.dataset.type === "text"`);
    await shot("library-adds");
    for (const id of await app.eval<string[]>(`Object.values(window.openedits.live.state.project.elements).filter((e) => e.type === "adjustment" || e.type === "sticker" || (e.type === "text" && e.presetId === "bold_pop")).map((e) => e.id)`)) {
      await app.call("delete", { elementIds: [id] });
    }
  });

  it("works as a phone: tool bar, bottom sheets and clip tools", async () => {
    await app.resize(412, 860);
    try {
      await app.call("setSelection", { elementIds: [] });
      await app.waitFor(`!!document.querySelector(".bottom-bar") && !document.querySelector(".editor-library")`);
      expect(await app.eval(clickButton("Text", ".bottom-bar"))).toBe(true);
      await app.waitFor(`document.querySelector(".bottom-sheet")?.textContent.includes("Add text")`);
      await shot("phone-sheet");
      expect(await app.eval(clickButton("", ".bottom-sheet header"))).toBe(true);
      await app.waitFor(`!document.querySelector(".bottom-sheet")`);
      const [first] = await mainIds();
      await app.call("setSelection", { elementIds: [first] });
      await app.waitFor(`document.querySelector(".bottom-bar")?.classList.contains("selection")`);
      expect(await app.eval(clickButton("Speed", ".bottom-bar"))).toBe(true);
      await app.waitFor(`[...document.querySelectorAll(".bottom-sheet .field label")].some((l) => l.textContent.trim() === "Speed")`);
      await shot("phone-speed");
      await app.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
      await app.waitFor(`!document.querySelector(".bottom-sheet")`);
      await app.call("setSelection", { elementIds: [] });
    } finally {
      await app.resize(1480, 920);
    }
    await app.waitFor(`!!document.querySelector(".editor-library")`);
  });

  it("splits with the keyboard and undoes with Cmd+Z", async () => {
    await app.call("setSelection", { elementIds: [] });
    await app.call("setPlayhead", { seconds: 2 });
    await app.waitFor(`document.querySelector(".transport .time")?.textContent.startsWith("00:02:00")`);
    const count = (await mainIds()).length;
    await app.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "s" }))`);
    await app.waitFor(`document.querySelectorAll(".lane.main .clip").length === ${count + 1}`);
    await app.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true }))`);
    await app.waitFor(`document.querySelectorAll(".lane.main .clip").length === ${count}`);
  });

  it("restarts a crashed engine and reconnects without losing the project", async () => {
    const before = await mainIds();
    const engine = JSON.parse(fs.readFileSync(path.join(ws, ".engine.json"), "utf8")) as { pid: number };
    process.kill(engine.pid, "SIGKILL");
    await app.waitFor(`!window.openedits.live.state.connected`, 5000);
    await app.waitFor(`window.openedits.live.state.connected && window.openedits.live.state.project`, 30_000);
    expect(await mainIds()).toEqual(before);
    const fresh = JSON.parse(fs.readFileSync(path.join(ws, ".engine.json"), "utf8")) as { pid: number };
    expect(fresh.pid).not.toBe(engine.pid);
    // The agent rejoins the new engine.
    await agent.close();
    agent = await connectAgent(ws);
    expect((await agent.call<{ project: { id: string } }>("get_project")).project.id).toBeTruthy();
  }, 60_000);

  it("records a voiceover an agent asks for (fake microphone)", async () => {
    const start = await agent.call<{ recording: boolean; start: number }>("startVoiceoverRecording", { start: 0.5, preRollSeconds: 0 });
    expect(start.recording).toBe(true);
    await app.waitFor(`!!document.querySelector(".recorder")`);
    await new Promise((r) => setTimeout(r, 1500));
    const take = await agent.call<{ path: string; durationSeconds: number }>("stopVoiceoverRecording");
    expect(fs.existsSync(take.path)).toBe(true);
    expect(take.durationSeconds).toBeGreaterThan(1);
    const vo = Object.values((await project()).elements).find((e) => e.type === "audio" && e.role === "voiceover");
    expect(vo).toBeDefined();
    expect(vo!.start).toBeCloseTo(0.5, 2);
  }, 60_000);

  it("saves a cover frame for the project grid when going back to projects", async () => {
    await app.eval(`document.querySelector(".back-projects").click()`);
    await app.waitFor(`!!document.querySelector(".home .card img.poster")`, 30_000);
    await shot("home-cover");
  }, 60_000);
});
