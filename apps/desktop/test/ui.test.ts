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
    expect(await app.eval(clickButton("Adjust", ".panel-list"))).toBe(true);
    await app.waitFor(`!!document.querySelector(".inspector .field input[type=range]")`);
    const before = await app.eval<number>("window.openedits.live.state.version");
    expect(await app.eval(setSlider("Exposure", 40))).toBe(true);
    await app.waitFor(`window.openedits.live.state.project.elements[${JSON.stringify(first)}].color.grade.exposure === 40`);
    expect(await app.eval<number>("window.openedits.live.state.version")).toBe(before + 1);
    await shot("inspector-adjust");
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
});
