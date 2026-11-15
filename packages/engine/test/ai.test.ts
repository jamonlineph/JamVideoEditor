import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMediaToTimeline, normalizeWord, timelineWords } from "@openedits/core";
import { ClaudeClient, EngineHost, autoEditFiles, describeClip, findRetakesWithAi, listAutopilotJobs, AutopilotWatcher, loadSettings, resolveWorkspace, type TimelineWord } from "../src/index.js";
import { FakeAi } from "./fakeAi.js";
import { speechClip, tempWorkspace, testMedia } from "./media.js";

const w = (id: number, text: string, start: number): TimelineWord => ({ id, text, start, end: start + 0.3, elementId: "el", mediaId: "m", isFiller: false, confidence: 1 });
const WORDS = [w(1, "Second,", 0), w(2, "cut", 0.4), w(3, "the", 0.8), w(4, "silences.", 1.2), w(5, "Second,", 2), w(6, "cut", 2.4), w(7, "every", 2.8), w(8, "silence.", 3.2)];

describe("Claude opt-in", () => {
  it("is off unless a key is set or it is enabled in settings", () => {
    const paths = resolveWorkspace(tempWorkspace("claude"));
    const base = { ...loadSettings(paths), claude: { model: "claude-opus-5-5", apiKeyEnv: "OPENEDITS_TEST_NO_SUCH_KEY" } };
    expect(new ClaudeClient(() => base).unavailableReason()).toMatch(/OPENEDITS_TEST_NO_SUCH_KEY/);
    expect(new ClaudeClient(() => ({ ...base, claude: { ...base.claude, enabled: true } })).unavailableReason()).toBeNull();
    process.env.OPENEDITS_TEST_KEY = "x";
    expect(new ClaudeClient(() => ({ ...base, claude: { ...base.claude, apiKeyEnv: "OPENEDITS_TEST_KEY" } })).unavailableReason()).toBeNull();
    expect(new ClaudeClient(() => ({ ...base, claude: { ...base.claude, apiKeyEnv: "OPENEDITS_TEST_KEY", enabled: false } })).unavailableReason()).toMatch(/turned off/);
    delete process.env.OPENEDITS_TEST_KEY;
  });
});

describe("model-assisted helpers (fake model)", () => {
  it("keeps only valid retake ranges", async () => {
    const ai = new FakeAi(() => ({
      retakes: [
        { fromId: 1, toId: 4, reason: "restarted the sentence" },
        { fromId: 6, toId: 5, reason: "backwards" },
        { fromId: 90, toId: 91, reason: "unknown ids" },
        { fromId: 1, toId: 8, reason: "too much" },
      ],
    }));
    const r = await findRetakesWithAi(ai, WORDS);
    expect(r.ranges).toEqual([[1, 4]]);
    expect(r.reasons).toEqual(["restarted the sentence"]);
    expect(ai.calls[0].effort).toBe("medium");
    const text = (ai.calls[0].content[0] as { text: string }).text;
    expect(text).toContain("#5 Second,");
  });

  it("describes a clip from its contact sheet and words", async () => {
    const ai = new FakeAi(() => ({
      summary: "A test pattern.",
      setting: "studio",
      peopleCount: 0,
      shotType: "other",
      topics: ["testing"],
      vibes: ["calm"],
      suggestedCaption: "Testing, testing",
      hookIdeas: ["Is this thing on?"],
      aestheticScore: 6,
      aestheticNotes: "flat light",
    }));
    const sheet = path.join(tempWorkspace("sheet"), "s.jpg");
    fs.writeFileSync(sheet, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const r = await describeClip(ai, sheet, { name: "a.mp4", durationSeconds: 6, times: [1, 3, 5], transcript: "hello there" });
    expect(r.value.aestheticScore).toBe(6);
    const [image, text] = ai.calls[0].content as [{ type: string }, { text: string }];
    expect(image.type).toBe("image");
    expect(text.text).toContain("hello there");
    expect(ai.calls[0].effort).toBe("low");
  });
});

describe("retake detection in edits", () => {
  let host: EngineHost;
  beforeAll(async () => {
    host = EngineHost.create({ workspaceRoot: tempWorkspace("ai-edit"), validate: true, ai: new FakeAi(() => ({ retakes: [] }), "Claude features are off (test)") });
    host.newProject({ name: "AI edit" });
    const imp = await host.importMedia([speechClip()]);
    host.mutate("add", "t", (c) => addMediaToTimeline(c, c.draft.media[imp.assets[0].id], {}));
    const job = host.transcripts.start(host.transcripts.missingForTimeline());
    expect((await host.jobs.wait(job.id, 110_000)).status).toBe("done");
  }, 120_000);
  afterAll(() => host.dispose());

  it("falls back to the heuristic when Claude is off, and uses the model's ranges when on", async () => {
    const r = await host.transcripts.edit([{ op: "remove_retakes" }], "t");
    expect(r.notes.join(" ")).toMatch(/local heuristic/);
    expect((r.result as { method: string }[])[0].method).toBe("heuristic");
    host.undo("t");
    await expect(host.transcripts.edit([{ op: "remove_retakes", method: "ai" }], "t")).rejects.toThrow(/off/);

    // Same engine, model switched on: the model picks the first "Second, cut the silences." take.
    const words = timelineWords(host.project, host.transcripts.all()).words;
    const second = words.filter((x) => normalizeWord(x.text) === "second").map((x) => x.id);
    const silences = words.find((x) => normalizeWord(x.text) === "silences")!.id;
    const ai = new FakeAi(() => ({ retakes: [{ fromId: second[0], toId: silences, reason: "repeated" }] }));
    Object.defineProperty(host, "ai", { value: ai });
    const r2 = await host.transcripts.edit([{ op: "remove_retakes" }], "t");
    expect(r2.notes[0]).toMatch(/1 retake chosen by fake-model/);
    const text = timelineWords(host.project, host.transcripts.all()).words.map((x) => normalizeWord(x.text)).join(" ");
    expect(text).toContain("second cut every single silence");
    expect(text).not.toContain("the silences");
  });
});

describe("autopilot", () => {
  it("turns a dropped video into an edited, rendered project without touching the open project", { timeout: 240_000 }, async () => {
    const root = tempWorkspace("autopilot");
    const main = EngineHost.create({ workspaceRoot: root });
    const open = main.newProject({ name: "What I am working on" });
    const watcher = new AutopilotWatcher({ workspaceRoot: root, render: "preview", engine: { validate: true } });
    fs.mkdirSync(watcher.paths.autoEdit, { recursive: true });
    fs.copyFileSync(speechClip(), path.join(watcher.paths.autoEdit, "my tip.mp4"));
    fs.copyFileSync(testMedia().photo, path.join(watcher.paths.autoEdit, "ignored.png"));
    expect(watcher.pending()).toEqual(["my tip.mp4"]);
    expect(await watcher.tick()).toEqual([]); // first sight: wait for the size to settle
    const [job] = await watcher.tick();
    expect(job.status, job.error).toBe("done");
    expect(job.projectName).toBe("my tip");
    expect(job.removedSeconds).toBeGreaterThan(3);
    expect(fs.existsSync(job.output!)).toBe(true);
    expect(fs.existsSync(path.join(watcher.paths.autoEdit, "done", "my tip.mp4"))).toBe(true);
    expect(watcher.pending()).toEqual([]);
    expect(listAutopilotJobs(watcher.paths)[0]).toMatchObject({ id: job.id, status: "done" });
    // The creator's open project and the project restored on next start are unchanged.
    expect(main.appState.openProjectId).toBe(open.id);
    expect(JSON.parse(fs.readFileSync(main.paths.sessionFile, "utf8")).openProjectId).toBe(open.id);
    expect(main.listProjects().map((p) => p.name).sort()).toEqual(["What I am working on", "my tip"]);
    main.dispose();
    const failed = await autoEditFiles(["/nope/missing.mp4"], { workspaceRoot: root, render: "none" });
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/not found/i);
  });
});
