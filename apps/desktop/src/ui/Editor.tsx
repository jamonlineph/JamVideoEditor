import { useEffect, useRef, useState } from "react";
import { compositionDuration, mainTrack, clipBoundaries } from "@openedits/core";
import { live, selectedElements, useLive } from "./live.js";
import { ui, useUi } from "./uiStore.js";
import { Dock } from "./Dock.js";
import { Viewport, type ViewportApi } from "./Viewport.js";
import { Inspector } from "./Inspector.js";
import { Timeline } from "./Timeline.js";
import { actionFor, type ShortcutMapId } from "./shortcuts.js";
import { recorder } from "./recorder.js";

export function Editor() {
  const s = useLive();
  const u = useUi();
  const project = s.project!;
  const viewport = useRef<ViewportApi>(null);
  const [shortcutMap, setShortcutMap] = useState<ShortcutMapId>("edits");

  useEffect(() => {
    void live.call<{ shortcutMap: ShortcutMapId }>("getSettings").then((r) => setShortcutMap(r.shortcutMap)).catch(() => {});
    ui.set({ playhead: s.appState?.playheadSeconds ?? 0 });
    // The engine asks this window to record voiceovers for agents (start/stopVoiceoverRecording).
    live.onUi(async (command, args) => {
      if (command === "startRecording") return recorder.start(args as { start?: number; preRollSeconds?: number });
      if (command === "stopRecording") return recorder.stop();
      throw new Error(`Unknown request ${command}`);
    });
  }, []);

  // Follow playhead moves made by agents (or another window) while not playing.
  const enginePlayhead = s.appState?.playheadSeconds;
  useEffect(() => {
    if (enginePlayhead === undefined || ui.get().playing) return;
    if (Math.abs(enginePlayhead - ui.get().playhead) > 1e-4) ui.set({ playhead: enginePlayhead });
  }, [enginePlayhead]);

  // Keyboard shortcuts (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      const action = actionFor(shortcutMap, e);
      if (!action) return;
      e.preventDefault();
      const st = live.state;
      const p = st.project;
      if (!p) return;
      const fps = p.canvas.fps;
      const sel = st.appState?.selection.elementIds ?? [];
      const ph = ui.get().playhead;
      const player = viewport.current?.player;
      switch (action) {
        case "playPause":
          player?.toggle();
          break;
        case "split": {
          // Split the selection at the playhead, or everything under it on the main track.
          const targets = sel.length ? sel : mainTrack(p).elementIds;
          void live.run("splitAt", { times: [ph], elementIds: targets });
          break;
        }
        case "delete":
          if (sel.length) void live.run("delete", { elementIds: sel });
          break;
        case "undo":
          void live.run("undo");
          break;
        case "redo":
          void live.run("redo");
          break;
        case "stepBack":
          player?.seek(ph - 1 / fps);
          break;
        case "stepForward":
          player?.seek(ph + 1 / fps);
          break;
        case "prevEdit": {
          const b = clipBoundaries(p).filter((x) => x < ph - 1e-3);
          player?.seek(b.length ? b[b.length - 1] : 0);
          break;
        }
        case "nextEdit": {
          const b = clipBoundaries(p).find((x) => x > ph + 1e-3);
          if (b !== undefined) player?.seek(b);
          break;
        }
        case "duplicate":
          if (sel.length === 1) void live.run("duplicate", { elementId: sel[0] });
          break;
        case "zoomIn":
          ui.set({ pxPerSecond: Math.min(800, ui.get().pxPerSecond * 1.25) });
          break;
        case "zoomOut":
          ui.set({ pxPerSecond: Math.max(4, ui.get().pxPerSecond / 1.25) });
          break;
        case "toggleSnapping":
          void live.run("setRippleTiers", { snappingEnabled: !p.rippleSettings.snappingEnabled });
          break;
        case "toggleMagnet":
          void live.run("setRippleTiers", { magnetEnabled: !p.rippleSettings.magnetEnabled });
          break;
        case "goToStart":
          player?.seek(0);
          break;
        case "goToEnd":
          player?.seek(compositionDuration(p));
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    const onMenu = (e: Event) => {
      const a = (e as CustomEvent<string>).detail;
      if (a === "export") ui.set({ exportOpen: true });
    };
    window.addEventListener("menu", onMenu);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("menu", onMenu);
    };
  }, [shortcutMap]);

  const agentActive = s.lastChange && s.lastChange.source !== "ui" && Date.now() - s.lastChange.at < 8000;
  const selected = selectedElements(s);

  return (
    <>
      <div className="titlebar">
        <button className="ghost" onClick={() => void live.run("closeProject")} title="Back to projects">
          ‹ Projects
        </button>
        <span className="name">{project.name}</span>
        <span className="muted small">
          {project.canvas.aspectRatio} · {project.canvas.resolution} · {project.canvas.fps} fps
        </span>
        <div className="spacer" />
        {agentActive && (
          <span className="small" style={{ color: "var(--ok)" }} title={s.lastChange!.label}>
            ● {s.lastChange!.source.replace(/^mcp:/, "")} is editing
          </span>
        )}
        <button className="icon" title="Undo" onClick={() => void live.run("undo")}>
          ↶
        </button>
        <button className="icon" title="Redo" onClick={() => void live.run("redo")}>
          ↷
        </button>
        <select value={project.canvas.aspectRatio} onChange={(e) => void live.run("setCanvas", { aspectRatio: e.target.value })} title="Canvas aspect ratio">
          {["9:16", "16:9", "1:1", "4:5"].map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <button className={u.showGuides ? "on" : ""} onClick={() => ui.set({ showGuides: !u.showGuides })} title="10% grid guides">
          Grid
        </button>
        <button
          className={s.appState?.teleprompterOpen ? "on" : ""}
          onClick={() => void live.run("openTeleprompter", { open: !s.appState?.teleprompterOpen })}
          title="Teleprompter"
        >
          Prompter
        </button>
        <button className={u.recorder ? "on" : ""} onClick={() => ui.set({ recorder: !u.recorder })} title="Record voiceover">
          🎙 Voiceover
        </button>
        <button className="primary" onClick={() => ui.set({ exportOpen: true })}>
          Export
        </button>
      </div>
      <div className="editor">
        <Dock />
        <Viewport ref={viewport} />
        <Inspector key={selected.map((e) => e.id).join(",")} />
        <Timeline onSeek={(t) => viewport.current?.player?.seek(t)} />
      </div>
      {u.exportOpen && <ExportDialog onClose={() => ui.set({ exportOpen: false })} />}
    </>
  );
}

function ExportDialog({ onClose }: { onClose: () => void }) {
  const s = useLive();
  const settings = s.project!.exportSettings;
  const [job, setJob] = useState<{ jobId: string; status: string; progress: number; message?: string; output?: { path: string }; error?: { message: string } } | null>(null);
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = setInterval(async () => {
      const r = await live.call<typeof job>("exportStatus", { jobId: job!.jobId }).catch(() => null);
      if (r) setJob(r);
    }, 500);
    return () => clearInterval(t);
  }, [job?.jobId, job?.status]);
  const set = (patch: Record<string, unknown>) => void live.run("setExportSettings", patch);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Export</h3>
        <div className="field wide">
          <label>Resolution</label>
          <select value={settings.resolution} onChange={(e) => set({ resolution: e.target.value })}>
            {["720p", "1080p", "4K"].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </div>
        <div className="field wide">
          <label>Frame rate</label>
          <select value={settings.fps} onChange={(e) => set({ fps: Number(e.target.value) })}>
            {[24, 25, 30, 50, 60].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </div>
        <div className="field wide">
          <label>Codec</label>
          <select value={settings.codec} onChange={(e) => set({ codec: e.target.value })}>
            <option value="h264">H.264</option>
            <option value="hevc">HEVC</option>
            <option value="prores">ProRes</option>
          </select>
        </div>
        <div className="field wide">
          <label>Quality</label>
          <select value={settings.quality} onChange={(e) => set({ quality: e.target.value })}>
            {["low", "medium", "high", "max"].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </div>
        <div className="field wide">
          <label>Captions</label>
          <label className="row">
            <input type="checkbox" checked={settings.burnInCaptions} onChange={(e) => set({ burnInCaptions: e.target.checked })} /> Burn in
          </label>
        </div>
        {job && (
          <>
            <div className="progress">
              <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
            </div>
            <div className="muted small">
              {job.status === "done" ? `Saved to ${job.output?.path}` : job.status === "failed" ? job.error?.message : job.message ?? "Starting…"}
            </div>
          </>
        )}
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          {job?.status === "done" && <button onClick={() => void import("electron").then(({ ipcRenderer }) => ipcRenderer.invoke("reveal", job.output!.path))}>Show in Finder</button>}
          <button onClick={onClose}>Close</button>
          <button className="primary" disabled={job?.status === "running"} onClick={async () => setJob((await live.run<typeof job>("export", {})) ?? null)}>
            {job?.status === "running" ? "Exporting…" : "Export"}
          </button>
        </div>
      </div>
    </div>
  );
}
