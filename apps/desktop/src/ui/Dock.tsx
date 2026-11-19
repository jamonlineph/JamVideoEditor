import { useEffect, useMemo, useRef, useState } from "react";
import fs from "node:fs";
import path from "node:path";
import { ipcRenderer, webUtils } from "electron";
import { CAPTION_STYLES, EFFECTS_CATALOG, FILTERS_CATALOG, LUTS_CATALOG, STICKERS_CATALOG, TEXT_PRESETS, TRANSITIONS_CATALOG, fontStack, mainTrack, type MediaAsset } from "@openedits/core";
import { fileUrl, live, selectedElements, useFeatures, useLive, WEB, WORKSPACE } from "./live.js";
import { ui, useUi, type UiState } from "./uiStore.js";
import { PreviewTile } from "./PreviewTile.js";
import { EditorIcon } from "./EditorIcon.js";
import { MediaThumbnail } from "./TimelineFilmstrip.js";

type DockTab = UiState["dockTab"];
export const DOCK_LABEL: Record<DockTab, string> = {
  media: "Media", audio: "Audio", text: "Text", captions: "Captions",
  effects: "Effects", transitions: "Transitions", filters: "Filters", luts: "LUTs", stickers: "Stickers",
};
export const DOCK_RAIL = ["media", "audio", "text", "captions", "effects", "transitions", "filters", "stickers"] as const;

function fmt(sec?: number) {
  if (sec === undefined) return "";
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

/** Import files into the media panel (asks with the file picker when no paths are given). */
export async function importFiles(paths?: string[]) {
  const files = paths ?? ((await ipcRenderer.invoke("pick-files", {})) as string[]);
  if (files.length) await live.run("importToMediaPanel", { paths: files });
}

/**
 * Paths of files dropped from the desktop (Electron no longer puts them on File objects). In the
 * browser the files are uploaded to the workspace first. Call it before the drop handler returns.
 */
export async function droppedPaths(e: React.DragEvent): Promise<string[]> {
  const files = [...e.dataTransfer.files];
  if (WEB) return files.length ? ((await ipcRenderer.invoke("upload-files", files)) as string[]) : [];
  return files
    .map((f) => {
      try {
        return webUtils.getPathForFile(f);
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

export function Dock({ onClose }: { onClose: () => void }) {
  const tab = useUi("dockTab");
  return (
    <div className="dock">
      <div className="dock-heading">
        <h2><EditorIcon name={tab === "luts" ? "filters" : tab} />{DOCK_LABEL[tab]}</h2>
        <button className="icon ghost" title="Close library" aria-label="Close library" onClick={onClose}><EditorIcon name="close" /></button>
      </div>
      <div className="pane">
        {tab === "media" && <MediaTab />}
        {tab === "audio" && <AudioTab />}
        {(tab === "text" || tab === "captions") && <TextTab captions={tab === "captions"} />}
        {tab !== "media" && tab !== "audio" && tab !== "text" && tab !== "captions" && <EffectsTab tab={tab} />}
      </div>
    </div>
  );
}

function MediaTab() {
  const s = useLive();
  const project = s.project!;
  const [filter, setFilter] = useState<"all" | "video" | "audio" | "image">("all");
  const [unused, setUnused] = useState(false);
  const [sort, setSort] = useState<"date_imported" | "name" | "duration" | "type">("date_imported");
  const used = useMemo(() => new Set(Object.values(project.elements).flatMap((e) => ("mediaId" in e ? [e.mediaId] : []))), [s.revision]);
  const items = Object.values(project.media)
    .filter((m) => !m.name.startsWith("Subject mask") && (filter === "all" || m.kind === filter) && (!unused || !used.has(m.id)))
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : sort === "duration" ? (a.durationSourceSeconds ?? 0) - (b.durationSourceSeconds ?? 0) : sort === "type" ? a.kind.localeCompare(b.kind) : a.importedAt - b.importedAt));
  const add = (m: MediaAsset, overlay = false) => void live.run("addMedia", overlay ? { mediaId: m.id, asOverlay: true, start: ui.get().playhead } : m.kind === "audio" ? { mediaId: m.id, start: ui.get().playhead, role: "music" } : { mediaId: m.id });
  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void droppedPaths(e).then((files) => void (files.length && importFiles(files)));
      }}
      style={{ minHeight: "100%" }}
    >
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="primary" onClick={() => void importFiles()}>
          Import
        </button>
        <select aria-label="Sort media" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} style={{ flex: 1 }}>
          <option value="date_imported">Date imported</option>
          <option value="name">Name</option>
          <option value="duration">Duration</option>
          <option value="type">Type</option>
        </select>
      </div>
      <div className="chips">
        {(["all", "video", "audio", "image"] as const).map((f) => (
          <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
            {f === "image" ? "Images" : f[0].toUpperCase() + f.slice(1)}
          </button>
        ))}
        <button className={unused ? "on" : ""} onClick={() => setUnused(!unused)}>
          Unused
        </button>
      </div>
      {items.length === 0 && <div className="library-empty">
        <EditorIcon name={filter === "audio" ? "audio" : "media"} />
        <span>{Object.keys(project.media).length ? "No matching media" : "Drop files here or click Import"}</span>
      </div>}
      {items.map((m) => (
        <div
          key={m.id}
          className="media-item"
          draggable
          onDragStart={(e) => e.dataTransfer.setData("application/x-openedits-media", m.id)}
          onDoubleClick={() => add(m)}
          title="Double-click to add · drag onto the timeline · drop on a clip to replace"
        >
          <div className="kind">
            <EditorIcon name={m.kind === "audio" ? "audio" : "media"} />
            {m.kind !== "audio" && <MediaThumbnail media={m} />}
          </div>
          <div className="info">
            <div>{m.name}</div>
            <div className="muted small">
              {m.kind === "image" ? `${m.width}×${m.height}` : `${fmt(m.durationSourceSeconds)}${m.width ? ` · ${m.width}×${m.height}` : ""}`}
              {used.has(m.id) ? "" : " · unused"}
            </div>
          </div>
          <button className="icon ghost" title="Add to the main track" onClick={() => add(m)}>
            ＋
          </button>
          {m.kind !== "audio" && (
            <button className="icon ghost" title="Add as overlay at the playhead" onClick={() => add(m, true)}>
              ⧉
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function AudioTab() {
  const s = useLive();
  const project = s.project!;
  const [library, setLibrary] = useState<{ name: string; path: string; group: string }[]>([]);
  const [query, setQuery] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef(new Audio());
  useEffect(() => {
    const out: { name: string; path: string; group: string }[] = [];
    for (const [group, dir] of [
      ["Music", path.join(WORKSPACE, "brand", "music")],
      ["Sound effects", path.join(WORKSPACE, "brand", "sfx")],
    ] as const) {
      try {
        for (const f of fs.readdirSync(dir)) if (/\.(mp3|m4a|wav|aiff?|flac|ogg)$/i.test(f)) out.push({ name: f, path: path.join(dir, f), group });
      } catch {
        /* folder missing */
      }
    }
    setLibrary(out);
    return () => audio.current.pause();
  }, []);
  const preview = (file: string) => {
    if (playing === file) {
      audio.current.pause();
      setPlaying(null);
      return;
    }
    audio.current.src = fileUrl(file);
    void audio.current.play();
    setPlaying(file);
  };
  const imported = Object.values(project.media).filter((m) => m.kind === "audio" && (!query || m.name.toLowerCase().includes(query.toLowerCase())));
  const selectedAudio = selectedElements(s).find((e) => e.type === "audio" || e.type === "video");
  return (
    <>
      <input placeholder="Search audio" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
      {["Music", "Sound effects"].map((group) => (
        <div key={group}>
          <div className="section-title">{group}</div>
          {library.filter((l) => l.group === group && (!query || l.name.toLowerCase().includes(query.toLowerCase()))).length === 0 && (
            <div className="muted small">Add files to {path.join(WORKSPACE, "brand", group === "Music" ? "music" : "sfx")}.</div>
          )}
          {library
            .filter((l) => l.group === group && (!query || l.name.toLowerCase().includes(query.toLowerCase())))
            .map((l) => (
              <div key={l.path} className="list-row">
                <button className="icon ghost" onClick={() => preview(l.path)}>
                  {playing === l.path ? "❚❚" : "▶"}
                </button>
                <span className="grow">{l.name}</span>
                <button className="icon ghost" title="Add at the playhead" onClick={() => void live.run("addMedia", { path: l.path, start: ui.get().playhead, role: group === "Music" ? "music" : "sfx" })}>
                  ＋
                </button>
              </div>
            ))}
        </div>
      ))}
      <div className="section-title">In this project</div>
      {imported.map((m) => (
        <div key={m.id} className="list-row">
          <button className="icon ghost" onClick={() => preview(m.path)}>
            {playing === m.path ? "❚❚" : "▶"}
          </button>
          <span className="grow">{m.name}</span>
          <button className="icon ghost" onClick={() => void live.run("addMedia", { mediaId: m.id, start: ui.get().playhead, role: "music" })}>
            ＋
          </button>
        </div>
      ))}
      <div className="section-title">Beats</div>
      <div className="row">
        <select value={project.beatDensity} onChange={(e) => void live.run("setBeatDensity", { density: e.target.value })}>
          {["off", "lowest", "low", "medium", "high", "extreme"].map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <button disabled={!selectedAudio} title={selectedAudio ? "Detect beats in the selected clip" : "Select a music clip first"} onClick={() => void live.run("audioOnsets", { elementId: selectedAudio!.id, addBeatMarkers: true })}>
          Detect beats
        </button>
      </div>
      <div className="muted small" style={{ marginTop: 6 }}>
        {project.beatMarkers.length} beat markers. Moves and trims snap to them.
      </div>
    </>
  );
}

function TextTab({ captions }: { captions: boolean }) {
  const s = useLive();
  const features = useFeatures();
  const add = (presetId: string, text = "Your text") => void live.run("addText", { text, start: ui.get().playhead, duration: 3, presetId });
  const hasMain = mainTrack(s.project!).elementIds.length > 0;
  return (
    <>
      <div className="dock-subhead">
        <strong>{captions ? "Caption styles" : "Styles"}</strong>
        {!captions && <button className="ghost" onClick={() => add("classic")}>＋ Add title</button>}
      </div>
      {!captions && <div className="tiles text-style-grid">
        {TEXT_PRESETS.map((p) => {
          const st = p.data.style;
          return (
            <button key={p.id} className="tile text-style" onClick={() => add(p.id)} title={`Add "${p.name}" text at the playhead`}>
              <span
                style={{
                  fontFamily: fontStack(st.fontFamily),
                  fontWeight: st.fontWeight,
                  fontStyle: st.italic ? "italic" : undefined,
                  color: st.color ?? "#fff",
                  background: st.backgroundColor,
                  padding: st.backgroundColor ? "2px 6px" : undefined,
                  borderRadius: 4,
                  textTransform: st.uppercase ? "uppercase" : undefined,
                  WebkitTextStroke: st.strokeColor ? `1px ${st.strokeColor}` : undefined,
                  textShadow: st.shadowColor ? `0 0 6px ${st.shadowColor}` : undefined,
                }}
              >
                {p.name}
              </span>
            </button>
          );
        })}
      </div>}
      {captions && <>
      <div className="muted small" style={{ marginBottom: 6 }}>
        {features && !features.transcription
          ? "Captions need whisper.cpp (whisper-cli) and a Whisper model, which are not installed on this computer. See the README for setup."
          : hasMain
            ? "Transcribes the main track (on-device) and adds captions in this style."
            : "Add a talking clip first."}
      </div>
      <div className="tiles">
        {CAPTION_STYLES.map((c) => (
          <button
            key={c.id}
            className="tile"
            onClick={() => {
              if (features && !features.transcription) return live.toast("info", "Captions need whisper.cpp (whisper-cli) and a Whisper model. Run `openedits doctor` for setup steps.");
              if (!hasMain) return live.toast("info", "Add a talking clip to the main track first");
              live.toast("info", "Transcribing and adding captions…");
              void live.run("generateCaptions", { style: c.id }).then((r) => r && live.toast("info", "Captions added"));
            }}
            title={`Captions: ${c.name} (${c.data.mode})`}
          >
            <span style={{ fontFamily: fontStack(c.data.style.fontFamily), fontWeight: c.data.style.fontWeight, textTransform: c.data.style.uppercase ? "uppercase" : undefined, fontSize: 13 }}>
              word <span style={{ color: c.data.mode === "box" ? "#fff" : c.data.highlightColor, background: c.data.mode === "box" ? c.data.highlightColor : undefined, padding: "0 3px", borderRadius: 3 }}>by</span> word
            </span>
            <span className="label">{c.name}</span>
          </button>
        ))}
      </div>
      </>}
    </>
  );
}

function EffectsTab({ tab }: { tab: Extract<DockTab, "effects" | "transitions" | "filters" | "luts" | "stickers"> }) {
  const s = useLive();
  const sel = selectedElements(s)[0];
  const need = (what: string) => live.toast("info", `Select ${what} first`);
  const items =
    tab === "filters" ? FILTERS_CATALOG : tab === "effects" ? EFFECTS_CATALOG : tab === "transitions" ? TRANSITIONS_CATALOG : tab === "luts" ? LUTS_CATALOG : STICKERS_CATALOG;
  const apply = (id: string) => {
    const p = s.project!;
    if (tab === "stickers") return void live.run("addSticker", { stickerId: id, start: ui.get().playhead, duration: 3 });
    if (!sel) return need(tab === "transitions" ? "a main-track clip" : "a clip");
    if (tab === "filters") return void live.run("applyFilter", { elementId: sel.id, filterId: id });
    if (tab === "luts") {
      if (id === "custom")
        return void ipcRenderer.invoke("pick-files", { title: "Choose a .cube LUT", extensions: ["cube"], multi: false }).then((f: string[]) => {
          if (f[0]) void live.run("applyLUT", { elementId: sel.id, lutId: "custom", cubePath: f[0] });
        });
      return void live.run("applyLUT", { elementId: sel.id, lutId: id });
    }
    if (tab === "transitions") {
      if (!mainTrack(p).elementIds.includes(sel.id)) return need("a main-track clip");
      return void live.run("addTransition", { fromElementId: sel.id, type: id });
    }
    const fx = EFFECTS_CATALOG.find((e) => e.id === id)!;
    if (fx.data.requiresSubjectMask) return void live.run("applySubjectEffect", { elementId: sel.id, effectId: id, waitSeconds: 0 }).then((r) => r && live.toast("info", "Tracking the subject… the effect appears when it finishes"));
    return void live.run("applyEffect", { elementId: sel.id, effectId: id });
  };
  return (
    <>
      <div className="chips">
        {(["filters", "effects", "transitions", "luts", "stickers"] as const).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} aria-pressed={tab === t} onClick={() => ui.set({ dockTab: t })}>
            {DOCK_LABEL[t]}
          </button>
        ))}
      </div>
      {tab !== "stickers" && <div className="muted small" style={{ marginBottom: 8 }}>{sel ? `Applies to: ${sel.name ?? sel.type}` : "Select a clip to apply."}</div>}
      <div className="tiles">
        {(items as { id: string; name: string; category: string; data: { svgPath?: string; requiresSubjectMask?: boolean } }[]).map((i) => {
          if (tab === "stickers" || i.id === "custom") {
            return (
              <button key={i.id} className="tile" onClick={() => apply(i.id)} title={i.name}>
                {i.data.svgPath ? (
                  <svg viewBox="0 0 24 24" width="22" height="22">
                    <path d={i.data.svgPath} fill="white" />
                  </svg>
                ) : (
                  <span style={{ fontWeight: 600, fontSize: 12 }}>{i.name}…</span>
                )}
                <span className="label">{i.category}</span>
              </button>
            );
          }
          const kind = tab === "filters" ? "filter" : tab === "transitions" ? "transition" : tab === "luts" ? "lut" : i.data.requiresSubjectMask ? "subject" : "effect";
          const active = sel && tab === "filters" && "color" in sel ? (sel.color.filter?.id ?? "none") === i.id : sel && tab === "luts" && "color" in sel ? (sel.color.lut?.id ?? "none") === i.id : false;
          return (
            <PreviewTile
              key={i.id}
              kind={kind}
              id={i.id}
              name={i.name}
              label={i.category}
              active={active}
              title={kind === "subject" ? `${i.name} (follows the subject; macOS)` : i.name}
              badge={kind === "subject" ? <span className="badge">subject</span> : undefined}
              onPick={() => apply(i.id)}
            />
          );
        })}
      </div>
    </>
  );
}
