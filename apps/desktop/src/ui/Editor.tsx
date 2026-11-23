import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ipcRenderer } from "electron";
import type { MediaIssue } from "@openedits/engine";
import { compositionDuration, mainTrack, clipBoundaries } from "@openedits/core";
import { FILE_MANAGER, live, selectedElements, useLive, WEB } from "./live.js";
import { ui, useUi, type UiState } from "./uiStore.js";
import { Dock, DOCK_LABEL, DOCK_RAIL, dockIcon, importFiles } from "./Dock.js";
import { Viewport, type ViewportApi } from "./Viewport.js";
import { Inspector } from "./Inspector.js";
import { Timeline } from "./Timeline.js";
import { actionFor, type ShortcutMapId } from "./shortcuts.js";
import { recorder } from "./recorder.js";
import { EditorIcon } from "./EditorIcon.js";
import { EditingCacheDialog } from "./EditingCacheDialog.js";

const compactEditor = "(max-width: 1000px)";
type SidePanel = "library" | "inspector";

export function Editor({ onHome, onOpenMcp }: { onHome: () => void; onOpenMcp: () => void }) {
  const s = useLive();
  const showGuides = useUi("showGuides");
  const showSocialSafeArea = useUi("showSocialSafeArea");
  const recordingTools = useUi("recorder");
  const exportOpen = useUi("exportOpen");
  const dockTab = useUi("dockTab");
  const project = s.project!;
  const viewport = useRef<ViewportApi>(null);
  const [shortcutMap, setShortcutMap] = useState<ShortcutMapId>("edits");
  const [compact, setCompact] = useState(() => matchMedia(compactEditor).matches);
  const [compactPanel, setCompactPanel] = useState<SidePanel | null>(null);
  const [widePanels, setWidePanels] = useState({ library: true, inspector: true });
  const libraryOpen = compact ? compactPanel === "library" : widePanels.library;
  const inspectorOpen = compact ? compactPanel === "inspector" : widePanels.inspector;
  const [job, setJob] = useState<ExportJob | null>(null);
  const [mediaCheck, setMediaCheck] = useState<MediaCheck | null>(null);
  const [exportPending, setExportPending] = useState(false);
  const [cacheOpen, setCacheOpen] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const libraryToggle = useRef<HTMLButtonElement>(null);
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const recorderBusy = useSyncExternalStore(recorder.subscribe, () => recorder.state.phase !== "idle");
  const exportActive = job?.status === "running" || job?.status === "queued";
  const seek = useCallback((time: number) => viewport.current?.player?.seek(time), []);

  useEffect(() => {
    const media = matchMedia(compactEditor);
    const update = () => setCompact(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);

  function showPanel(panel: SidePanel, open: boolean) {
    if (compact) setCompactPanel((current) => open ? panel : current === panel ? null : current);
    else setWidePanels((current) => ({ ...current, [panel]: open }));
  }

  function openTool(tab: UiState["dockTab"], toggle = false) {
    ui.set({ dockTab: tab });
    showPanel("library", !(toggle && libraryOpen && dockTab === tab));
  }

  function importMedia() {
    openTool("media");
    void importFiles().catch((error: Error) => live.toast("error", error.message));
  }

  const refreshMedia = useCallback(async () => {
    const before = live.state;
    try {
      const result = await live.call<MediaCheck>("checkExportMedia");
      if (live.state.project?.id === before.project?.id && live.state.version === before.version) setMediaCheck(result);
      return result;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (s.connected) void refreshMedia();
    const refresh = () => void refreshMedia();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [s.connected, s.version, exportOpen, refreshMedia]);

  const runExport = async (tool: "export" | "cancelRender", args: Record<string, unknown>) => {
    setExportPending(true);
    try {
      const result = await live.run<ExportJob>(tool, args);
      if (result) setJob(result);
      else if (tool === "export") await refreshMedia();
    } finally {
      setExportPending(false);
    }
  };

  const locateMedia = async (media: MediaIssue) => {
    const { version } = live.state;
    try {
      const extension = /\.([\w]+)$/.exec(media.name)?.[1];
      const files = await ipcRenderer.invoke("pick-files", {
        title: `Locate ${media.name}`, multi: false, ...(extension ? { extensions: [extension.toLowerCase()] } : {}),
      }) as string[];
      if (files[0]) {
        const result = await live.run("relinkMedia", { mediaId: media.mediaId, projectId: project.id, path: files[0], expectedVersion: version });
        if (result) await refreshMedia();
      }
    } catch (error) {
      live.toast("error", (error as Error).message);
    }
  };

  useEffect(() => {
    void live.call<{ shortcutMap: ShortcutMapId }>("getSettings").then((r) => setShortcutMap(r.shortcutMap)).catch(() => {});
    ui.set({ playhead: s.appState?.playheadSeconds ?? 0 });
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
      if (e.defaultPrevented || document.querySelector("dialog[open]")) return;
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
      <div className={mediaCheck?.missing.length ? "editor-shell has-media-notice" : "editor-shell"}>
        <header className="titlebar editor-titlebar">
          <button className="ghost back-projects" disabled={recorderBusy} onClick={() => {
            viewport.current?.player?.pause();
            onHome();
          }} aria-label="Home · Projects" title={recorderBusy ? "Finish the voiceover to return to Home" : "Home · Projects"}>
            <EditorIcon name="home" /><span>Home</span>
          </button>
          <div className="project-heading">
            <span className="name" title={project.name}>{project.name}</span>
            <span className="project-format muted small">{project.canvas.resolution} · {project.canvas.fps} fps</span>
          </div>
          <div className="spacer" />
          {(!s.connected || agentActive) && <span className="connection-status" role="status" title={s.lastChange?.label}>
            <i className={`status-dot ${s.connected ? "" : "off"}`} />
            <span>{!s.connected ? "Reconnecting" : agentActive ? `${s.lastChange!.source.replace(/^mcp:/, "")} is editing` : "Connected"}</span>
          </span>}
          <div className="editor-header-actions">
            <div className="editor-layout-actions">
              <button ref={libraryToggle} className={libraryOpen ? "on" : "ghost"} title="Library" aria-label="Library" aria-pressed={libraryOpen} aria-controls="editor-library" onClick={() => showPanel("library", !libraryOpen)}><EditorIcon name="library" /><span>Library</span></button>
              <button ref={inspectorToggle} className={inspectorOpen ? "on" : "ghost"} title="Inspector" aria-label="Inspector" aria-pressed={inspectorOpen} aria-controls="editor-inspector" onClick={() => showPanel("inspector", !inspectorOpen)}><EditorIcon name="inspector" /><span>Inspector</span></button>
            </div>
            <details className="editor-more" onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false;
            }} onKeyDown={(e) => {
              if (e.key !== "Escape" || !e.currentTarget.open) return;
              e.preventDefault();
              e.currentTarget.open = false;
              e.currentTarget.querySelector("summary")?.focus();
            }}>
              <summary title="Editor tools" aria-label="Editor tools"><EditorIcon name="more" /></summary>
              <div className="editor-menu">
                <label className="editor-format">Canvas aspect ratio
                  <select value={project.canvas.aspectRatio} onChange={(e) => void live.run("setCanvas", { aspectRatio: e.target.value })}>
                    {[...new Set([project.canvas.aspectRatio, "9:16", "16:9", "1:1", "4:5"])].map((a) => <option key={a}>{a}</option>)}
                  </select>
                </label>
                <button aria-pressed={showGuides} onClick={() => ui.set({ showGuides: !showGuides })}>Grid guides</button>
                {project.canvas.aspectRatio === "9:16" && <button aria-pressed={Boolean(showSocialSafeArea)} onClick={() => ui.set({ showSocialSafeArea: !showSocialSafeArea })}>Social safe area</button>}
                <button aria-haspopup="dialog" onClick={(e) => { e.currentTarget.closest("details")!.open = false; onOpenMcp(); }}>MCP settings</button>
                {!WEB && <button onClick={async (event) => {
                  event.currentTarget.closest("details")!.open = false;
                  try {
                    const destination = await ipcRenderer.invoke("pick-directory") as string | undefined;
                    if (!destination) return;
                    const result = await live.run<{ path: string }>("backupProject", { destination, projectId: project.id });
                    if (result) await ipcRenderer.invoke("reveal", result.path);
                  } catch (error) { live.toast("error", (error as Error).message); }
                }}>Back up project with media…</button>}
                <button aria-haspopup="dialog" onClick={(event) => { event.currentTarget.closest("details")!.open = false; setSaveTemplateOpen(true); }}>Save as template…</button>
                <button aria-pressed={Boolean(s.appState?.teleprompterOpen)} onClick={(e) => {
                  e.currentTarget.closest("details")!.open = false;
                  setCompactPanel(null);
                  void live.run("openTeleprompter", { open: !s.appState?.teleprompterOpen });
                }}>Teleprompter</button>
                <button onClick={(e) => {
                  e.currentTarget.closest("details")!.open = false;
                  setCacheOpen(true);
                }}>Editing cache</button>
              </div>
            </details>
            <button className="primary editor-export" onClick={() => ui.set({ exportOpen: true })}>
              <EditorIcon name="export" /> {exportActive ? `Export ${Math.round(job.progress * 100)}%` : "Export"}
            </button>
          </div>
        </header>
        <div className="editor-tools">
          <button className="import-media" disabled={!s.connected} onClick={importMedia} title="Import media" aria-label="Import media"><EditorIcon name="import" /><span>Import media</span></button>
          <nav className="tool-rail" aria-label="Media and effects">
            {DOCK_RAIL.map((tool) => {
              const active = libraryOpen && (dockTab === tool || (tool === "filters" && dockTab === "luts"));
              return <button key={tool} className={active ? "selected-tool" : "ghost"} title={DOCK_LABEL[tool]} aria-label={DOCK_LABEL[tool]} aria-pressed={active} aria-controls="editor-library" onClick={() => openTool(tool, true)}><EditorIcon name={dockIcon(tool)} /><span>{DOCK_LABEL[tool]}</span></button>;
            })}
            <button className={recordingTools ? "selected-tool" : "ghost"} title="Voiceover" aria-label="Voiceover" aria-pressed={recordingTools} onClick={() => {
              setCompactPanel(null);
              ui.set({ recorder: !recordingTools });
            }}><EditorIcon name="voice" /><span>Voiceover</span></button>
          </nav>
          <ToolSearch onOpen={openTool} />
        </div>
        {!!mediaCheck?.missing.length && (
          <div className="media-notice" role="status">
            <span>{mediaCheck.missing.length === 1 ? "1 source file is missing." : `${mediaCheck.missing.length} source files are missing.`}</span>
            <button onClick={() => ui.set({ exportOpen: true })}>Locate media</button>
          </div>
        )}
        <div className={`editor${libraryOpen ? " with-library" : ""}${inspectorOpen ? " with-inspector" : ""}`}>
          <aside id="editor-library" className="editor-library" aria-label="Library" hidden={!libraryOpen}>
            {libraryOpen && <Dock audition={(start, end) => {
              const player = viewport.current?.player;
              player?.seek(start);
              void player?.play(end);
            }} onClose={() => { showPanel("library", false); libraryToggle.current?.focus(); }} onEditTitle={async (elementId) => {
              if (await live.run("setSelection", { elementIds: [elementId] })) {
                ui.set({ panel: "textEdit", focusTitleId: elementId });
                showPanel("inspector", true);
              }
            }} />}
          </aside>
          <Viewport ref={viewport} blocked={compact && compactPanel !== null} onOpenEditingCache={() => setCacheOpen(true)} onImportMedia={importMedia} />
          <aside id="editor-inspector" className="editor-inspector" aria-label="Inspector" hidden={!inspectorOpen}>
            {compact && inspectorOpen && <button className="icon ghost close-inspector" aria-label="Close inspector" title="Close inspector" onClick={() => {
              showPanel("inspector", false);
              inspectorToggle.current?.focus();
            }}><EditorIcon name="close" /></button>}
            {inspectorOpen && <Inspector key={selected.map((e) => e.id).join(",")} />}
          </aside>
          {compact && compactPanel && <button className="panel-scrim" tabIndex={-1} aria-hidden="true" onClick={() => setCompactPanel(null)} />}
          <Timeline onSeek={seek} />
        </div>
      </div>
      {exportOpen && <ExportDialog job={job} pending={exportPending} runJob={runExport} check={mediaCheck} locateMedia={locateMedia} refreshMedia={refreshMedia} onClose={() => ui.set({ exportOpen: false })} />}
      <EditingCacheDialog open={cacheOpen} onClose={() => setCacheOpen(false)} />
      {saveTemplateOpen && <SaveTemplateDialog name={project.name} onClose={() => setSaveTemplateOpen(false)} />}
    </>
  );
}

function SaveTemplateDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="dialog export-dialog" ref={dialog} aria-labelledby="template-title" onClose={onClose}>
    <h3 id="template-title">Save as template</h3>
    <p className="muted small">Reuse titles, image overlays, music, caption style, and export settings. Add new footage in each project.</p>
    <form onSubmit={async (event) => {
      event.preventDefault();
      const label = String(new FormData(event.currentTarget).get("name") ?? "").trim();
      if (!label) return;
      setBusy(true);
      try {
        if (await live.run("saveProjectTemplate", { name: label })) {
          live.toast("info", "Template saved to Home.");
          dialog.current?.close();
        }
      } finally { setBusy(false); }
    }}>
      <label className="field wide"><span>Template name</span><input name="name" defaultValue={name.slice(0, 80)} maxLength={80} required autoFocus /></label>
      <div className="row export-actions">
        <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
        <button className="primary" disabled={busy}>Save template</button>
      </div>
    </form>
  </dialog>;
}

function ToolSearch({ onOpen }: { onOpen: (tab: UiState["dockTab"]) => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const available = [...DOCK_RAIL, "luts" as const].filter((tool) => DOCK_LABEL[tool].toLowerCase().includes(query.toLowerCase().trim()));
  function pick(tab: UiState["dockTab"]) {
    onOpen(tab);
    setQuery("");
    setOpen(false);
  }
  return (
    <div className="editor-tool-search" onBlur={(e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
    }}>
      <EditorIcon name="search" />
      <input
        type="search"
        placeholder="Find a tool"
        aria-label="Find a tool"
        aria-expanded={open}
        aria-controls="editor-tool-results"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "Enter" && open && available[0]) pick(available[0]);
        }}
      />
      <div id="editor-tool-results" className="editor-menu" hidden={!open}>
        {available.map((tool) => <button key={tool} onClick={() => pick(tool)}><EditorIcon name={dockIcon(tool)} /> {DOCK_LABEL[tool]}</button>)}
        {!available.length && <div className="muted small">No tools found</div>}
      </div>
    </div>
  );
}

type ExportJob = { jobId: string; status: string; progress: number; message?: string; output?: { path: string; warnings?: string[] }; error?: { message: string } };
type MediaCheck = { missing: MediaIssue[]; hdr: MediaIssue[] };

function ExportDialog({ job, pending, runJob, check, locateMedia, refreshMedia, onClose }: {
  job: ExportJob | null;
  pending: boolean;
  runJob: (tool: "export" | "cancelRender", args: Record<string, unknown>) => Promise<void>;
  check: MediaCheck | null;
  locateMedia: (media: MediaIssue) => Promise<void>;
  refreshMedia: () => Promise<MediaCheck | null>;
  onClose: () => void;
}) {
  const s = useLive();
  const settings = s.project!.exportSettings;
  const [preset, setPreset] = useState<"custom" | "fast-720p" | "fast-1080p">("custom");
  const [locating, setLocating] = useState(false);
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
          <span>Preset</span>
          <select value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}>
            <option value="custom">Project settings</option>
            <option value="fast-720p">Fast Export · 720p</option>
            <option value="fast-1080p">{s.project?.canvas.aspectRatio === "9:16" ? "Social · 1080p vertical MP4" : "Fast Export · 1080p"}</option>
          </select>
        </label>
        {preset === "custom" ? <>
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
        </> : <p className="muted small">H.264 MP4 at 30 fps with faster encoding.</p>}
        <div className="field wide">
          <span>Captions</span>
          <label className="row">
            <input type="checkbox" checked={settings.burnInCaptions} onChange={(e) => set({ burnInCaptions: e.target.checked })} /> Burn in
          </label>
        </div>
      </fieldset>
      {!!check?.missing.length && <div className="export-missing" aria-label="Missing media">
        <p role="status">Locate these files to export the complete video.</p>
        <ul>
          {check.missing.map((media) => (
            <li key={media.mediaId}><span title={media.path}>{media.name}</span>
              <button disabled={working || pending || locating || !media.path} aria-label={`Locate ${media.name}`} onClick={async () => {
                setLocating(true);
                try { await locateMedia(media); } finally { setLocating(false); }
              }}>Locate…</button>
            </li>
          ))}
        </ul>
        <button disabled={locating || pending} onClick={() => void refreshMedia()}>Check again</button>
      </div>}
      {!!check?.hdr.length && <p className="muted small">HDR footage in this edit will export as SDR without tone mapping. Colors may look different.</p>}
      {job && (
        <div className="export-status">
          {working && <progress aria-label="Export progress" max={1} value={job.progress} />}
          <span role="status">
            {job.status === "done" ? "Video ready" : job.status === "failed" ? job.error?.message ?? "Export failed" : job.status === "cancelled" ? "Export cancelled" : job.message ?? "Preparing export…"}
          </span>
        </div>
      )}
      {!!job?.output?.warnings?.length && <details className="export-status">
        <summary>{job.output.warnings.length} export {job.output.warnings.length === 1 ? "warning" : "warnings"}</summary>
        <ul>{job.output.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
      </details>}
      <div className="row export-actions">
        <button onClick={() => dialog.current?.close()}>{working ? "Hide" : "Close"}</button>
        {working && <button className="danger" disabled={pending} onClick={() => void runJob("cancelRender", { jobId: job.jobId })}>Cancel export</button>}
        {!working && <button className={job?.status === "done" ? "" : "primary"} disabled={pending || locating || !!check?.missing.length} onClick={() => void runJob("export", preset === "custom" ? {} : { preset })}>Export</button>}
        {job?.status === "done" && job.output && <button className="primary" onClick={() => void import("electron").then(({ ipcRenderer }) => ipcRenderer.invoke("reveal", job.output!.path)).catch((error: Error) => live.toast("error", error.message))}>{WEB ? "Download" : `Show in ${FILE_MANAGER}`}</button>}
        {job?.status === "done" && job.output && WEB && window.__openedits?.android && <button onClick={() => void ipcRenderer.invoke("share-export", job.output!.path).catch((error: Error) => live.toast("error", error.message))}>Save and share</button>}
      </div>
    </dialog>
  );
}
