import { useCallback, useEffect, useRef, useState } from "react";
import { compositionDuration, mainTrack, clipBoundaries } from "@openedits/core";
import { FILE_MANAGER, live, selectedElements, useLive, WEB } from "./live.js";
import { ui, useUi } from "./uiStore.js";
import { Dock, importFiles } from "./Dock.js";
import { Viewport, type ViewportApi } from "./Viewport.js";
import { Inspector } from "./Inspector.js";
import { Timeline } from "./Timeline.js";
import { actionFor, type ShortcutMapId } from "./shortcuts.js";
import { recorder } from "./recorder.js";

const compactEditor = "(max-width: 1080px)";
type SidePanel = "library" | "inspector";

export function Editor() {
  const s = useLive();
  const showGuides = useUi("showGuides");
  const recordingTools = useUi("recorder");
  const exportOpen = useUi("exportOpen");
  const project = s.project!;
  const viewport = useRef<ViewportApi>(null);
  const [shortcutMap, setShortcutMap] = useState<ShortcutMapId>("edits");
  const [compact, setCompact] = useState(() => matchMedia(compactEditor).matches);
  const [compactPanel, setCompactPanel] = useState<SidePanel | null>(null);
  const [widePanels, setWidePanels] = useState({ library: true, inspector: true });
  const libraryOpen = compact ? compactPanel === "library" : widePanels.library;
  const inspectorOpen = compact ? compactPanel === "inspector" : widePanels.inspector;
  const [job, setJob] = useState<ExportJob | null>(null);
  const [exportPending, setExportPending] = useState(false);
  const libraryToggle = useRef<HTMLButtonElement>(null);
  const exportActive = job?.status === "running" || job?.status === "queued";
  const seek = useCallback((time: number) => viewport.current?.player?.seek(time), []);

  useEffect(() => {
    const media = matchMedia(compactEditor);
    const update = () => setCompact(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);

  function togglePanel(panel: SidePanel) {
    if (compact) setCompactPanel((current) => current === panel ? null : panel);
    else setWidePanels((current) => ({ ...current, [panel]: !current[panel] }));
  }

  const runExport = async (tool: "export" | "cancelRender", args: Record<string, unknown>) => {
    setExportPending(true);
    try {
      const result = await live.run<ExportJob>(tool, args);
      if (result) setJob(result);
    } finally {
      setExportPending(false);
    }
  };

  useEffect(() => {
    void live.call<{ shortcutMap: ShortcutMapId }>("getSettings").then((r) => setShortcutMap(r.shortcutMap)).catch(() => {});
    ui.set({ playhead: s.appState?.playheadSeconds ?? 0 });
    // The engine asks this window to record voiceovers for agents (start/stopVoiceoverRecording).
    live.onUi(async (command, args) => {
      if (command === "startRecording") return recorder.start(args as { start?: number; preRollSeconds?: number });
      if (command === "stopRecording") return recorder.stop();
      throw new Error(`Unknown request ${command}`);
    });
    return () => ui.set({ exportOpen: false, recorder: false });
  }, []);

  useEffect(() => {
    let mounted = true;
    void live.call<ExportJob>("exportStatus").then((latest) => {
      if (mounted) setJob((current) => current ?? latest);
    }).catch(() => {});
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!exportActive || !job) return;
    const { jobId } = job;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const status = await live.call<ExportJob>("exportStatus", { jobId }).catch(() => null);
      if (!active) return;
      if (status) setJob((current) => current?.jobId === jobId && (current.status === "running" || current.status === "queued") ? status : current);
      if (!status || status.status === "queued" || status.status === "running") timer = setTimeout(poll, 750);
    };
    timer = setTimeout(poll, 750);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [exportActive, job?.jobId]);

  // Follow playhead moves made by agents (or another window) while not playing.
  const enginePlayhead = s.appState?.playheadSeconds;
  useEffect(() => {
    if (enginePlayhead === undefined || ui.get().playing) return;
    if (Math.abs(enginePlayhead - ui.get().playhead) > 1e-4) ui.set({ playhead: enginePlayhead });
  }, [enginePlayhead]);

  // Keyboard shortcuts (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (ui.get().exportOpen || e.defaultPrevented) return;
      if (e.key === "Escape") setCompactPanel(null);
      if (t?.closest("input, textarea, select, [contenteditable=true]")) return;
      if ((e.key === " " || e.key === "Enter") && t?.closest("button, summary")) return;
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
          ui.set({ pxPerSecond: Math.max(0.05, ui.get().pxPerSecond / 1.25) });
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
      if (a === "import") void importFiles();
    };
    window.addEventListener("menu", onMenu);
    const onSeek = (e: Event) => viewport.current?.player?.seek((e as CustomEvent<number>).detail);
    window.addEventListener("openedits-seek", onSeek);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("menu", onMenu);
      window.removeEventListener("openedits-seek", onSeek);
    };
  }, [shortcutMap]);

  const agentActive = s.lastChange && s.lastChange.source !== "ui" && Date.now() - s.lastChange.at < 8000;
  const selected = selectedElements(s);

  return (
    <>
      <div className="editor-shell">
        <header className="titlebar editor-titlebar">
          <button className="ghost back-projects" onClick={() => void live.run("closeProject")} aria-label="Back to projects" title="Back to projects">
            ‹ <span>Projects</span>
          </button>
          <div className="project-heading">
            <span className="name" title={project.name}>{project.name}</span>
            <span className="project-format muted small">{project.canvas.resolution} · {project.canvas.fps} fps</span>
          </div>
          <div className="spacer" />
          <span className="connection-status" role="status" title={s.lastChange?.label}>
            <i className={`status-dot ${s.connected ? "" : "off"}`} />
            <span>{!s.connected ? "Reconnecting" : agentActive ? `${s.lastChange!.source.replace(/^mcp:/, "")} is editing` : "Engine connected"}</span>
          </span>
          <button className="primary" onClick={() => ui.set({ exportOpen: true })}>
            {exportActive ? `Export ${Math.round(job.progress * 100)}%` : "Export"}
          </button>
        </header>
        <nav className="editor-toolbar" aria-label="Editor tools">
          <div className="segmented">
            <button ref={libraryToggle} className={libraryOpen ? "on" : ""} aria-pressed={libraryOpen} aria-controls="editor-library" onClick={() => togglePanel("library")}>Library</button>
            <button className={inspectorOpen ? "on" : ""} aria-pressed={inspectorOpen} aria-controls="editor-inspector" onClick={() => togglePanel("inspector")}>Inspector</button>
          </div>
          <div className="editor-history">
            <button className="icon ghost" aria-label="Undo" title="Undo" onClick={() => void live.run("undo")}>↶</button>
            <button className="icon ghost" aria-label="Redo" title="Redo" onClick={() => void live.run("redo")}>↷</button>
          </div>
          <div className="toolbar-space" />
          <select value={project.canvas.aspectRatio} onChange={(e) => void live.run("setCanvas", { aspectRatio: e.target.value })} aria-label="Canvas aspect ratio" title="Canvas aspect ratio">
            {["9:16", "16:9", "1:1", "4:5"].map((a) => <option key={a}>{a}</option>)}
          </select>
          <details className="editor-more" onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false;
          }} onKeyDown={(e) => {
            if (e.key !== "Escape" || !e.currentTarget.open) return;
            e.preventDefault();
            e.currentTarget.open = false;
            e.currentTarget.querySelector("summary")?.focus();
          }}>
            <summary>Tools</summary>
            <div className="editor-menu">
              <button aria-pressed={showGuides} onClick={() => ui.set({ showGuides: !showGuides })}>Grid guides</button>
              <button aria-pressed={Boolean(s.appState?.teleprompterOpen)} onClick={(e) => {
                e.currentTarget.closest("details")!.open = false;
                setCompactPanel(null);
                void live.run("openTeleprompter", { open: !s.appState?.teleprompterOpen });
              }}>Teleprompter</button>
              <button aria-pressed={recordingTools} onClick={(e) => {
                e.currentTarget.closest("details")!.open = false;
                setCompactPanel(null);
                ui.set({ recorder: !recordingTools });
              }}>Voiceover</button>
            </div>
          </details>
        </nav>
        <div className={`editor${libraryOpen ? " with-library" : ""}${inspectorOpen ? " with-inspector" : ""}`}>
          <aside id="editor-library" className="editor-library" aria-label="Library" hidden={!libraryOpen}><Dock /></aside>
          <Viewport ref={viewport} onOpenLibrary={() => {
            if (compact) setCompactPanel("library");
            else setWidePanels((current) => ({ ...current, library: true }));
            libraryToggle.current?.focus();
          }} />
          <aside id="editor-inspector" className="editor-inspector" aria-label="Inspector" hidden={!inspectorOpen}>
            {inspectorOpen && <Inspector key={selected.map((e) => e.id).join(",")} />}
          </aside>
          {compact && compactPanel && <button className="panel-scrim" tabIndex={-1} aria-label={`Close ${compactPanel}`} onClick={() => setCompactPanel(null)} />}
          <Timeline onSeek={seek} />
        </div>
      </div>
      {exportOpen && <ExportDialog job={job} pending={exportPending} runJob={runExport} onClose={() => ui.set({ exportOpen: false })} />}
    </>
  );
}

type ExportJob = { jobId: string; status: string; progress: number; message?: string; output?: { path: string }; error?: { message: string } };

function ExportDialog({ job, pending, runJob, onClose }: {
  job: ExportJob | null;
  pending: boolean;
  runJob: (tool: "export" | "cancelRender", args: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const s = useLive();
  const settings = s.project!.exportSettings;
  const dialog = useRef<HTMLDialogElement>(null);
  const working = job?.status === "queued" || job?.status === "running";
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const set = (patch: Record<string, unknown>) => void live.run("setExportSettings", patch);
  return (
    <dialog className="dialog export-dialog" ref={dialog} onClose={onClose} aria-labelledby="export-title">
      <h3 id="export-title">Export video</h3>
      <fieldset disabled={working || pending}>
        <label className="field wide">
          <span>Resolution</span>
          <select value={settings.resolution} onChange={(e) => set({ resolution: e.target.value })}>
            {["720p", "1080p", "4K"].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className="field wide">
          <span>Frame rate</span>
          <select value={settings.fps} onChange={(e) => set({ fps: Number(e.target.value) })}>
            {[24, 25, 30, 50, 60].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className="field wide">
          <span>Codec</span>
          <select value={settings.codec} onChange={(e) => set({ codec: e.target.value })}>
            <option value="h264">H.264</option>
            <option value="hevc">HEVC</option>
            <option value="prores">ProRes</option>
          </select>
        </label>
        <label className="field wide">
          <span>Quality</span>
          <select value={settings.quality} onChange={(e) => set({ quality: e.target.value })}>
            {["low", "medium", "high", "max"].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <div className="field wide">
          <span>Captions</span>
          <label className="row">
            <input type="checkbox" checked={settings.burnInCaptions} onChange={(e) => set({ burnInCaptions: e.target.checked })} /> Burn in
          </label>
        </div>
      </fieldset>
      {job && (
        <div className="export-status">
          {working && <progress aria-label="Export progress" max={1} value={job.progress} />}
          <span role="status">
            {job.status === "done" ? "Video ready" : job.status === "failed" ? job.error?.message ?? "Export failed" : job.status === "cancelled" ? "Export cancelled" : job.message ?? "Preparing export…"}
          </span>
        </div>
      )}
      <div className="row export-actions">
        <button onClick={() => dialog.current?.close()}>{working ? "Hide" : "Close"}</button>
        {working && <button className="danger" disabled={pending} onClick={() => void runJob("cancelRender", { jobId: job.jobId })}>Cancel export</button>}
        {!working && <button className={job?.status === "done" ? "" : "primary"} disabled={pending} onClick={() => void runJob("export", {})}>Export</button>}
        {job?.status === "done" && job.output && <button className="primary" onClick={() => void import("electron").then(({ ipcRenderer }) => ipcRenderer.invoke("reveal", job.output!.path)).catch((error: Error) => live.toast("error", error.message))}>{WEB ? "Download" : `Show in ${FILE_MANAGER}`}</button>}
      </div>
    </dialog>
  );
}
