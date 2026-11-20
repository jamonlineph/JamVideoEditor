import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addMediaToTimeline, mainTrack, splitAt, sequentialIds } from "@openedits/core";
import { EngineHost, createFfprobe, resolveWorkspace, type ProbeResult } from "../src/index.js";
import { tempWorkspace, testMedia } from "./media.js";

const hosts: EngineHost[] = [];
function host(root: string, extra: Partial<Parameters<typeof EngineHost.create>[0]> = {}) {
  const h = EngineHost.create({ workspaceRoot: root, validate: true, ...extra });
  hosts.push(h);
  return h;
}
afterEach(() => {
  while (hosts.length) {
    try {
      hosts.pop()!.dispose();
    } catch {
      /* already disposed */
    }
  }
});

describe("workspace", () => {
  it("creates folders, settings and a style guide", () => {
    const root = tempWorkspace("ws");
    const h = host(root);
    const p = resolveWorkspace(root);
    for (const dir of [p.inbox, p.autoEdit, p.projects, p.outbox, p.fonts, p.music]) expect(fs.existsSync(dir)).toBe(true);
    expect(h.settings.httpPort).toBe(4417);
    expect(h.getStyleGuide()).toMatch(/Style Guide/);
    h.saveStyleGuide("# Mine\n");
    expect(h.getStyleGuide()).toBe("# Mine\n");
  });
});

describe("probe", () => {
  it("reads real media metadata", async () => {
    const m = testMedia();
    const probe = createFfprobe();
    const a = await probe(m.clipA);
    expect(a).toMatchObject({ kind: "video", width: 1080, height: 1920, fps: 30, hasVideo: true, hasAudio: true });
    expect(a.durationSourceSeconds).toBeCloseTo(6, 1);
    expect((await probe(m.music)).kind).toBe("audio");
    const img = await probe(m.photo);
    expect(img).toMatchObject({ kind: "image", width: 800, height: 800 });
    expect(img.durationSourceSeconds).toBeUndefined();
    await expect(probe("/nope/missing.mp4")).rejects.toThrow(/not found/);
  });
});

describe("library and persistence", () => {
  it("manages projects on the home screen", () => {
    const h = host(tempWorkspace("lib"));
    const a = h.newProject({ name: "Alpha" });
    const b = h.newProject({ name: "Beta", canvas: { aspectRatio: "16:9" } });
    expect(h.appState).toMatchObject({ screen: "editor", openProjectId: b.id });
    expect(h.listProjects().map((r) => r.name).sort()).toEqual(["Alpha", "Beta"]);
    expect(h.togglePin(a.id)).toBe(true);
    expect(h.listProjects()[0].id).toBe(a.id);
    expect(h.toggleFavorite(b.id)).toBe(true);
    expect(h.listProjects({ filter: "favorites" }).map((r) => r.id)).toEqual([b.id]);
    h.renameProject(b.id, "Beta 2");
    expect(h.project.name).toBe("Beta 2");
    const r = h.deleteProject(b.id);
    expect(fs.existsSync(r.trashedTo)).toBe(true);
    expect(h.appState.screen).toBe("home");
    expect(h.listProjects().map((x) => x.id)).toEqual([a.id]);
  });

  it("restores state and undo history after a restart", async () => {
    const root = tempWorkspace("persist");
    const m = testMedia();
    const h1 = host(root);
    h1.newProject({ name: "Persist" });
    await h1.importMedia([m.clipA, m.clipB]);
    const ids = Object.keys(h1.project.media);
    h1.mutate("add", "test", (ctx) => ids.forEach((id) => addMediaToTimeline(ctx, ctx.draft.media[id], {})));
    h1.mutate("splits", "test", (ctx) => splitAt(ctx, { times: [1, 2, 3] }));
    const state = h1.project;
    const version = h1.session.version;
    h1.dispose();
    hosts.pop();

    const h2 = host(root);
    expect(h2.appState.openProjectId).toBe(state.id);
    expect(h2.project).toEqual(state);
    expect(h2.session.version).toBe(version);
    h2.undo("test");
    expect(mainTrack(h2.project).elementIds.length).toBe(2);
    h2.redo("test");
    expect(mainTrack(h2.project).elementIds.length).toBe(5);
  });

  it("locks a project to one engine", () => {
    const root = tempWorkspace("lock");
    const h1 = host(root);
    const p = h1.newProject({ name: "Locked" });
    const h2 = host(root, { restoreLastProject: false });
    expect(() => h2.openProject(p.id)).toThrow(/another OpenEdits engine/);
    h1.closeProject();
    expect(h2.openProject(p.id).id).toBe(p.id);
  });

  it("revisions and revert", async () => {
    const h = host(tempWorkspace("rev"), { ids: sequentialIds() });
    const m = testMedia();
    h.newProject({ name: "Rev" });
    await h.importMedia([m.clipA]);
    const mid = Object.keys(h.project.media)[0];
    h.mutate("add", "t", (ctx) => addMediaToTimeline(ctx, ctx.draft.media[mid], {}));
    const r1 = h.saveRevision("rough cut 1", "t");
    const snapshot = h.project;
    h.mutate("splits", "t", (ctx) => splitAt(ctx, { times: [1, 2] }));
    expect(mainTrack(h.project).elementIds.length).toBe(3);
    const rev = h.revert(r1.number, "t");
    expect(h.project).toEqual(snapshot);
    expect(h.listRevisions().map((r) => r.label)).toEqual(["rough cut 1", "Before revert to #1"]);
    h.undo("t");
    expect(mainTrack(h.project).elementIds.length).toBe(3);
    expect(rev.backupRevision).toBe(2);
    expect(() => h.revert(99, "t")).toThrow(/No revision/);
  });

  it("dedupes media imports and lists the inbox", async () => {
    const root = tempWorkspace("inbox");
    const h = host(root);
    const m = testMedia();
    fs.copyFileSync(m.clipB, path.join(h.paths.inbox, "drop.mp4"));
    fs.writeFileSync(path.join(h.paths.inbox, "notes.txt"), "x");
    const files = await h.listInbox({ probe: true });
    expect(files.map((f) => f.name)).toEqual(["drop.mp4"]);
    expect(files[0].probe?.kind).toBe("video");
    h.newProject();
    const first = await h.importMedia([m.photo]);
    const again = await h.importMedia([m.photo]);
    expect(again.existing).toEqual(first.added);
  });

  it("does not attach in-flight imports to a different project", async () => {
    const probe = Promise.withResolvers<ProbeResult>();
    const h = host(tempWorkspace("switch-import"), { prober: () => probe.promise });
    const first = h.newProject();
    const importing = h.importMedia(["photo.png"]);
    const second = h.newProject();
    probe.resolve({ kind: "image", width: 100, height: 100, sizeBytes: 1, hasVideo: true, hasAudio: false });
    await expect(importing).rejects.toThrow("The project changed during import");
    expect(h.project.id).toBe(second.id);
    expect(h.project.media).toEqual({});
    expect(h.openProject(first.id).media).toEqual({});
  });
});
