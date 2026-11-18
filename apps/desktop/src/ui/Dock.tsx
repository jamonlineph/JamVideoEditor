import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import fs from "node:fs";
import path from "node:path";
import { ipcRenderer, webUtils } from "electron";
import {
  ADJUST_PRESETS,
  CAPTION_STYLES,
  EFFECTS_CATALOG,
  FILTERS_CATALOG,
  LUTS_CATALOG,
  SHAPES_CATALOG,
  STICKERS_CATALOG,
  TEXT_PRESETS,
  TRANSITIONS_CATALOG,
  fontStack,
  mainTrack,
  type Element,
  type MediaAsset,
  type Project,
} from "@openedits/core";
import { fileUrl, live, selectedElements, useFeatures, useLive, WEB, WORKSPACE } from "./live.js";
import { DOCK_TABS, ui, useUi, type DockTab } from "./uiStore.js";
import { PreviewTile } from "./PreviewTile.js";
import { Icon } from "./Icon.js";
import { mediaFrame } from "./frames.js";
import { Slider } from "./Inspector.js";

export const DOCK_LABELS: Record<DockTab, { label: string; icon: string }> = {
  media: { label: "Media", icon: "media" },
  audio: { label: "Audio", icon: "audio" },
  text: { label: "Text", icon: "text" },
  stickers: { label: "Stickers", icon: "sticker" },
  effects: { label: "Effects", icon: "effects" },
  transitions: { label: "Transitions", icon: "transitions" },
  filters: { label: "Filters", icon: "filters" },
  adjust: { label: "Adjust", icon: "adjust" },
  captions: { label: "Captions", icon: "captions" },
};

function fmt(sec?: number) {
  if (sec === undefined) return "";
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

const title = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

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

/** Main-track clip whose following cut a transition goes on: the selection, else the cut nearest the playhead. */
export function transitionTarget(project: Project, selected: Element | undefined): string | null {
  const ids = mainTrack(project).elementIds;
  if (ids.length < 2) return null;
  const withNext = ids.slice(0, -1);
  if (selected && withNext.includes(selected.id)) return selected.id;
  const ph = ui.get().playhead;
  let best: string | null = null;
  let dist = Infinity;
  for (const id of withNext) {
    const el = project.elements[id];
    const d = Math.abs(el.start + el.duration - ph);
    if (d < dist) {
      dist = d;
      best = id;
    }
  }
  return best;
}

/** Where a look goes: the selected clip when it takes color and effects, else a new adjustment layer at the playhead. */
async function lookTarget(sel: Element | undefined, label: string): Promise<string | null> {
  if (sel && "effects" in sel) return sel.id;
  const start = ui.get().playhead;
  const r = await live.run<{ elementId?: string }>("addAdjustmentLayer", { start, duration: 3, name: label });
  if (r?.elementId) live.toast("info", `Added ${label} on its own layer. Drag its edges on the timeline to set where it plays.`);
  return r?.elementId ?? null;
}

export function Dock() {
  const tab = useUi("dockTab");
  return (
    <div className="dock">
      <div className="tabs" role="tablist" aria-label="Library">
        {DOCK_TABS.map((t) => (
          <button key={t} role="tab" className={tab === t ? "active" : ""} aria-selected={tab === t} aria-pressed={tab === t} onClick={() => ui.set({ dockTab: t })} title={DOCK_LABELS[t].label}>
            <Icon name={DOCK_LABELS[t].icon} size={20} />
            <span>{DOCK_LABELS[t].label}</span>
          </button>
        ))}
      </div>
      <DockPane tab={tab} />
    </div>
  );
}

/** One library panel (used by the side dock and by the compact layout's bottom sheet). */
export function DockPane({ tab }: { tab: DockTab }) {
  return (
    <div className="pane" data-tab={tab}>
      {tab === "media" && <MediaTab />}
      {tab === "audio" && <AudioTab />}
      {tab === "text" && <TextTab />}
      {tab === "stickers" && <StickersTab />}
      {tab === "effects" && <EffectsTab />}
      {tab === "transitions" && <TransitionsTab />}
      {tab === "filters" && <FiltersTab />}
      {tab === "adjust" && <AdjustTab />}
      {tab === "captions" && <CaptionsTab />}
    </div>
  );
}

function Chips({ items, value, onChange }: { items: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="chips">
      {items.map((c) => (
        <button key={c} className={value === c ? "on" : ""} aria-pressed={value === c} onClick={() => onChange(c)}>
          {c === "all" ? "All" : c === "luts" ? "LUTs" : title(c)}
        </button>
      ))}
    </div>
  );
}

function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="search-box">
      <Icon name="search" size={15} />
      <input type="search" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <div className="dock-hint">{children}</div>;
}

const categoriesOf = (items: { category: string }[]) => ["all", ...new Set(items.map((i) => i.category))];
const matches = (q: string, ...fields: string[]) => !q || fields.some((f) => f.toLowerCase().includes(q.toLowerCase()));

// ------------------------------------------------------------------ media

function MediaTab() {
  const s = useLive();
  const project = s.project!;
  const [filter, setFilter] = useState<"all" | "video" | "audio" | "image">("all");
  const [unused, setUnused] = useState(false);
  const [sort, setSort] = useState<"date_imported" | "name" | "duration" | "type">("date_imported");
  const [query, setQuery] = useState("");
  const [over, setOver] = useState(false);
  const used = useMemo(() => new Set(Object.values(project.elements).flatMap((e) => ("mediaId" in e ? [e.mediaId] : []))), [s.revision]);
  const items = Object.values(project.media)
    .filter((m) => !m.name.startsWith("Subject mask") && (filter === "all" || m.kind === filter) && (!unused || !used.has(m.id)) && matches(query, m.name))
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : sort === "duration" ? (a.durationSourceSeconds ?? 0) - (b.durationSourceSeconds ?? 0) : sort === "type" ? a.kind.localeCompare(b.kind) : a.importedAt - b.importedAt));
  const add = (m: MediaAsset, overlay = false) => void live.run("addMedia", overlay ? { mediaId: m.id, asOverlay: true, start: ui.get().playhead } : m.kind === "audio" ? { mediaId: m.id, start: ui.get().playhead, role: "music" } : { mediaId: m.id });
  return (
    <div
      className={`media-tab${over ? " drop-over" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void droppedPaths(e).then((files) => void (files.length && importFiles(files)));
      }}
    >
      <button className="import-card" onClick={() => void importFiles()}>
        <span className="import-icon"><Icon name="import" size={22} /></span>
        <span>
          <b>Import</b>
          <span className="muted small">{WEB ? "Videos, photos and music from this device" : "Or drop videos, photos and music here"}</span>
        </span>
      </button>
      <div className="row media-tools">
        <Search value={query} onChange={setQuery} placeholder="Search media" />
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort media">
          <option value="date_imported">Newest</option>
          <option value="name">Name</option>
          <option value="duration">Duration</option>
          <option value="type">Type</option>
        </select>
      </div>
      <div className="chips">
        {(["all", "video", "image", "audio"] as const).map((f) => (
          <button key={f} className={filter === f ? "on" : ""} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === "image" ? "Photos" : title(f)}
          </button>
        ))}
        <button className={unused ? "on" : ""} aria-pressed={unused} onClick={() => setUnused(!unused)}>
          Unused
        </button>
      </div>
      {items.length === 0 && <Hint>{Object.keys(project.media).length ? "Nothing matches." : "Your imported videos, photos and music show up here."}</Hint>}
      <div className="media-grid">
        {items.map((m) => (
          <div
            key={m.id}
            className="media-item"
            data-kind={m.kind}
            draggable
            onDragStart={(e) => e.dataTransfer.setData("application/x-openedits-media", m.id)}
            onDoubleClick={() => add(m)}
            title={`${m.name}\nDouble-click or + to add · drag onto the timeline · Alt-drop on a clip to replace it`}
          >
            <MediaThumb media={m} />
            <span className="badge-time">{m.kind === "image" ? `${m.width}×${m.height}` : fmt(m.durationSourceSeconds)}</span>
            {used.has(m.id) && <span className="badge-used" title="On the timeline"><Icon name="check" size={11} /></span>}
            <div className="info">{m.name}</div>
            <div className="hover-actions">
              {m.kind !== "audio" && (
                <button className="icon" title="Add as overlay at the playhead" aria-label={`Add ${m.name} as an overlay`} onClick={() => add(m, true)}>
                  <Icon name="layers" size={15} />
                </button>
              )}
              <button className="icon add" title={m.kind === "audio" ? "Add at the playhead" : "Add to the main track"} aria-label={`Add ${m.name}`} onClick={() => add(m)}>
                <Icon name="plus" size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MediaThumb({ media }: { media: MediaAsset }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (media.kind !== "audio") void mediaFrame(media, Math.min(1, (media.durationSourceSeconds ?? 0) / 3), 160).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [media.id]);
  if (media.kind === "audio")
    return (
      <div className="thumb audio-thumb">
        <Icon name="audio" size={26} />
      </div>
    );
  return <div className="thumb">{url ? <img src={url} alt="" draggable={false} /> : <Icon name={media.kind === "image" ? "image" : "media"} size={22} />}</div>;
}

// ------------------------------------------------------------------ audio

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
    const a = audio.current;
    a.onended = () => setPlaying(null);
    return () => a.pause();
  }, []);
  const preview = (file: string) => {
    if (playing === file) {
      audio.current.pause();
      setPlaying(null);
      return;
    }
    audio.current.src = fileUrl(file);
    void audio.current.play().catch(() => setPlaying(null));
    setPlaying(file);
  };
  const imported = Object.values(project.media).filter((m) => m.kind === "audio" && matches(query, m.name));
  const selectedAudio = selectedElements(s).find((e) => e.type === "audio" || e.type === "video");
  const row = (key: string, name: string, file: string, onAdd: () => void, sub?: string) => (
    <div key={key} className="audio-row">
      <button className={`icon round${playing === file ? " on" : ""}`} aria-label={playing === file ? `Pause ${name}` : `Play ${name}`} onClick={() => preview(file)}>
        <Icon name={playing === file ? "pause" : "play"} size={14} />
      </button>
      <div className="grow">
        <div className="ellipsis">{name}</div>
        {sub && <div className="muted small">{sub}</div>}
      </div>
      <button className="icon add" title="Add at the playhead" aria-label={`Add ${name}`} onClick={onAdd}>
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
  return (
    <>
      <div className="row quick-actions">
        <button onClick={() => ui.set({ recorder: true, sheet: null })}>
          <Icon name="mic" size={16} /> Voiceover
        </button>
        <button onClick={() => void importFiles()}>
          <Icon name="import" size={16} /> Import music
        </button>
      </div>
      <Search value={query} onChange={setQuery} placeholder="Search audio" />
      <div className="section-title">In this project</div>
      {imported.length === 0 && <Hint>Import music or sound effects, or record a voiceover.</Hint>}
      {imported.map((m) => row(m.id, m.name, m.path, () => void live.run("addMedia", { mediaId: m.id, start: ui.get().playhead, role: "music" }), fmt(m.durationSourceSeconds)))}
      {["Music", "Sound effects"].map((group) => {
        const files = library.filter((l) => l.group === group && matches(query, l.name));
        return (
          <div key={group}>
            <div className="section-title">{group}</div>
            {files.length === 0 && <Hint>Add files to {path.join(WORKSPACE, "brand", group === "Music" ? "music" : "sfx")} to see them here.</Hint>}
            {files.map((l) => row(l.path, l.name, l.path, () => void live.run("addMedia", { path: l.path, start: ui.get().playhead, role: group === "Music" ? "music" : "sfx" })))}
          </div>
        );
      })}
      <div className="section-title">Beat sync</div>
      <div className="row">
        <select value={project.beatDensity} onChange={(e) => void live.run("setBeatDensity", { density: e.target.value })} aria-label="Beat marker density">
          {["off", "lowest", "low", "medium", "high", "extreme"].map((d) => (
            <option key={d} value={d}>
              {title(d)}
            </option>
          ))}
        </select>
        <button disabled={!selectedAudio} title={selectedAudio ? "Detect beats in the selected clip" : "Select a music clip first"} onClick={() => void live.run("audioOnsets", { elementId: selectedAudio!.id, addBeatMarkers: true })}>
          Detect beats
        </button>
      </div>
      <Hint>{project.beatMarkers.length} beat markers. Moves and trims snap to them.</Hint>
    </>
  );
}

// ------------------------------------------------------------------ text

export function TextSample({ style, children = "Text", size = 17 }: { style: (typeof TEXT_PRESETS)[number]["data"]["style"]; children?: ReactNode; size?: number }) {
  return (
    <span
      className="text-sample"
      style={{
        fontFamily: fontStack(style.fontFamily),
        fontWeight: style.fontWeight,
        fontStyle: style.italic ? "italic" : undefined,
        color: style.color && style.color.length === 9 && style.color.endsWith("00") ? "transparent" : style.color ?? "#fff",
        background: style.backgroundColor,
        padding: style.backgroundColor ? "2px 8px" : undefined,
        borderRadius: style.backgroundCornerRadius ? `${Math.round(style.backgroundCornerRadius * 14)}px` : 3,
        textTransform: style.uppercase ? "uppercase" : undefined,
        letterSpacing: style.letterSpacing ? `${style.letterSpacing}em` : undefined,
        WebkitTextStroke: style.strokeColor && style.strokeWidth ? `${Math.max(1, Math.min(3, style.strokeWidth * 14))}px ${style.strokeColor}` : undefined,
        paintOrder: "stroke fill",
        textShadow: style.shadowColor ? `${(style.shadowOffsetX ?? 0) * 20}px ${(style.shadowOffsetY ?? 0) * 20}px ${(style.shadowBlur ?? 0) * 18}px ${style.shadowColor}` : undefined,
        fontSize: size,
      }}
    >
      {children}
    </span>
  );
}

function TextTab() {
  const [cat, setCat] = useState("all");
  const add = async (presetId?: string) => {
    const r = await live.run<{ elementId?: string }>("addText", { text: "Your text", start: ui.get().playhead, duration: 3, ...(presetId ? { presetId } : {}) });
    if (!r?.elementId) return;
    await live.call("setSelection", { elementIds: [r.elementId] }).catch(() => {});
    ui.set({ panel: "text", sheet: ui.get().sheet ? { kind: "inspector", tab: "text" } : null });
  };
  const cats = categoriesOf(TEXT_PRESETS);
  return (
    <>
      <div className="row quick-actions">
        <button className="primary grow" onClick={() => void add()}>
          <Icon name="plus" size={16} /> Add text
        </button>
        <button onClick={() => void live.run("openTeleprompter", { open: true }).then(() => ui.set({ sheet: null }))} title="Read your script while you record">
          <Icon name="teleprompter" size={16} /> Teleprompter
        </button>
      </div>
      <div className="section-title">Text styles</div>
      <Chips items={cats} value={cat} onChange={setCat} />
      <div className="tiles text-tiles">
        {TEXT_PRESETS.filter((p) => cat === "all" || p.category === cat).map((p) => (
          <button key={p.id} className="tile text-tile" onClick={() => void add(p.id)} title={`Add "${p.name}" text at the playhead`}>
            <TextSample style={p.data.style} />
            <span className="label">{p.name}</span>
          </button>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ stickers

export function StickerArt({ id, size = 34 }: { id: string; size?: number }) {
  const item = STICKERS_CATALOG.find((x) => x.id === id);
  if (!item) return null;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      {item.data.parts ? item.data.parts.map((p, i) => <path key={i} d={p.d} fill={p.fill} />) : <path d={item.data.svgPath} fill="white" />}
    </svg>
  );
}

function StickersTab() {
  const [cat, setCat] = useState("all");
  const [query, setQuery] = useState("");
  const add = (stickerId: string) =>
    void live.run<{ elementId?: string }>("addSticker", { stickerId, start: ui.get().playhead, duration: 3, transform: { scale: 0.3 } }).then((r) => { if (r?.elementId) void live.call("setSelection", { elementIds: [r.elementId] }).catch(() => {}); });
  const items = STICKERS_CATALOG.filter((x) => (cat === "all" || x.category === cat) && matches(query, x.name, x.category));
  return (
    <>
      <Search value={query} onChange={setQuery} placeholder="Search stickers" />
      <Chips items={categoriesOf(STICKERS_CATALOG)} value={cat} onChange={setCat} />
      <div className="tiles sticker-tiles">
        {items.map((i) => (
          <button key={i.id} className="tile sticker-tile" data-sticker={i.id} onClick={() => add(i.id)} title={`Add ${i.name}`}>
            <StickerArt id={i.id} />
            <span className="label">{i.name}</span>
          </button>
        ))}
      </div>
      <div className="section-title">Shapes</div>
      <div className="tiles sticker-tiles">
        {SHAPES_CATALOG.map((sh) => (
          <button key={sh.id} className="tile sticker-tile" onClick={() => void live.run("addShape", { shape: sh.id, start: ui.get().playhead, duration: 3 })} title={sh.description ?? `Add a ${sh.name.toLowerCase()}`}>
            <span className={`shape-swatch ${sh.id}`} />
            <span className="label">{sh.name}</span>
          </button>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ effects, transitions, filters, adjust

function TargetLine({ sel, empty }: { sel: Element | undefined; empty: string }) {
  return <Hint>{sel && sel.type !== "audio" ? <>Applies to <b>{sel.name ?? (sel.type === "text" ? sel.text : sel.type)}</b></> : empty}</Hint>;
}

function EffectsTab() {
  const s = useLive();
  const sel = selectedElements(s)[0];
  const [cat, setCat] = useState("all");
  const [query, setQuery] = useState("");
  const items = EFFECTS_CATALOG.filter((e) => (cat === "all" || e.category === cat) && matches(query, e.name, e.category));
  const apply = async (id: string, name: string) => {
    const fx = EFFECTS_CATALOG.find((e) => e.id === id)!;
    if (fx.data.requiresSubjectMask) {
      if (!sel || (sel.type !== "video" && sel.type !== "image")) return live.toast("info", "Select a video or photo for subject effects");
      const r = await live.run("applySubjectEffect", { elementId: sel.id, effectId: id, waitSeconds: 0 });
      if (r) live.toast("info", "Tracking the subject… the effect appears when it finishes");
      return;
    }
    const target = await lookTarget(sel, name);
    if (target) await live.run("applyEffect", { elementId: target, effectId: id });
  };
  return (
    <>
      <Search value={query} onChange={setQuery} placeholder="Search effects" />
      <Chips items={categoriesOf(EFFECTS_CATALOG)} value={cat} onChange={setCat} />
      <TargetLine sel={sel} empty="Tap an effect to add it at the playhead, or select a clip first." />
      <div className="tiles">
        {items.map((i) => {
          const kind = i.data.requiresSubjectMask ? "subject" : "effect";
          const on = sel && "effects" in sel && sel.effects.some((x) => x.effectId === i.id);
          return <PreviewTile key={i.id} kind={kind} id={i.id} name={i.name} label={title(i.category)} active={!!on} title={kind === "subject" ? `${i.name} (follows the subject; macOS)` : i.name} badge={kind === "subject" ? <span className="badge">subject</span> : undefined} onPick={() => void apply(i.id, i.name)} />;
        })}
      </div>
    </>
  );
}

function TransitionsTab() {
  const s = useLive();
  const project = s.project!;
  const sel = selectedElements(s)[0];
  const [cat, setCat] = useState("all");
  const target = transitionTarget(project, sel);
  const current = target ? project.transitions.find((t) => t.fromElementId === target) : undefined;
  const items = TRANSITIONS_CATALOG.filter((t) => cat === "all" || t.category === cat);
  const cuts = mainTrack(project).elementIds.slice(0, -1);
  return (
    <>
      <Chips items={categoriesOf(TRANSITIONS_CATALOG)} value={cat} onChange={setCat} />
      <Hint>
        {target
          ? <>Goes on the cut after <b>{project.elements[target].name ?? "the selected clip"}</b>. Tap a <Icon name="transitions" size={12} /> button between clips on the timeline to pick another cut.</>
          : "Add two clips to the main track to put a transition between them."}
      </Hint>
      {current && (
        <div className="look-controls">
          <Slider reset={0.5} label="Duration" value={current.durationSeconds} min={0.1} max={2} step={0.05} format={(v) => `${v.toFixed(2)}s`} onCommit={(v) => void live.run("addTransition", { fromElementId: target, type: current.type, durationSeconds: v })} />
          <div className="row">
            <button onClick={() => void Promise.all(cuts.map((id) => live.run("addTransition", { fromElementId: id, type: current.type, durationSeconds: current.durationSeconds })))}>Apply to all</button>
            <button className="ghost" onClick={() => void live.run("addTransition", { fromElementId: target, type: "none" })}>Remove</button>
          </div>
        </div>
      )}
      <div className="tiles">
        {items.map((i) =>
          i.id === "none" ? null : (
            <PreviewTile key={i.id} kind="transition" id={i.id} name={i.name} label={title(i.category)} active={current?.type === i.id} onPick={() => (target ? void live.run("addTransition", { fromElementId: target, type: i.id }) : live.toast("info", "Add two clips to the main track first"))} />
          ),
        )}
      </div>
    </>
  );
}

function FiltersTab() {
  const s = useLive();
  const sel = selectedElements(s)[0];
  const [cat, setCat] = useState("all");
  const colorable = sel && "color" in sel && sel.type !== "text" && sel.type !== "caption" && sel.type !== "shape" ? sel : undefined;
  const filter = colorable?.color.filter;
  const items = FILTERS_CATALOG.filter((f) => f.id !== "none" && (cat === "all" || f.category === cat));
  const apply = async (id: string, name: string) => {
    const target = await lookTarget(colorable, `${name} filter`);
    if (target) await live.run("applyFilter", { elementId: target, filterId: id });
  };
  return (
    <>
      <Chips items={categoriesOf(FILTERS_CATALOG.filter((f) => f.id !== "none"))} value={cat} onChange={setCat} />
      <TargetLine sel={colorable} empty="Tap a filter to add it at the playhead, or select a clip first." />
      {colorable && filter && (
        <div className="look-controls">
          <Slider reset={100} label="Intensity" value={filter.intensity} min={0} max={100} step={1} onCommit={(v) => void live.run("applyFilter", { elementId: colorable.id, filterId: filter.id, intensity: v })} />
          <button className="ghost" onClick={() => void live.run("applyFilter", { elementId: colorable.id, filterId: "none" })}>Remove filter</button>
        </div>
      )}
      <div className="tiles">
        {items.map((i) => (
          <PreviewTile key={i.id} kind="filter" id={i.id} name={i.name} label={title(i.category)} active={filter?.id === i.id} onPick={() => void apply(i.id, i.name)} />
        ))}
      </div>
    </>
  );
}

function AdjustTab() {
  const s = useLive();
  const sel = selectedElements(s)[0];
  const [cat, setCat] = useState<"presets" | "luts">("presets");
  const colorable = sel && "color" in sel && sel.type !== "text" && sel.type !== "caption" && sel.type !== "shape" ? sel : undefined;
  const pickLut = async (id: string) => {
    const target = await lookTarget(colorable, "Camera LUT");
    if (!target) return;
    if (id !== "custom") return void live.run("applyLUT", { elementId: target, lutId: id });
    const f = (await ipcRenderer.invoke("pick-files", { title: "Choose a .cube LUT", extensions: ["cube"], multi: false })) as string[];
    if (f[0]) await live.run("applyLUT", { elementId: target, lutId: "custom", cubePath: f[0] });
  };
  return (
    <>
      <Chips items={["presets", "luts"]} value={cat} onChange={(v) => setCat(v as typeof cat)} />
      <TargetLine sel={colorable} empty="Tap a look to add an adjustment layer at the playhead, or select a clip first." />
      {colorable && (
        <div className="row">
          <button onClick={() => ui.set({ panel: "color", sheet: ui.get().sheet ? { kind: "inspector", tab: "color" } : null })}>
            <Icon name="adjust" size={15} /> Fine-tune color
          </button>
          <button className="ghost" onClick={() => void live.run("setColorGrade", { elementId: colorable.id, reset: true })}>Reset</button>
        </div>
      )}
      <div className="tiles">
        {cat === "presets"
          ? ADJUST_PRESETS.map((p) => (
              <PreviewTile key={p.id} kind="adjust" id={p.id} name={p.name} onPick={() => void lookTarget(colorable, p.name).then((t) => (t ? live.run("setColorGrade", { elementId: t, presetId: p.id }) : null))} />
            ))
          : LUTS_CATALOG.map((l) =>
              l.id === "custom" ? (
                <button key={l.id} className="tile" onClick={() => void pickLut(l.id)} title="Choose a .cube file">
                  <span className="tile-text">Custom .cube…</span>
                </button>
              ) : (
                <PreviewTile key={l.id} kind="lut" id={l.id} name={l.name} label={l.data.vendor} active={colorable?.color.lut?.id === l.id} onPick={() => void pickLut(l.id)} />
              ),
            )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ captions

function CaptionsTab() {
  const s = useLive();
  const features = useFeatures();
  const [cat, setCat] = useState("all");
  const hasMain = mainTrack(s.project!).elementIds.length > 0;
  const captions = Object.values(s.project!.elements).filter((e) => e.type === "caption");
  const generate = (style: string) => {
    if (features && !features.transcription) return live.toast("info", "Captions need whisper.cpp (whisper-cli) and a Whisper model. Run `openedits doctor` for setup steps.");
    if (!hasMain) return live.toast("info", "Add a talking clip to the main track first");
    live.toast("info", "Transcribing and adding captions…");
    void live.run("generateCaptions", { style }).then((r) => r && live.toast("info", "Captions added"));
  };
  return (
    <>
      <div className="caption-hero">
        <Icon name="captions" size={26} />
        <div>
          <b>Auto captions</b>
          <div className="muted small">
            {features && !features.transcription
              ? "Needs whisper.cpp (whisper-cli) and a Whisper model, which are not installed here. See the README."
              : hasMain
                ? "Transcribes your main track on this device and adds word-by-word captions. Pick a style:"
                : "Add a talking clip first."}
          </div>
        </div>
      </div>
      {captions.length > 0 && (
        <div className="row">
          <span className="muted small grow">{captions.length} caption{captions.length > 1 ? "s" : ""} on the timeline</span>
          <button onClick={() => void live.run("setSelection", { elementIds: [captions[0].id] })}>Edit captions</button>
        </div>
      )}
      <Chips items={categoriesOf(CAPTION_STYLES)} value={cat} onChange={setCat} />
      <div className="tiles text-tiles">
        {CAPTION_STYLES.filter((c) => cat === "all" || c.category === cat).map((c) => (
          <button key={c.id} className="tile text-tile caption-tile" onClick={() => generate(c.id)} title={`Captions: ${c.name} (${c.data.mode})`}>
            <TextSample style={c.data.style} size={13}>
              word{" "}
              <span style={{ color: c.data.mode === "box" ? "#fff" : c.data.highlightColor, background: c.data.mode === "box" ? c.data.highlightColor : undefined, padding: "0 3px", borderRadius: 3 }}>by</span> word
            </TextSample>
            <span className="label">{c.name}</span>
          </button>
        ))}
      </div>
    </>
  );
}
