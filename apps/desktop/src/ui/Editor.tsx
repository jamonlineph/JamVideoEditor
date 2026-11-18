import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { compositionDuration, mainTrack, clipBoundaries } from "@openedits/core";
import { FILE_MANAGER, live, selectedElements, useLive, WEB } from "./live.js";
import { ui, useUi, DOCK_TABS, type DockTab, type Sheet } from "./uiStore.js";
import { Dock, DockPane, DOCK_LABELS, importFiles } from "./Dock.js";
import { Viewport, type ViewportApi } from "./Viewport.js";
import { Inspector, tabsFor, PROP_TABS } from "./Inspector.js";
import { Timeline } from "./Timeline.js";
import { actionFor, SHORTCUT_MAPS, type ShortcutMapId } from "./shortcuts.js";
import { recorder } from "./recorder.js";
import { Icon } from "./Icon.js";

/** Phone-sized windows (the Android app, a narrow browser): Edits-style tool bar and bottom sheets. */
const compactEditor = "(max-width: 900px)";
const TIMELINE_KEY = "openedits.timelineHeight";

function storedHeight() {
  try {
    const v = Number(localStorage.getItem(TIMELINE_KEY));
    return v >= 160 && v <= 900 ? v : 300;
  } catch {
    return 300;
  }
}

export function Editor() {
  const s = useLive();
  const recordingTools = useUi("recorder");
  const exportOpen = useUi("exportOpen");
  const sheet = useUi("sheet");
  const project = s.project!;
  const viewport = useRef<ViewportApi>(null);
  const [shortcutMap, setShortcutMap] = useState<ShortcutMapId>("edits");
  const [compact, setCompact] = useState(() => matchMedia(compactEditor).matches);
  const [timelineH, setTimelineH] = useState(storedHeight);
  const [renaming, setRenaming] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [job, setJob] = useState<ExportJob | null>(null);
  const [exportPending, setExportPending] = useState(false);
  const exportActive = job?.status === "running" || job?.status === "queued";
  const seek = useCallback((time: number) => viewport.current?.player?.seek(time), []);

  useEffect(() => {
    const media = matchMedia(compactEditor);
    const update = () => setCompact(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!compact && sheet) ui.set({ sheet: null });
  }, [compact]);

  // Other parts of the UI ask for a library tab or a properties tab (timeline buttons, toolbar).
  useEffect(() => {
    const onDock = (e: Event) => {
      const tab = (e as CustomEvent<DockTab>).detail;
      if (matchMedia(compactEditor).matches) ui.set({ sheet: { kind: "dock", tab } });
      else ui.set({ dockTab: tab });
    };
    const onProps = (e: Event) => {
      const tab = (e as CustomEvent<string>).detail;
      if (matchMedia(compactEditor).matches) ui.set({ sheet: { kind: "inspector", tab } });
      else ui.set({ panel: tab });
    };
    window.addEventListener("openedits-dock", onDock);
    window.addEventListener("openedits-props", onProps);
    return () => {
      window.removeEventListener("openedits-dock", onDock);
      window.removeEventListener("openedits-props", onProps);
    };
  }, []);

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
    return () => ui.set({ exportOpen: false, recorder: false, sheet: null });
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
      if (e.key === "Escape") {
        if (ui.get().sheet) ui.set({ sheet: null });
        setHelpOpen(false);
      }
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

  const startResize = (e: React.PointerEvent) => {
    const startY = e.clientY;
    const base = timelineH;
    const move = (ev: PointerEvent) => setTimelineH(Math.max(160, Math.min(window.innerHeight - 260, base - (ev.clientY - startY))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setTimelineH((h) => {
        try {
          localStorage.setItem(TIMELINE_KEY, String(Math.round(h)));
        } catch {
          /* storage unavailable */
        }
        return h;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <>
      <div className={`editor-shell${compact ? " compact" : ""}`}>
        <header className="titlebar editor-titlebar">
          <button className="ghost back-projects" onClick={() => void live.run("closeProject", { poster: true })} aria-label="Back to projects" title="Back to projects">
            <Icon name="back" size={18} /> <span>Projects</span>
          </button>
          <div className="project-heading">
            {renaming ? (
              <input
                className="rename"
                autoFocus
                defaultValue={project.name}
                aria-label="Project name"
                onBlur={(e) => {
                  setRenaming(false);
                  const name = e.target.value.trim();
                  if (name && name !== project.name) void live.run("renameProject", { projectId: project.id, name });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setRenaming(false);
                }}
              />
            ) : (
              <button className="name ghost" title="Rename" onClick={() => setRenaming(true)}>{project.name}</button>
            )}
            <span className="project-format muted small">{project.canvas.aspectRatio} · {project.canvas.resolution} · {project.canvas.fps} fps</span>
          </div>
          <div className="spacer" />
          <span className="connection-status" role="status" title={s.lastChange?.label}>
            <i className={`status-dot ${s.connected ? "" : "off"}`} />
            <span>{!s.connected ? "Reconnecting" : agentActive ? `${s.lastChange!.source.replace(/^mcp:/, "")} is editing` : "Saved"}</span>
          </span>
          <details className="editor-more" onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false;
          }} onKeyDown={(e) => {
            if (e.key !== "Escape" || !e.currentTarget.open) return;
            e.preventDefault();
            e.currentTarget.open = false;
            e.currentTarget.querySelector("summary")?.focus();
          }}>
            <summary aria-label="Tools" title="Tools"><Icon name="more" size={18} /><span className="label">Tools</span></summary>
            <div className="editor-menu">
              <button aria-pressed={Boolean(s.appState?.teleprompterOpen)} onClick={(e) => {
                e.currentTarget.closest("details")!.open = false;
                ui.set({ sheet: null });
                void live.run("openTeleprompter", { open: !s.appState?.teleprompterOpen });
              }}><Icon name="teleprompter" size={16} /> Teleprompter</button>
              <button aria-pressed={recordingTools} onClick={(e) => {
                e.currentTarget.closest("details")!.open = false;
                ui.set({ sheet: null, recorder: !recordingTools });
              }}><Icon name="mic" size={16} /> Voiceover</button>
              <button onClick={(e) => {
                e.currentTarget.closest("details")!.open = false;
                setHelpOpen(true);
              }}><Icon name="keyboard" size={16} /> Keyboard shortcuts</button>
            </div>
          </details>
          <button className="primary export-btn" onClick={() => ui.set({ exportOpen: true })}>
            <Icon name="export" size={16} />
            <span>{exportActive ? `Exporting ${Math.round(job.progress * 100)}%` : "Export"}</span>
          </button>
        </header>
        <div className={`editor${compact ? " compact" : ""}`} style={compact ? undefined : { gridTemplateRows: `minmax(0, 1fr) 6px ${timelineH}px` }}>
          {!compact && <aside id="editor-library" className="editor-library" aria-label="Library"><Dock /></aside>}
          <Viewport ref={viewport} onOpenLibrary={() => {
            if (compact) ui.set({ sheet: { kind: "dock", tab: "media" } });
            else ui.set({ dockTab: "media" });
          }} />
          {!compact && (
            <aside id="editor-inspector" className="editor-inspector" aria-label="Properties">
              <Inspector key={selected.map((e) => e.id).join(",")} />
            </aside>
          )}
          {!compact && <div className="splitter" role="separator" aria-orientation="horizontal" aria-label="Resize timeline" title="Drag to resize the timeline" onPointerDown={startResize} />}
          <Timeline onSeek={seek} />
          {compact && <BottomBar />}
        </div>
      </div>
      {compact && sheet && <BottomSheet sheet={sheet} />}
      {helpOpen && <ShortcutsDialog map={shortcutMap} onClose={() => setHelpOpen(false)} />}
      {exportOpen && <ExportDialog job={job} pending={exportPending} runJob={runExport} onClose={() => ui.set({ exportOpen: false })} />}
    </>
  );
}

/** Edits-style tool bar: library tools with nothing selected, clip tools for the selection. */
function BottomBar() {
  const s = useLive();
  const sel = selectedElements(s);
  const one = sel.length === 1 ? sel[0] : undefined;
  const item = (key: string, icon: string, label: string, onClick: () => void, disabled = false) => (
    <button key={key} className="bb-item" onClick={onClick} disabled={disabled} aria-label={label}>
      <Icon name={icon} size={22} />
      <span>{label}</span>
    </button>
  );
  if (!sel.length) {
    return (
      <nav className="bottom-bar" aria-label="Tools">
        {DOCK_TABS.map((t) => item(t, DOCK_LABELS[t].icon, DOCK_LABELS[t].label, () => ui.set({ sheet: { kind: "dock", tab: t } })))}
        {item("voiceover", "mic", "Voiceover", () => ui.set({ recorder: true }))}
        {item("canvas", "ratio", "Canvas", () => ui.set({ sheet: { kind: "inspector" } }))}
      </nav>
    );
  }
  const tabs = one ? tabsFor(one) : [];
  const ids = sel.map((e) => e.id);
  return (
    <nav className="bottom-bar selection" aria-label="Clip tools">
      {item("done", "back", "Done", () => void live.call("setSelection", { elementIds: [] }).catch(() => {}))}
      {item("split", "split", "Split", () => void live.run("splitAt", { times: [ui.get().playhead], elementIds: ids }))}
      {tabs.map((t) => item(`tab-${t.id}`, t.icon, t.label, () => ui.set({ sheet: { kind: "inspector", tab: t.id } })))}
      {one && "color" in one && one.type !== "text" && one.type !== "caption" && one.type !== "shape" && item("filters", "filters", "Filters", () => ui.set({ sheet: { kind: "dock", tab: "filters" } }))}
      {one && item("duplicate", "duplicate", "Duplicate", () => void live.run("duplicate", { elementId: one.id }))}
      {item("delete", "trash", "Delete", () => void live.run("delete", { elementIds: ids }))}
    </nav>
  );
}

/** A panel that slides up over the timeline (compact layout). */
function BottomSheet({ sheet }: { sheet: Sheet }) {
  const s = useLive();
  const sel = selectedElements(s);
  const title = sheet.kind === "dock" ? DOCK_LABELS[sheet.tab].label : sheet.tab ? PROP_TABS.find((t) => t.id === sheet.tab)?.label ?? "Edit" : sel.length ? "Edit" : "Canvas";
  return (
    <>
      <button className="sheet-scrim" tabIndex={-1} aria-label="Close panel" onClick={() => ui.set({ sheet: null })} />
      <section className="bottom-sheet" role="dialog" aria-label={title}>
        <header>
          <span className="grab" />
          <b>{title}</b>
          <button className="icon ghost" aria-label="Done" title="Done" onClick={() => ui.set({ sheet: null })}><Icon name="check" size={20} /></button>
        </header>
        <div className={`sheet-body ${sheet.kind}`}>
          {sheet.kind === "dock" ? <div className="dock"><DockPane tab={sheet.tab} /></div> : <Inspector key={`${sel.map((e) => e.id).join(",")}:${sheet.tab ?? ""}`} tab={sheet.tab} />}
        </div>
      </section>
    </>
  );
}

function ShortcutsDialog({ map, onClose }: { map: ShortcutMapId; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => dialog.current?.showModal(), []);
  const mac = navigator.platform.startsWith("Mac");
  const keyName = (k: string) => k.replace(/Meta\+/g, mac ? "⌘" : "Ctrl+").replace(/Arrow(Left|Right|Up|Down)/, (_m, d: string) => ({ Left: "←", Right: "→", Up: "↑", Down: "↓" })[d] ?? d);
  const actionName = (a: string) => a.replace(/([A-Z])/g, " $1").toLowerCase().replace(/^./, (c) => c.toUpperCase());
  return (
    <dialog className="dialog shortcuts-dialog" ref={dialog} onClose={onClose} aria-labelledby="shortcuts-title">
      <h3 id="shortcuts-title">Keyboard shortcuts <span className="muted small">({SHORTCUT_MAPS[map].name})</span></h3>
      <div className="shortcuts">
        {Object.entries(SHORTCUT_MAPS[map].keys).map(([action, key]) => (
          <div key={action} className="shortcut">
            <span>{actionName(action)}</span>
            <kbd>{keyName(String(key))}</kbd>
          </div>
        ))}
      </div>
      <div className="row export-actions">
        <button className="primary" onClick={() => dialog.current?.close()}>Done</button>
      </div>
    </dialog>
  );
}

function Seg<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: [T, ReactNode][]; onChange: (v: T) => void }) {
  return (
    <div className="field wide seg-field">
      <span>{label}</span>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button key={String(v)} type="button" role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
            {text}
          </button>
        ))}
      </div>
    </div>
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
      <div className="export-head">
        <span className="export-icon"><Icon name="export" size={20} /></span>
        <div>
          <h3 id="export-title">Export video</h3>
          <div className="muted small">{s.project!.name} · {s.project!.canvas.aspectRatio} · {compositionDuration(s.project!).toFixed(1)}s</div>
        </div>
      </div>
      <fieldset disabled={working || pending}>
        <Seg label="Resolution" value={settings.resolution} options={[["720p", "720p"], ["1080p", "1080p"], ["4K", "4K"]]} onChange={(v) => set({ resolution: v })} />
        <Seg label="Frame rate" value={settings.fps} options={[[24, "24"], [25, "25"], [30, "30"], [50, "50"], [60, "60"]]} onChange={(v) => set({ fps: v })} />
        <Seg label="Quality" value={settings.quality} options={[["low", "Low"], ["medium", "Medium"], ["high", "High"], ["max", "Max"]]} onChange={(v) => set({ quality: v })} />
        <Seg label="Format" value={settings.codec} options={[["h264", "H.264"], ["hevc", "HEVC"], ["prores", "ProRes"]]} onChange={(v) => set({ codec: v })} />
        <div className="field wide">
          <span>Captions</span>
          <label className="row check-row">
            <input type="checkbox" checked={settings.burnInCaptions} onChange={(e) => set({ burnInCaptions: e.target.checked })} /> Burn into the video
          </label>
        </div>
      </fieldset>
      {job && (
        <div className="export-status">
          {working && (
            <div className="progress-row">
              <progress aria-label="Export progress" max={1} value={job.progress} />
              <b>{Math.round(job.progress * 100)}%</b>
            </div>
          )}
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
