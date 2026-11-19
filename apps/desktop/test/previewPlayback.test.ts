import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addMediaToTimeline, compositionDuration, setSound, type Project, type Scene } from "@openedits/core";
import { makeSession } from "../../../packages/core/test/fixtures.js";
import { PlaybackAudio } from "../src/ui/playbackAudio.js";
import { Player, Preview } from "../src/ui/preview.js";
import { ui } from "../src/ui/uiStore.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  render: vi.fn<(scene: Scene) => void>(),
  live: { state: { project: null as Project | null }, call: vi.fn(), toast: vi.fn() },
}));

vi.mock("@openedits/renderer", () => ({
  Compositor: class {
    gl = { getExtension: () => null };
    render = mocks.render;
    present() {}
  },
  loadSceneFonts: () => Promise.resolve(),
}));

vi.mock("@openedits/render-host/media", () => ({
  MediaManager: class {
    prepare = mocks.prepare;
    setAndroidMediaCodec() {}
    use() {}
    reset() {}
  },
}));

vi.mock("../src/ui/live.js", () => ({ live: mocks.live, WEB: false, fileUrl: (file: string) => file }));

function stubAudioContext() {
  const resume = vi.fn(async () => {});
  vi.stubGlobal("AudioContext", class {
    state = "running";
    currentTime = 0;
    resume = resume;
    async suspend() {}
    async close() {}
    async decodeAudioData() { return { duration: 4 }; }
  });
  return { resume };
}

describe("preview playback", () => {
  let preview: Preview;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.prepare.mockResolvedValue([]);
    ui.set({ playing: false, playhead: 0 });
    preview = new Preview({} as HTMLCanvasElement);
    preview.setProject(makeSession().state);
  });

  afterEach(() => {
    preview.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    mocks.live.state.project = null;
  });

  it("presents only the latest seek when a newer position arrives during decode", async () => {
    const decode = Promise.withResolvers<string[]>();
    mocks.prepare.mockReturnValueOnce(decode.promise);
    const first = preview.draw(1, "seek");
    await preview.draw(2, "seek");
    await preview.draw(3, "seek");

    decode.resolve([]);
    await first;

    expect(mocks.render.mock.calls.map(([scene]) => scene.timeSeconds)).toEqual([3]);
    expect(performance.getEntriesByName("openedits.preview.seek")[0]).toMatchObject({ detail: { timeSeconds: 3 } });
  });

  it("still presents completed frames during continuous playback and measures skipped frames", async () => {
    const decode = Promise.withResolvers<string[]>();
    mocks.prepare.mockReturnValueOnce(decode.promise);
    preview.startPlayback();
    const first = preview.draw(0, "playback");
    await preview.draw(1 / 30, "playback");
    await preview.draw(2 / 30, "playback");

    decode.resolve([]);
    await first;
    preview.stopPlayback();

    expect(mocks.render.mock.calls.map(([scene]) => scene.timeSeconds)).toEqual([0, 2 / 30]);
    expect(performance.getEntriesByName("openedits.preview.playback")[0]).toMatchObject({
      detail: { framesPresented: 2, framesSkipped: 1 },
    });
  });

  it("requests the first picture immediately and starts the frame clock if audio is slow", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stubAudioContext();
    const requestFrame = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    mocks.live.call.mockReturnValue(new Promise(() => {}));
    const session = makeSession();
    session.transact("add music", "test", (ctx) => addMediaToTimeline(ctx, ctx.draft.media.med_music, {}));
    mocks.live.state.project = session.state;
    preview.setProject(session.state);
    const player = new Player(preview);

    try {
      const started = player.play();
      expect(mocks.prepare).toHaveBeenCalledOnce();
      expect(mocks.live.call).toHaveBeenCalledWith("previewAudio", { startSeconds: 0, durationSeconds: 4 });
      expect(requestFrame).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(150);
      expect(requestFrame).toHaveBeenCalledOnce();
      await started;
    } finally {
      player.dispose();
    }
  });

  it("warms audio without playing it, reuses it on pause, and refreshes a changed mix", async () => {
    const { resume } = stubAudioContext();
    vi.spyOn(fs.promises, "readFile").mockResolvedValue(Buffer.from([0]));
    const session = makeSession();
    const clip = session.transact("add music", "test", (ctx) => addMediaToTimeline(ctx, ctx.draft.media.med_music, {})).result;
    const end = compositionDuration(session.state);
    mocks.live.call.mockResolvedValue({ path: "/tmp/mix.wav", projectId: session.state.id });
    const audio = new PlaybackAudio();

    try {
      audio.warm(session.state, end, 0);
      expect(mocks.live.call).toHaveBeenCalledOnce();
      expect(resume).not.toHaveBeenCalled();
      audio.configure(session.state, end);
      await audio.prime(0);
      expect(resume).toHaveBeenCalledOnce();
      audio.stop();
      audio.configure(session.state, end);
      await audio.prime(0);
      expect(mocks.live.call).toHaveBeenCalledOnce();

      session.transact("change volume", "test", (ctx) => setSound(ctx, ctx.draft.elements[clip.id], { volume: 0.5 }));
      audio.configure(session.state, end);
      await audio.prime(0);
      expect(mocks.live.call).toHaveBeenCalledTimes(2);
    } finally {
      audio.dispose();
    }
  });

  it("primes the current playback position while an earlier warm-up is still pending", async () => {
    stubAudioContext();
    const read = vi.spyOn(fs.promises, "readFile").mockResolvedValue(Buffer.from([0]));
    const session = makeSession();
    session.transact("add music", "test", (ctx) => addMediaToTimeline(ctx, ctx.draft.media.med_music, {}));
    const end = compositionDuration(session.state);
    const old = Promise.withResolvers<{ path: string; projectId: string }>();
    mocks.live.call.mockReturnValueOnce(old.promise).mockResolvedValue({ path: "/tmp/current.wav", projectId: session.state.id });
    const audio = new PlaybackAudio();

    try {
      audio.warm(session.state, end, 0);
      audio.configure(session.state, end);
      await audio.prime(8);
      expect(mocks.live.call).toHaveBeenLastCalledWith("previewAudio", { startSeconds: 8, durationSeconds: 4 });
      expect(read).toHaveBeenCalledOnce();

      old.resolve({ path: "/tmp/previous.wav", projectId: session.state.id });
      await old.promise;
      expect(read).toHaveBeenCalledOnce();
    } finally {
      audio.dispose();
    }
  });
});
