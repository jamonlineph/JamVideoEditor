import fs from "node:fs";
import { expect, it } from "vitest";
import { addMediaToTimeline, setSound, setTransform } from "@openedits/core";
import { EngineHost } from "@openedits/engine";
import { tempWorkspace, testMedia } from "../../engine/test/media.js";
import { runTool } from "../src/server.js";
import { uiTools } from "../src/tools/ui.js";

it("reuses playback windows after picture edits and rebuilds them after audio edits", async () => {
  const host = EngineHost.create({ workspaceRoot: tempWorkspace("audio-window") });
  try {
    host.newProject({ name: "Playback windows" });
    const imported = await host.importMedia([testMedia().clipA]);
    const clip = host.mutate("clip", "test", (ctx) => addMediaToTimeline(ctx, ctx.draft.media[imported.assets[0].id], {})).result;
    const call = async (args: { startSeconds?: number; durationSeconds?: number }) => {
      const res = await runTool(uiTools.find((tool) => tool.name === "previewAudio")!, args, { host, source: "test" });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error(JSON.stringify(res.error));
      return res.result as { path: string; startSeconds: number; durationSeconds: number; version: number };
    };
    const args = { startSeconds: 2, durationSeconds: 1.5 };
    const first = await call(args);
    expect(first).toMatchObject(args);
    expect(fs.statSync(first.path).size).toBe(44 + 48_000 * 1.5 * 2 * 4);
    host.mutate("move picture", "test", (ctx) => setTransform(ctx, ctx.draft.elements[clip.id], { x: 0.4 }));
    const visual = await call(args);
    expect(visual.path).toBe(first.path);
    expect(visual.version).toBeGreaterThan(first.version);
    host.mutate("change gain", "test", (ctx) => setSound(ctx, ctx.draft.elements[clip.id], { volume: 0.75 }));
    expect((await call(args)).path).not.toBe(first.path);
    const full = await call({});
    expect(full.durationSeconds).toBeGreaterThan(5);
    expect((await call({})).path).toBe(full.path);
  } finally {
    host.dispose();
  }
});
