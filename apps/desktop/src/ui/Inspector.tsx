import { useEffect, useRef, useState, type ReactNode } from "react";
import { ipcRenderer } from "electron";
import {
  ADJUST_PRESETS,
  CAPTION_STYLES,
  CLIP_ANIMATIONS,
  evaluateClipAnimation,
  evaluateTextAnimation,
  COLOR_GRADE_KEYS,
  EFFECTS_CATALOG,
  FILTERS_CATALOG,
  FONTS,
  HSL_BANDS,
  LUTS_CATALOG,
  SPEED_PRESETS,
  TEXT_ANIMATIONS,
  TEXT_PRESETS,
  TOOL_PANELS,
  TRANSITIONS_CATALOG,
  WHEELS,
  evaluateKeyframes,
  fontStack,
  mainTrack,
  type Element,
  type KeyframeProperty,
  type Project,
} from "@openedits/core";
import { live, selectedElements, useFeatures, useLive, type Features } from "./live.js";
import { ui, useUi, capturePointer, seek } from "./uiStore.js";
import { PreviewTile } from "./PreviewTile.js";
import type { PreviewKind } from "./thumbs.js";
import { Icon } from "./Icon.js";

type Args = Record<string, unknown>;
const run = (tool: string, args: Args) => void live.run(tool, args);
const db = (gain: number) => (gain <= 0 ? -60 : 20 * Math.log10(gain));

/** A slider that previews locally and commits once, on release (one undo step per gesture). */
export function Slider(props: { label: string; value: number; min: number; max: number; step?: number; format?: (v: number) => string; onCommit: (v: number) => void; keyframed?: boolean; onKeyframe?: () => void; /** Value a double-click restores (default: 0 when in range, else the minimum). */ reset?: number }) {
  const [local, setLocal] = useState<number | null>(null);
  const v = local ?? props.value;
  const commit = () => {
    if (local !== null && local !== props.value) props.onCommit(local);
    setLocal(null);
  };
  return (
    <div className="field">
      <label title={props.label}>
        {props.onKeyframe && (
          <span className={`kf-btn${props.keyframed ? " on" : ""}`} title={props.keyframed ? "Keyframed: edits set a keyframe at the playhead" : "Add a keyframe at the playhead"} onClick={props.onKeyframe}>
            ◆
          </span>
        )}
        {props.label}
      </label>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? (props.max - props.min) / 200}
        value={v}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        onDoubleClick={() => {
          const r = props.reset ?? (props.min <= 0 && props.max >= 0 ? 0 : props.min);
          setLocal(null);
          if (r !== props.value) props.onCommit(r);
        }}
      />
      <span className="val">{props.format ? props.format(v) : Math.abs(v) >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(2)}</span>
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="field wide">
      <label>{label}</label>
      <div>
        <button className={`switch${value ? " on" : ""}`} role="switch" aria-checked={value} aria-label={label} onClick={() => onChange(!value)}>
          <span className="knob" />
        </button>
      </div>
    </div>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: (string | [string, string])[]; onChange: (v: string) => void }) {
  return (
    <div className="field wide">
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => {
          const [id, name] = typeof o === "string" ? [o, o] : o;
          return (
            <option key={id} value={id}>
              {name}
            </option>
          );
        })}
      </select>
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string | undefined; onChange: (v: string) => void }) {
  return (
    <div className="field wide">
      <label>{label}</label>
      <input type="color" value={(value ?? "#ffffff").slice(0, 7)} onChange={(e) => onChange(e.target.value.toUpperCase())} />
    </div>
  );
}

function Tiles({ items, active, onPick }: { items: { id: string; name: string }[]; active?: string; onPick: (id: string) => void }) {
  return (
    <div className="tiles">
      {items.map((i) => (
        <div key={i.id} className={`tile${active === i.id ? " active" : ""}`} onClick={() => onPick(i.id)}>
          <span style={{ fontSize: 12, fontWeight: 600, textAlign: "center" }}>{i.name}</span>
        </div>
      ))}
    </div>
  );
}

/** Tiles that show a rendered preview of what each item does (hover to see it animate). */
function PreviewTiles({ kind, items, active, onPick }: { kind: PreviewKind; items: { id: string; name: string; category?: string }[]; active?: string; onPick: (id: string) => void }) {
  return (
    <div className="tiles">
      {items.map((i) =>
        i.id === "custom" ? (
          <div key={i.id} className={`tile${active === i.id ? " active" : ""}`} onClick={() => onPick(i.id)} title="Choose a .cube file">
            <span style={{ fontSize: 12, fontWeight: 600, textAlign: "center" }}>{i.name}…</span>
          </div>
        ) : (
          <PreviewTile key={i.id} kind={kind} id={i.id} name={i.name} active={active === i.id} onPick={() => onPick(i.id)} />
        ),
      )}
    </div>
  );
}

const Title = ({ children }: { children: ReactNode }) => <div className="section-title">{children}</div>;

/** Value of a (possibly keyframed) property at the playhead. */
function propAt(el: Element, prop: KeyframeProperty, fallback: number, playhead: number) {
  return evaluateKeyframes(el.keyframes?.[prop], Math.min(Math.max(playhead - el.start, 0), el.duration), fallback);
}

/** Property tabs and the tool panels each one stacks (filtered to the selected element's type). */
export const PROP_TABS: { id: string; label: string; icon: string; panels: string[] }[] = [
  { id: "text", label: "Text", icon: "text", panels: ["textEdit", "textPreset"] },
  { id: "captions", label: "Captions", icon: "captions", panels: ["captionsTranscript", "captionStyle"] },
  { id: "style", label: "Style", icon: "color", panels: ["textFont", "textStyle"] },
  { id: "basic", label: "Basic", icon: "basic", panels: ["transform", "opacity", "blend", "flip", "crop", "mask", "replace", "keyframeEasing"] },
  { id: "animation", label: "Animation", icon: "animation", panels: ["clipAnimation", "textAnimation"] },
  { id: "speed", label: "Speed", icon: "speed", panels: ["speed", "speedCurve", "reverse"] },
  { id: "audio", label: "Audio", icon: "volume", panels: ["volume", "fade", "ducking", "voiceEnhance", "noiseReduction", "extractAudio", "beats"] },
  { id: "color", label: "Color", icon: "adjust", panels: ["filters", "adjust", "adjustPresets", "hsl", "curves", "colorWheels", "lut"] },
  { id: "effects", label: "Effects", icon: "effects", panels: ["effects", "transitions"] },
  { id: "ai", label: "Smart", icon: "wand", panels: ["autoReframe", "cutout", "subjectEffect", "splitScreen", "textToSpeech"] },
];

/** Sections that start expanded (the rest open on click, and stay as the user left them). */
const OPEN = new Set(["textEdit", "captionsTranscript", "textFont", "textStyle", "transform", "opacity", "clipAnimation", "textAnimation", "speed", "speedCurve", "volume", "fade", "filters", "adjust", "effects", "transitions", "autoReframe", "textToSpeech"]);

/** The property tabs that apply to an element. */
export function tabsFor(el: Element) {
  const applies = new Set(TOOL_PANELS.filter((p) => p.data.appliesTo.includes(el.type)).map((p) => p.id));
  return PROP_TABS.map((t) => ({ ...t, panels: t.panels.filter((p) => applies.has(p)) })).filter((t) => t.panels.length);
}

const TYPE_ICON: Record<string, string> = { video: "media", image: "image", audio: "audio", text: "text", caption: "captions", shape: "shape", sticker: "sticker", adjustment: "adjust" };

export function Inspector({ tab: forced }: { tab?: string } = {}) {
  const s = useLive();
  const remembered = useUi("panel");
  const project = s.project!;
  const sel = selectedElements(s);

  if (sel.length === 0) return <ProjectPanel project={project} />;
  if (sel.length > 1) return <MultiPanel project={project} ids={sel.map((e) => e.id)} />;

  const el = sel[0];
  const tabs = tabsFor(el);
  const tab = tabs.find((t) => t.id === (forced ?? remembered)) ?? tabs[0];
  const onMain = mainTrack(project).elementIds.includes(el.id);
  const name = el.name ?? (el.type === "text" ? el.text : el.type === "caption" ? el.words.map((w) => w.text).join(" ") : "mediaId" in el ? project.media[el.mediaId]?.name : undefined) ?? el.type;
  return (
    <div className="inspector" data-type={el.type}>
      <div className="head">
        <span className={`type-badge t-${el.type}`}><Icon name={TYPE_ICON[el.type] ?? "layers"} size={16} /></span>
        <div className="grow head-text">
          <div className="kind">
            {el.type}
            {onMain ? " · main track" : ""}
          </div>
          <div className="name" title={name}>{name}</div>
          <div className="muted small">
            {el.start.toFixed(2)}s → {(el.start + el.duration).toFixed(2)}s ({el.duration.toFixed(2)}s)
          </div>
        </div>
        <button className="icon ghost" title="Duplicate" aria-label="Duplicate" onClick={() => run("duplicate", { elementId: el.id })}><Icon name="duplicate" size={16} /></button>
        <button className="icon ghost" title="Delete" aria-label="Delete" onClick={() => run("delete", { elementIds: [el.id] })}><Icon name="trash" size={16} /></button>
      </div>
      {!forced && (
        <div className="prop-tabs panel-list" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={t.id === tab.id} className={t.id === tab.id ? "on" : ""} onClick={() => ui.set({ panel: t.id })}>
              <Icon name={t.icon} size={17} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      )}
      <div className="pane">
        {tab.panels.map((id) => (
          <PanelSection key={id} id={id} single={tab.panels.length === 1}>
            <SelectedPanel id={id} el={el} project={project} onMain={onMain} />
          </PanelSection>
        ))}
      </div>
    </div>
  );
}

function PanelSection({ id, single, children }: { id: string; single: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(single || OPEN.has(id));
  const name = TOOL_PANELS.find((p) => p.id === id)?.name ?? id;
  if (single) return <section className="prop-section" data-panel={id}>{children}</section>;
  return (
    <section className={`prop-section${open ? " open" : ""}`} data-panel={id}>
      <button className="section-head" aria-expanded={open} onClick={() => {
        setOpen(!open);
        if (open) OPEN.delete(id);
        else OPEN.add(id);
      }}>
        <span>{name}</span>
        <Icon name="chevronDown" size={15} />
      </button>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

function SelectedPanel(props: Omit<Parameters<typeof PanelBody>[0], "playhead">) {
  const playhead = useUi("playhead");
  return <PanelBody {...props} playhead={playhead} />;
}

function ProjectPanel({ project }: { project: Project }) {
  const quality = useUi("previewQuality");
  const [brief, setBrief] = useState(project.brief);
  useEffect(() => setBrief(project.brief), [project.brief]);
  return (
    <div className="inspector">
      <div className="head">
        <span className="type-badge"><Icon name="settings" size={16} /></span>
        <div className="grow head-text">
          <div className="kind">Project</div>
          <div className="name">{project.name}</div>
          <div className="muted small">Select a clip on the timeline to edit it.</div>
        </div>
      </div>
      <div className="pane">
        <Title>Canvas</Title>
        <div className="ratio-picker" role="radiogroup" aria-label="Aspect ratio">
          {[["9:16", "Reels"], ["16:9", "YouTube"], ["1:1", "Square"], ["4:5", "Post"]].map(([a, hint]) => (
            <button key={a} role="radio" aria-checked={project.canvas.aspectRatio === a} className={project.canvas.aspectRatio === a ? "on" : ""} onClick={() => run("setCanvas", { aspectRatio: a })}>
              <span className="aspect-glyph" style={{ aspectRatio: a.replace(":", " / ") }} />
              <b>{a}</b>
              <span>{hint}</span>
            </button>
          ))}
        </div>
        <Select label="Resolution" value={project.canvas.resolution} options={["720p", "1080p", "4K"]} onChange={(v) => run("setCanvas", { resolution: v })} />
        <Select label="Frame rate" value={String(project.canvas.fps)} options={["24", "25", "30", "50", "60"]} onChange={(v) => run("setCanvas", { fps: Number(v) })} />
        <ColorField label="Background" value={project.canvas.backgroundColor} onChange={(v) => run("setCanvas", { backgroundColor: v })} />
        <Select label="Preview quality" value={quality} options={[["auto", "Auto"], ["draft", "Draft (faster)"], ["high", "High"]]} onChange={(v) => (v === "auto" || v === "draft" || v === "high") && ui.set({ previewQuality: v })} />
        <Title>Timeline</Title>
        <Toggle label="Magnetic main" value={project.rippleSettings.magnetEnabled} onChange={(v) => run("setRippleTiers", { magnetEnabled: v })} />
        <Toggle label="Snapping" value={project.rippleSettings.snappingEnabled} onChange={(v) => run("setRippleTiers", { snappingEnabled: v })} />
        <Toggle label="Ripple linked" value={project.rippleSettings.tier1RippleEnabled} onChange={(v) => run("setRippleTiers", { tier1RippleEnabled: v })} />
        <Toggle label="Ripple all" value={project.rippleSettings.tier2RippleEnabled} onChange={(v) => run("setRippleTiers", { tier2RippleEnabled: v })} />
        <Select label="Beat markers" value={project.beatDensity} options={["off", "lowest", "low", "medium", "high", "extreme"]} onChange={(v) => run("setBeatDensity", { density: v })} />
        <Title>Brief</Title>
        <textarea rows={5} style={{ width: "100%" }} placeholder="What this video is for (agents read this)" value={brief} onChange={(e) => setBrief(e.target.value)} onBlur={() => brief !== project.brief && run("setBrief", { brief })} />
        <TranscriptActions />
      </div>
    </div>
  );
}

type EditResult = { results?: { op: string; removedSeconds?: number; pauses?: number }[]; notes?: string[]; status?: string; error?: { message: string }; result?: { results?: { op: string; removedSeconds?: number }[] } };

/** Transcript-driven clean-up. Long jobs show progress and report what they did (or why they could not). */
function TranscriptActions() {
  const features = useFeatures();
  const [busy, setBusy] = useState<string | null>(null);
  const hasMain = mainTrack(useLive().project!).elementIds.length > 0;
  const summarize = (results: { op: string; removedSeconds?: number }[] | undefined) => {
    const removed = (results ?? []).reduce((s, r) => s + (r.removedSeconds ?? 0), 0);
    return removed > 0 ? `Removed ${removed.toFixed(1)} s` : "Nothing to remove";
  };
  const go = async (label: string, tool: string, args: Args) => {
    if (busy) return;
    if (!hasMain) return live.toast("info", "Add a clip to the main track first");
    setBusy(label);
    try {
      const r = await live.call<EditResult>(tool, args);
      if (r.status === "failed") live.toast("error", r.error?.message ?? `${label} failed`);
      else if (r.status === "running") live.toast("info", `${label} is still running in the background`);
      else live.toast("info", `${label}: ${summarize(r.results ?? r.result?.results)}`);
      for (const note of r.notes ?? []) if (/audio \(no transcript/.test(note)) live.toast("info", "Found the silences from the audio (no transcript needed)");
    } catch (e) {
      live.toast("error", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const words = !features || features.transcription;
  return (
    <>
      <Title>Transcript edits</Title>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button disabled={!!busy} onClick={() => void go("Remove silences", "edit", { ops: [{ op: "remove_silences" }] })}>
          Remove silences
        </button>
        <button disabled={!!busy || !words} onClick={() => void go("Remove fillers", "edit", { ops: [{ op: "remove_fillers" }] })}>
          Remove fillers
        </button>
        <button disabled={!!busy || !words} onClick={() => void go("Remove retakes", "edit", { ops: [{ op: "remove_retakes" }] })}>
          Remove retakes
        </button>
        <button className="primary" disabled={!!busy || !words} onClick={() => void go("Auto edit", "auto_edit", { wait_seconds: 1800 })}>
          Auto edit
        </button>
      </div>
      {busy && <div className="muted small" style={{ marginTop: 6 }}>{busy}… (transcribing first if needed)</div>}
      {!words && (
        <div className="muted small" style={{ marginTop: 6 }}>
          Fillers, retakes, captions and auto edit need whisper.cpp (whisper-cli) and a Whisper model, which are not installed. Remove silences still works: it finds the pauses in the audio.
        </div>
      )}
    </>
  );
}

/** A note shown in panels that need software this computer does not have. */
function Unavailable({ features, need }: { features: Features | null; need: keyof Features }) {
  if (!features || features[need]) return null;
  const text = {
    vision: "This needs Apple's Vision framework, which is only available on macOS.",
    speech: process.platform === "win32" ? "No Windows voice is available (System.Speech could not be loaded)." : "Text to speech needs eSpeak NG on Linux (sudo apt install espeak-ng), then restart the app.",
    transcription: "This needs whisper.cpp (whisper-cli) and a Whisper model.",
  }[need];
  return <div className="muted small" style={{ marginBottom: 8, color: "var(--accent)" }}>{text}</div>;
}

function MultiPanel({ project, ids }: { project: Project; ids: string[] }) {
  const media = ids.filter((id) => ["video", "image"].includes(project.elements[id]?.type));
  return (
    <div className="inspector">
      <div className="head">
        <div className="kind">Selection</div>
        <div style={{ fontWeight: 600, marginTop: 2 }}>{ids.length} items</div>
      </div>
      <div className="pane">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button onClick={() => run("splitAt", { times: [ui.get().playhead], elementIds: ids })}><Icon name="split" size={15} /> Split at playhead</button>
          {media.length === 2 && <button onClick={() => run("splitScreen", { elementIds: media })}>Split screen</button>}
          <button onClick={() => run("delete", { elementIds: ids })}>Delete</button>
        </div>
      </div>
    </div>
  );
}

function PanelBody({ id, el, project, playhead, onMain }: { id: string; el: Element; project: Project; playhead: number; onMain: boolean }) {
  const features = useFeatures();
  const noVision = !!features && !features.vision;
  const elementId = el.id;
  const call = (tool: string, args: Args = {}) => run(tool, { elementId, ...args });
  const kfAt = (prop: KeyframeProperty) => (el.keyframes?.[prop]?.length ? playhead : undefined);
  const addKf = (prop: KeyframeProperty, value: number) => () => call("setTransformKeyframe", { property: prop, time: playhead, value });

  switch (id) {
    case "transform": {
      if (!("transform" in el)) return null;
      const t = el.transform;
      const x = propAt(el, "x", t.x, playhead);
      const y = propAt(el, "y", t.y, playhead);
      const sc = propAt(el, "scale", t.scale, playhead);
      const rot = propAt(el, "rotationDegrees", t.rotationDegrees, playhead);
      const set = (prop: KeyframeProperty, v: number) => call("setTransform", { [prop]: v, ...(kfAt(prop) !== undefined ? { time: playhead } : {}) });
      return (
        <>
          <Slider reset={0.5} label="Position X" value={x} min={-0.5} max={1.5} onCommit={(v) => set("x", v)} keyframed={!!el.keyframes?.x?.length} onKeyframe={addKf("x", x)} />
          <Slider reset={0.5} label="Position Y" value={y} min={-0.5} max={1.5} onCommit={(v) => set("y", v)} keyframed={!!el.keyframes?.y?.length} onKeyframe={addKf("y", y)} />
          <Slider reset={1} label="Scale" value={sc} min={0.05} max={5} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => set("scale", v)} keyframed={!!el.keyframes?.scale?.length} onKeyframe={addKf("scale", sc)} />
          <Slider label="Rotation" value={rot} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}°`} onCommit={(v) => set("rotationDegrees", v)} keyframed={!!el.keyframes?.rotationDegrees?.length} onKeyframe={addKf("rotationDegrees", rot)} />
          {(el.type === "video" || el.type === "image") && <Select label="Fit" value={t.fit} options={["cover", "contain"]} onChange={(v) => call("setTransform", { fit: v })} />}
          {el.type === "text" && (
            <div className="row" style={{ flexWrap: "wrap", marginTop: 8 }}>
              {["top", "upperThird", "center", "lowerThird", "bottom"].map((p) => (
                <button key={p} onClick={() => call("setTextPosition", { preset: p })}>
                  {p.replace(/([A-Z])/g, " $1").toLowerCase()}
                </button>
              ))}
            </div>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => call("setTransform", { x: 0.5, y: 0.5, scale: 1, rotationDegrees: 0 })}>Reset</button>
          </div>
        </>
      );
    }
    case "crop": {
      if (el.type !== "video" && el.type !== "image") return null;
      const c = el.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
      const set = (k: keyof typeof c, v: number) => call("setCrop", { ...c, [k]: v });
      return (
        <>
          {(["left", "top", "right", "bottom"] as const).map((k) => (
            <Slider key={k} label={k[0].toUpperCase() + k.slice(1)} value={c[k]} min={0} max={0.9} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => set(k, v)} />
          ))}
          <button onClick={() => call("clearCrop")}>Clear crop</button>
        </>
      );
    }
    case "mask": {
      if (!("mask" in el)) return null;
      const m = el.mask;
      const set = (patch: Args) => call("setMask", patch);
      return (
        <>
          <Select label="Shape" value={m.type} options={["none", "rectangle", "ellipse", "line", "shutter"]} onChange={(v) => set({ type: v })} />
          {m.type !== "none" && (
            <>
              <Slider reset={0.5} label="Center X" value={m.centerX} min={0} max={1} onCommit={(v) => set({ centerX: v })} />
              <Slider reset={0.5} label="Center Y" value={m.centerY} min={0} max={1} onCommit={(v) => set({ centerY: v })} />
              <Slider reset={0.6} label="Width" value={m.sizeW} min={0} max={1.5} onCommit={(v) => set({ sizeW: v })} />
              <Slider reset={0.6} label="Height" value={m.sizeH} min={0} max={1.5} onCommit={(v) => set({ sizeH: v })} />
              <Slider label="Rotation" value={m.rotation} min={-180} max={180} step={1} onCommit={(v) => set({ rotation: v })} />
              <Slider label="Feather" value={m.feather} min={0} max={1} onCommit={(v) => set({ feather: v })} />
              <Slider label="Corners" value={m.cornerRadius} min={0} max={1} onCommit={(v) => set({ cornerRadius: v })} />
              <Toggle label="Invert" value={m.invert} onChange={(v) => set({ invert: v })} />
            </>
          )}
        </>
      );
    }
    case "flip":
      if (el.type !== "video" && el.type !== "image") return null;
      return (
        <>
          <Toggle label="Horizontal" value={el.flip.horizontal} onChange={(v) => call("setFlip", { horizontal: v })} />
          <Toggle label="Vertical" value={el.flip.vertical} onChange={(v) => call("setFlip", { vertical: v })} />
        </>
      );
    case "opacity": {
      if (!("opacity" in el)) return null;
      const o = propAt(el, "opacity", el.opacity, playhead);
      return <Slider reset={1} label="Opacity" value={o} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => (kfAt("opacity") !== undefined ? call("setTransformKeyframe", { property: "opacity", time: playhead, value: v }) : call("setOpacity", { opacity: v }))} keyframed={!!el.keyframes?.opacity?.length} onKeyframe={addKf("opacity", o)} />;
    }
    case "blend":
      if (!("blendMode" in el)) return null;
      return <Select label="Blend mode" value={el.blendMode} options={["normal", "multiply", "screen", "overlay", "darken", "lighten", "colorDodge", "colorBurn", "softLight", "hardLight", "difference", "add"]} onChange={(v) => call("setBlendMode", { blendMode: v })} />;
    case "splitScreen":
      return (
        <>
          <div className="muted small">Stacks this clip with the clip selected next to it (or duplicates it) in a two-panel vertical layout.</div>
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={() => run("splitScreen", { elementIds: [elementId], background: "blur" })}>Stack (blur)</button>
            <button onClick={() => run("splitScreen", { elementIds: [elementId], background: "solid" })}>Stack (solid)</button>
          </div>
        </>
      );
    case "autoReframe":
      return (
        <>
          <Unavailable features={features} need="vision" />
          <div className="muted small">Tracks faces and people to keep them in frame for the project aspect.</div>
          <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
            <button className="primary" disabled={noVision} onClick={() => run("autoReframe", { elementIds: [elementId], mode: "follow" })}>
              Follow subject
            </button>
            <button disabled={noVision} onClick={() => run("autoReframe", { elementIds: [elementId], mode: "static" })}>Static</button>
            <button disabled={noVision} onClick={() => run("autoReframe", { elementIds: [elementId], splitTwoSpeakers: true })}>Two speakers</button>
          </div>
        </>
      );
    case "speed": {
      if (el.type !== "video" && el.type !== "audio") return null;
      const rate = el.speed.mode === "constant" ? el.speed.rate : 1;
      return (
        <>
          <Slider reset={1} label="Speed" value={rate} min={0.1} max={10} step={0.05} format={(v) => `${v.toFixed(2)}×`} onCommit={(v) => call("setSpeed", { rate: v })} />
          <div className="row" style={{ flexWrap: "wrap" }}>
            {[0.5, 1, 1.5, 2, 4].map((r) => (
              <button key={r} className={rate === r && el.speed.mode === "constant" ? "on" : ""} onClick={() => call("setSpeed", { rate: r })}>
                {r}×
              </button>
            ))}
          </div>
        </>
      );
    }
    case "speedCurve":
      if (el.type !== "video" && el.type !== "audio") return null;
      return (
        <Tiles
          items={[{ id: "none", name: "None" }, ...SPEED_PRESETS.map((p) => ({ id: p, name: p.replace("_", " ").toLowerCase() }))]}
          active={el.speed.mode === "curve" ? (el.speed as { preset?: string }).preset ?? "custom" : "none"}
          onPick={(p) => (p === "none" ? call("setSpeed", { rate: 1 }) : call("setSpeedCurve", { preset: p }))}
        />
      );
    case "reverse":
      if (el.type !== "video" && el.type !== "audio") return null;
      return (
        <>
          <Toggle label="Reverse" value={el.reversed} onChange={(v) => call("setReversed", { reversed: v })} />
          {el.type === "video" && el.reverseStatus === "pending" && <div className="muted small">Preparing reversed media…</div>}
        </>
      );
    case "split":
      return (
        <button className="primary" onClick={() => call("split", { time: playhead })} disabled={playhead <= el.start || playhead >= el.start + el.duration}>
          Split at playhead
        </button>
      );
    case "duplicate":
      return <button onClick={() => call("duplicate")}>Duplicate</button>;
    case "delete":
      return <button onClick={() => run("delete", { elementIds: [elementId] })}>Delete</button>;
    case "replace":
      return (
        <button
          onClick={() =>
            void ipcRenderer.invoke("pick-files", { multi: false }).then((f: string[]) => {
              if (f[0]) call("replaceElementMedia", { path: f[0] });
            })
          }
        >
          Replace media…
        </button>
      );
    case "keyframeEasing":
      return <KeyframesPanel el={el} playhead={playhead} />;
    case "volume": {
      if (el.type !== "video" && el.type !== "audio") return null;
      return (
        <>
          <Slider label="Volume" value={db(el.volume)} min={-60} max={20} step={0.5} format={(v) => `${v.toFixed(1)} dB`} onCommit={(v) => call("setSound", { volumeDb: v })} />
          <Toggle label="Mute" value={el.muted} onChange={(v) => call("setSound", { muted: v })} />
        </>
      );
    }
    case "voiceEnhance":
    case "noiseReduction": {
      if (el.type !== "video" && el.type !== "audio") return null;
      const ve = el.voiceEnhance;
      return (
        <>
          <Toggle label="Enabled" value={ve.enabled} onChange={(v) => call("setVoiceEnhance", { enabled: v })} />
          <Slider label="Reduce noise" value={ve.reduceNoise} min={0} max={100} step={1} onCommit={(v) => call("setVoiceEnhance", { reduceNoise: v, enabled: true })} />
          {id === "voiceEnhance" && <Slider label="Enhance voice" value={ve.enhanceVoice} min={0} max={100} step={1} onCommit={(v) => call("setVoiceEnhance", { enhanceVoice: v, enabled: true })} />}
        </>
      );
    }
    case "fade":
      if (el.type !== "video" && el.type !== "audio") return null;
      return (
        <>
          <Slider label="Fade in" value={el.fadeInSeconds} min={0} max={Math.min(10, el.duration)} step={0.05} format={(v) => `${v.toFixed(2)}s`} onCommit={(v) => call("setFade", { fadeInSeconds: v })} />
          <Slider label="Fade out" value={el.fadeOutSeconds} min={0} max={Math.min(10, el.duration)} step={0.05} format={(v) => `${v.toFixed(2)}s`} onCommit={(v) => call("setFade", { fadeOutSeconds: v })} />
        </>
      );
    case "ducking":
      if (el.type !== "audio") return null;
      return (
        <>
          <Toggle label="Duck under voice" value={el.ducking.enabled} onChange={(v) => call("setDucking", { enabled: v })} />
          <Slider reset={-12} label="Amount" value={el.ducking.amountDb} min={-40} max={0} step={0.5} format={(v) => `${v.toFixed(1)} dB`} onCommit={(v) => call("setDucking", { amountDb: v, enabled: true })} />
          <Slider reset={0.2} label="Attack" value={el.ducking.attackSeconds} min={0} max={2} step={0.01} format={(v) => `${v.toFixed(2)}s`} onCommit={(v) => call("setDucking", { attackSeconds: v })} />
          <Slider reset={0.4} label="Release" value={el.ducking.releaseSeconds} min={0} max={3} step={0.01} format={(v) => `${v.toFixed(2)}s`} onCommit={(v) => call("setDucking", { releaseSeconds: v })} />
        </>
      );
    case "extractAudio":
      if (el.type !== "video") return null;
      return el.audioDetached ? <div className="muted small">Audio already extracted.</div> : <button onClick={() => call("extractAudio")}>Extract audio</button>;
    case "beats":
      return (
        <>
          <button className="primary" onClick={() => call("audioOnsets", { addBeatMarkers: true })}>
            Detect beats
          </button>
          <Select label="Density" value={project.beatDensity} options={["off", "lowest", "low", "medium", "high", "extreme"]} onChange={(v) => run("setBeatDensity", { density: v })} />
          <button onClick={() => run("addBeatMarker", { time: playhead })}>Add marker at playhead</button>
          <div className="muted small" style={{ marginTop: 6 }}>
            {project.beatMarkers.length} markers
          </div>
        </>
      );
    case "adjust": {
      if (!("color" in el)) return null;
      const g = el.color.grade;
      return (
        <>
          {COLOR_GRADE_KEYS.map((k) => (
            <Slider key={k} label={k[0].toUpperCase() + k.slice(1)} value={g[k]} min={k === "fade" ? 0 : -100} max={100} step={1} onCommit={(v) => call("setColorGrade", { [k]: v })} />
          ))}
          <button onClick={() => call("setColorGrade", { reset: true })}>Reset</button>
        </>
      );
    }
    case "adjustPresets":
      return <PreviewTiles kind="adjust" items={ADJUST_PRESETS} onPick={(p) => call("setColorGrade", { presetId: p })} />;
    case "colorWheels": {
      if (!("color" in el)) return null;
      return (
        <>
          {WHEELS.map((w) => (
            <div key={w}>
              <Title>{w}</Title>
              <Slider label="Hue" value={el.color.wheels[w].hue} min={0} max={360} step={1} format={(v) => `${Math.round(v)}°`} onCommit={(v) => call("setColorWheel", { wheel: w, hue: v })} />
              <Slider label="Intensity" value={el.color.wheels[w].intensity} min={0} max={100} step={1} onCommit={(v) => call("setColorWheel", { wheel: w, intensity: v })} />
            </div>
          ))}
        </>
      );
    }
    case "hsl":
      if (!("color" in el)) return null;
      return <HslPanel hsl={el.color.hsl} call={call} />;
    case "curves":
      if (!("color" in el)) return null;
      return <CurvesPanel points={el.color.curves} onCommit={(channel, points) => call("setCurve", { channel, points })} />;
    case "filters": {
      if (!("color" in el)) return null;
      const f = el.color.filter;
      return (
        <>
          {f && <Slider reset={100} label="Intensity" value={f.intensity} min={0} max={100} step={1} onCommit={(v) => call("applyFilter", { filterId: f.id, intensity: v })} />}
          <PreviewTiles kind="filter" items={FILTERS_CATALOG} active={f?.id ?? "none"} onPick={(p) => call("applyFilter", { filterId: p })} />
        </>
      );
    }
    case "lut": {
      if (!("color" in el)) return null;
      const l = el.color.lut;
      return (
        <>
          {l && <Slider reset={100} label="Intensity" value={l.intensity} min={0} max={100} step={1} onCommit={(v) => call("applyLUT", { lutId: l.id, ...(l.cubePath ? { cubePath: l.cubePath } : {}), intensity: v })} />}
          <PreviewTiles
            kind="lut"
            items={[{ id: "none", name: "None" }, ...LUTS_CATALOG]}
            active={l?.id ?? "none"}
            onPick={(p) =>
              p === "custom"
                ? void ipcRenderer.invoke("pick-files", { extensions: ["cube"], multi: false }).then((f: string[]) => f[0] && call("applyLUT", { lutId: "custom", cubePath: f[0] }))
                : call("applyLUT", { lutId: p })
            }
          />
        </>
      );
    }
    case "effects":
      if (!("effects" in el)) return null;
      return <EffectsPanel el={el} call={call} />;
    case "transitions": {
      const next = project.transitions.find((t) => t.fromElementId === elementId);
      if (!onMain) return <div className="muted small">Transitions go between main-track clips.</div>;
      return (
        <>
          {next && (
            <>
              <Slider reset={0.5} label="Duration" value={next.durationSeconds} min={0.1} max={2} step={0.05} format={(v) => `${v.toFixed(2)}s`} onCommit={(v) => call("addTransition", { fromElementId: elementId, type: next.type, durationSeconds: v })} />
              <button onClick={() => run("addTransition", { fromElementId: elementId, type: "none" })}>Remove</button>
            </>
          )}
          <PreviewTiles kind="transition" items={TRANSITIONS_CATALOG} active={next?.type ?? "none"} onPick={(t) => run("addTransition", { fromElementId: elementId, type: t })} />
        </>
      );
    }
    case "cutout":
      return (
        <>
          <Unavailable features={features} need="vision" />
          <div className="muted small">Lift the person or subject at the playhead into a sticker, or track it for the rest of the clip.</div>
          <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
            <button className="primary" disabled={noVision} onClick={() => call("addStickerFromCutout", { time: playhead, kind: "person" })}>
              Cut out person
            </button>
            <button disabled={noVision} onClick={() => call("addStickerFromCutout", { time: playhead, kind: "subject" })}>Cut out subject</button>
            <button disabled={noVision} onClick={() => call("trackObject", { target: "person" })}>Track person</button>
          </div>
        </>
      );
    case "subjectEffect":
      return (
        <>
          <Unavailable features={features} need="vision" />
          <PreviewTiles
            kind="subject"
            items={EFFECTS_CATALOG.filter((e) => e.data.requiresSubjectMask)}
            onPick={(fx) =>
              noVision
                ? live.toast("info", "Subject effects need Apple's Vision framework (macOS)")
                : void live.run("applySubjectEffect", { elementId, effectId: fx, waitSeconds: 0 }).then((r) => r && live.toast("info", "Tracking the subject… the effect appears when it finishes"))
            }
          />
        </>
      );
    case "textEdit":
      if (el.type !== "text") return null;
      return <TextEdit key={el.id} text={el.text} onCommit={(text) => call("editText", { text })} />;
    case "textStyle": {
      if (el.type !== "text" && el.type !== "caption") return null;
      const st = el.type === "text" ? el.style : { ...(CAPTION_STYLES.find((c) => c.id === el.styleId)?.data.style ?? {}), ...el.styleOverrides };
      const set = (patch: Args) => (el.type === "text" ? call("setTextStyle", patch) : run("setCaptionStyle", { styleId: el.styleId, elementIds: [elementId], overrides: patch }));
      return (
        <>
          <Slider reset={0.06} label="Size" value={st.fontSizeNorm ?? 0.06} min={0.01} max={0.3} step={0.002} format={(v) => `${Math.round(v * 1000) / 10}%`} onCommit={(v) => set({ fontSizeNorm: v })} />
          <ColorField label="Color" value={st.color} onChange={(v) => set({ color: v })} />
          <ColorField label="Stroke" value={st.strokeColor} onChange={(v) => set({ strokeColor: v, strokeWidth: st.strokeWidth || 0.08 })} />
          <Slider label="Stroke width" value={st.strokeWidth ?? 0} min={0} max={0.3} step={0.005} onCommit={(v) => set({ strokeWidth: v })} />
          <ColorField label="Background" value={st.backgroundColor} onChange={(v) => set({ backgroundColor: v })} />
          <ColorField label="Shadow" value={st.shadowColor} onChange={(v) => set({ shadowColor: v, shadowBlur: st.shadowBlur || 0.1 })} />
          <Select label="Align" value={st.align ?? "center"} options={["left", "center", "right"]} onChange={(v) => set({ align: v })} />
          <Slider reset={1.15} label="Line height" value={st.lineHeight ?? 1.2} min={0.6} max={2.5} step={0.05} onCommit={(v) => set({ lineHeight: v })} />
          <Slider label="Letter spacing" value={st.letterSpacing ?? 0} min={-0.2} max={1} step={0.01} onCommit={(v) => set({ letterSpacing: v })} />
          <Toggle label="Uppercase" value={!!st.uppercase} onChange={(v) => set({ uppercase: v })} />
        </>
      );
    }
    case "textFont": {
      if (el.type !== "text" && el.type !== "caption") return null;
      const family = el.type === "text" ? el.style.fontFamily : el.styleOverrides.fontFamily ?? CAPTION_STYLES.find((c) => c.id === el.styleId)?.data.style.fontFamily;
      return (
        <div className="tiles">
          {FONTS.map((f) => (
            <div
              key={f.id}
              className={`tile${family === f.data.family ? " active" : ""}`}
              onClick={() => (el.type === "text" ? call("setTextFont", { fontFamily: f.data.family }) : run("setCaptionStyle", { styleId: el.styleId, elementIds: [elementId], overrides: { fontFamily: f.data.family } }))}
            >
              <span style={{ fontFamily: fontStack(f.data.family), fontSize: 16 }}>Aa</span>
              <span className="label">{f.name}</span>
            </div>
          ))}
        </div>
      );
    }
    case "textAnimation": {
      if (el.type !== "text") return null;
      return <AnimationPicker kind="text" el={el} onSet={(slot, ref) => call("setTextAnimation", { [slot]: ref })} />;
    }
    case "clipAnimation": {
      if (el.type !== "video" && el.type !== "image" && el.type !== "sticker" && el.type !== "shape") return null;
      return <AnimationPicker kind="clip" el={el} onSet={(slot, ref) => call("setClipAnimation", { [slot]: ref })} />;
    }
    case "textPreset":
      if (el.type !== "text") return null;
      return (
        <div className="tiles text-tiles">
          {TEXT_PRESETS.map((p) => (
            <button key={p.id} className={`tile text-tile${el.presetId === p.id ? " active" : ""}`} onClick={() => call("applyTextPreset", { presetId: p.id })} title={p.name}>
              <PresetSample style={p.data.style} />
              <span className="label">{p.name}</span>
            </button>
          ))}
        </div>
      );
    case "textToSpeech":
      if (el.type !== "text") return null;
      return (
        <>
          <Unavailable features={features} need="speech" />
          {(!features || features.speech) && <TtsPanel onSpeak={(voice, rate) => call("applyTextToSpeech", { ...(voice ? { voice } : {}), rate })} />}
        </>
      );
    case "captionsTranscript":
      if (el.type !== "caption") return null;
      return <CaptionWords el={el} />;
    case "captionStyle":
      if (el.type !== "caption") return null;
      return (
        <>
          <ColorField label="Highlight" value={el.highlightColor} onChange={(v) => run("setCaptionHighlightColor", { color: v })} />
          <Tiles items={CAPTION_STYLES} active={el.styleId} onPick={(styleId) => run("setCaptionStyle", { styleId })} />
        </>
      );
    default:
      return <div className="muted small">No controls for this panel.</div>;
  }
}

function HslPanel({ hsl, call }: { hsl: Record<(typeof HSL_BANDS)[number], { hue: number; saturation: number; luminance: number }>; call: (tool: string, args: Args) => void }) {
  const [band, setBand] = useState<(typeof HSL_BANDS)[number]>("red");
  const b = hsl[band];
  return (
    <>
      <div className="chips">
        {HSL_BANDS.map((h) => (
          <button key={h} className={band === h ? "on" : ""} onClick={() => setBand(h)}>
            {h}
          </button>
        ))}
      </div>
      <Slider label="Hue" value={b.hue} min={-100} max={100} step={1} onCommit={(v) => call("setHSL", { band, hue: v })} />
      <Slider label="Saturation" value={b.saturation} min={-100} max={100} step={1} onCommit={(v) => call("setHSL", { band, saturation: v })} />
      <Slider label="Luminance" value={b.luminance} min={-100} max={100} step={1} onCommit={(v) => call("setHSL", { band, luminance: v })} />
    </>
  );
}

/** Drag the points of a tone curve; click empty space to add, double-click a point to remove. */
function CurvesPanel({ points, onCommit }: { points: Record<"luma" | "red" | "green" | "blue", { x: number; y: number }[]>; onCommit: (channel: string, pts: { x: number; y: number }[]) => void }) {
  const [channel, setChannel] = useState<"luma" | "red" | "green" | "blue">("luma");
  const [drag, setDrag] = useState<{ x: number; y: number }[] | null>(null);
  const [idx, setIdx] = useState(-1);
  const pts = drag ?? points[channel];
  const S = 240;
  const color = { luma: "#ffffff", red: "#ff5a5a", green: "#5aff7a", blue: "#5a9bff" }[channel];
  const pos = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)) };
  };
  return (
    <>
      <div className="chips">
        {(["luma", "red", "green", "blue"] as const).map((c) => (
          <button key={c} className={channel === c ? "on" : ""} onClick={() => setChannel(c)}>
            {c}
          </button>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${S} ${S}`}
        style={{ width: "100%", aspectRatio: "1", background: "#16171b", borderRadius: 8, touchAction: "none" }}
        onPointerDown={(e) => {
          const p = pos(e);
          let i = pts.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.05);
          let next = [...pts];
          if (i < 0) {
            next = [...pts, p].sort((a, b) => a.x - b.x);
            i = next.indexOf(p);
          }
          capturePointer(e.currentTarget, e.pointerId);
          setDrag(next);
          setIdx(i);
        }}
        onPointerMove={(e) => {
          if (!drag || idx < 0) return;
          const p = pos(e);
          const next = [...drag];
          const lo = idx > 0 ? next[idx - 1].x + 0.01 : 0;
          const hi = idx < next.length - 1 ? next[idx + 1].x - 0.01 : 1;
          next[idx] = { x: Math.min(hi, Math.max(lo, p.x)), y: p.y };
          setDrag(next);
        }}
        onPointerUp={() => {
          if (drag) onCommit(channel, drag);
          setDrag(null);
          setIdx(-1);
        }}
        onDoubleClick={(e) => {
          const p = pos(e as unknown as React.PointerEvent<SVGSVGElement>);
          const i = points[channel].findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.05);
          if (i > 0 && i < points[channel].length - 1) onCommit(channel, points[channel].filter((_, j) => j !== i));
        }}
      >
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g} stroke="#2a2c33">
            <line x1={g * S} y1={0} x2={g * S} y2={S} />
            <line x1={0} y1={g * S} x2={S} y2={g * S} />
          </g>
        ))}
        <line x1={0} y1={S} x2={S} y2={0} stroke="#33353d" strokeDasharray="4 4" />
        <polyline fill="none" stroke={color} strokeWidth={2} points={pts.map((p) => `${p.x * S},${(1 - p.y) * S}`).join(" ")} />
        {pts.map((p, i) => (
          <circle key={i} cx={p.x * S} cy={(1 - p.y) * S} r={5} fill={i === idx ? color : "#0d0e11"} stroke={color} strokeWidth={2} />
        ))}
      </svg>
      <button style={{ marginTop: 8 }} onClick={() => onCommit(channel, [{ x: 0, y: 0 }, { x: 1, y: 1 }])}>
        Reset {channel}
      </button>
    </>
  );
}

function EffectsPanel({ el, call }: { el: Extract<Element, { effects: unknown }>; call: (tool: string, args: Args) => void }) {
  return (
    <>
      {el.effects.map((fx) => {
        const def = EFFECTS_CATALOG.find((e) => e.id === fx.effectId);
        return (
          <div key={fx.instanceId} style={{ borderBottom: "1px solid var(--line)", paddingBottom: 6, marginBottom: 6 }}>
            <div className="row">
              <b className="grow" style={{ flex: 1 }}>
                {def?.name ?? fx.effectId}
              </b>
              <button className="icon ghost" title="Remove" onClick={() => call("applyEffect", { effectId: fx.effectId, instanceId: fx.instanceId, remove: true })}>
                ✕
              </button>
            </div>
            <Slider reset={100} label="Intensity" value={fx.intensity} min={0} max={100} step={1} onCommit={(v) => call("applyEffect", { effectId: fx.effectId, instanceId: fx.instanceId, intensity: v })} />
            {def?.data.params
              .filter((p) => p.type === "number")
              .map((p) => (
                <Slider key={p.name} reset={Number(p.default)} label={p.name.replace(/([A-Z])/g, " $1").toLowerCase().replace(/^./, (c) => c.toUpperCase())} value={Number(fx.params[p.name] ?? p.default)} min={p.min ?? 0} max={p.max ?? 100} onCommit={(v) => call("applyEffect", { effectId: fx.effectId, instanceId: fx.instanceId, params: { [p.name]: v } })} />
              ))}
          </div>
        );
      })}
      <Title>Add effect</Title>
      <PreviewTiles kind="effect" items={EFFECTS_CATALOG.filter((e) => !e.data.requiresSubjectMask)} onPick={(effectId) => call("applyEffect", { effectId })} />
    </>
  );
}

function KeyframesPanel({ el, playhead }: { el: Element; playhead: number }) {
  const props = Object.entries(el.keyframes ?? {}).filter(([, k]) => k && k.length) as [KeyframeProperty, { offsetSeconds: number; value: number; easing?: { type: string } }[]][];
  if (!props.length) return <div className="muted small">No keyframes yet. Use the ◆ next to a slider (Transform, Opacity) to add one at the playhead.</div>;
  return (
    <>
      {props.map(([prop, kfs]) => (
        <div key={prop}>
          <Title>{prop}</Title>
          {kfs.map((k) => (
            <div key={k.offsetSeconds} className="list-row">
              <button className="icon ghost" title="Go to keyframe" onClick={() => seek(el.start + k.offsetSeconds)}>
                ◆
              </button>
              <span className="grow small">
                {(el.start + k.offsetSeconds).toFixed(2)}s = {k.value.toFixed(3)}
              </span>
              <select value={k.easing?.type ?? "linear"} onChange={(e) => run("setKeyframeEasing", { elementId: el.id, property: prop, offsetSeconds: k.offsetSeconds, easing: { type: e.target.value } })}>
                {["linear", "easeIn", "easeOut", "easeInOut", "hold"].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <button className="icon ghost" title="Remove" onClick={() => run("removeTransformKeyframe", { elementId: el.id, property: prop, offsetSeconds: k.offsetSeconds })}>
                ✕
              </button>
            </div>
          ))}
        </div>
      ))}
      <div className="muted small" style={{ marginTop: 8 }}>
        Playhead at {(playhead - el.start).toFixed(2)}s into the clip.
      </div>
    </>
  );
}

function TextEdit({ text, onCommit }: { text: string; onCommit: (t: string) => void }) {
  const [v, setV] = useState(text);
  return <textarea rows={4} style={{ width: "100%" }} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== text && v.trim() && onCommit(v)} />;
}

function TtsPanel({ onSpeak }: { onSpeak: (voice: string, rate: number) => void }) {
  const [voices, setVoices] = useState<{ name: string; locale: string }[]>([]);
  const [voice, setVoice] = useState("");
  const [rate, setRate] = useState(180);
  useEffect(() => {
    void live.call<{ voices: { name: string; locale: string }[] }>("ttsVoices", { locale: "en" }).then((r) => setVoices(r.voices)).catch(() => {});
  }, []);
  return (
    <>
      <Select label="Voice" value={voice} options={[["", "System default"], ...voices.map((v) => [v.name, `${v.name} (${v.locale})`] as [string, string])]} onChange={setVoice} />
      <Slider reset={180} label="Rate (wpm)" value={rate} min={90} max={360} step={5} onCommit={setRate} />
      <button className="primary" onClick={() => onSpeak(voice, rate)}>
        Generate voice
      </button>
    </>
  );
}

function CaptionWords({ el }: { el: Extract<Element, { type: "caption" }> }) {
  const [text, setText] = useState(el.words.map((w) => w.text).join(" "));
  return (
    <>
      <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
        {el.words.map((w) => (
          <span
            key={String(w.id)}
            className={`word${w.highlighted ? " on" : ""}`}
            title="Click to highlight · double-click to split before this word"
            onClick={() => run("setCaptionHighlights", { elementId: el.id, wordIds: [w.id], highlighted: !w.highlighted })}
            onDoubleClick={() => run("splitCaption", { elementId: el.id, beforeWordId: w.id })}
          >
            {w.text}
          </span>
        ))}
      </div>
      <Title>Edit text</Title>
      <textarea rows={3} style={{ width: "100%" }} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== el.words.map((w) => w.text).join(" ") && run("editCaption", { elementId: el.id, text })} />
      <button style={{ marginTop: 8 }} onClick={() => run("generateCaptions", {})}>
        Regenerate all captions
      </button>
    </>
  );
}

type AnimSlot = "in" | "out" | "loop";
type AnimRefs = { in?: { id: string; durationSeconds: number }; out?: { id: string; durationSeconds: number }; loop?: { id: string; durationSeconds: number } };

/** In / Out / Combo (or Loop) animation tiles that play their motion on hover, plus the duration. */
function AnimationPicker({ kind, el, onSet }: { kind: "clip" | "text"; el: Element; onSet: (slot: AnimSlot, ref: { id: string; durationSeconds?: number }) => void }) {
  const anim = ((el as { animation?: AnimRefs }).animation ?? {}) as AnimRefs;
  const [slot, setSlot] = useState<AnimSlot>(anim.in ? "in" : anim.out ? "out" : anim.loop ? "loop" : "in");
  const catalog = kind === "clip" ? CLIP_ANIMATIONS : TEXT_ANIMATIONS;
  const items = catalog.filter((a) => a.data.slot === slot);
  const current = anim[slot];
  const maxDuration = slot === "loop" ? 4 : Math.max(0.2, Math.min(5, el.duration));
  return (
    <>
      <div className="segmented anim-slots" role="tablist">
        {(["in", "out", "loop"] as const).map((k) => (
          <button key={k} role="tab" aria-selected={slot === k} className={slot === k ? "on" : ""} onClick={() => setSlot(k)}>
            {k === "in" ? "In" : k === "out" ? "Out" : kind === "clip" ? "Combo" : "Loop"}
            {anim[k] && <i className="dot" />}
          </button>
        ))}
      </div>
      <div className="tiles anim-tiles">
        <button className={`tile anim-tile${!current ? " active" : ""}`} onClick={() => onSet(slot, { id: "none" })} title="No animation">
          <div className="anim-stage"><Icon name="close" size={20} /></div>
          <span className="label">None</span>
        </button>
        {items.map((a) => (
          <AnimTile key={a.id} kind={kind} slot={slot} id={a.id} name={a.name} active={current?.id === a.id} onPick={() => onSet(slot, { id: a.id, ...(current ? { durationSeconds: current.durationSeconds } : {}) })} />
        ))}
      </div>
      {current && (
        <Slider
          label={slot === "loop" ? (kind === "clip" && current.id && ["ken_burns", "slow_zoom_out", "pan_left", "pan_right"].includes(current.id) ? "Speed (whole clip)" : "Cycle") : "Duration"}
          value={Math.min(current.durationSeconds, maxDuration)}
          min={0.1}
          max={maxDuration}
          step={0.05}
          format={(v) => `${v.toFixed(1)}s`}
          reset={slot === "loop" ? (kind === "clip" ? 2 : 1) : kind === "clip" ? 0.6 : 0.4}
          onCommit={(v) => onSet(slot, { id: current.id, durationSeconds: v })}
        />
      )}
    </>
  );
}

/** A tile whose little card moves the way the animation moves (looping while hovered). */
function AnimTile({ kind, slot, id, name, active, onPick }: { kind: "clip" | "text"; slot: AnimSlot; id: string; name: string; active: boolean; onPick: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    const pose = (t: number) => {
      const node = card.current;
      if (!node) return;
      const total = 1.6;
      const local = slot === "out" ? 0.8 + (t % total) : t % total;
      const ref = { id, durationSeconds: slot === "loop" ? 0.8 : 0.8 };
      const anim = { [slot]: ref } as AnimRefs;
      const m =
        kind === "clip"
          ? evaluateClipAnimation(anim, local, slot === "loop" ? total : 1.6)
          : (() => {
              const a = evaluateTextAnimation({ animation: anim, duration: 1.6 } as never, local);
              return { ...a, dx: a.dx * 3, dy: a.dy * 3 };
            })();
      node.style.transform = `translate(${m.dx * 60}%, ${m.dy * 60}%) scale(${m.scale}) rotate(${m.rotation}deg)`;
      node.style.opacity = String(Math.max(0, Math.min(1, m.opacity)));
      node.style.filter = "blur" in m && m.blur > 0.01 ? `blur(${m.blur * 4}px)` : "";
    };
    if (!hover) {
      pose(slot === "in" ? 0.25 : slot === "out" ? 0.55 : 0.3);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      pose((now - start) / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hover, kind, slot, id]);
  return (
    <button className={`tile anim-tile${active ? " active" : ""}`} data-anim={id} onClick={onPick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)} title={name}>
      <div className="anim-stage">
        <div ref={card} className={`anim-card k-${kind}`}>{kind === "text" ? "Aa" : ""}</div>
      </div>
      <span className="label">{name}</span>
    </button>
  );
}

function PresetSample({ style }: { style: (typeof TEXT_PRESETS)[number]["data"]["style"] }) {
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
        WebkitTextStroke: style.strokeColor && style.strokeWidth ? `${Math.max(1, Math.min(3, style.strokeWidth * 14))}px ${style.strokeColor}` : undefined,
        paintOrder: "stroke fill",
        textShadow: style.shadowColor ? `${(style.shadowOffsetX ?? 0) * 20}px ${(style.shadowOffsetY ?? 0) * 20}px ${(style.shadowBlur ?? 0) * 18}px ${style.shadowColor}` : undefined,
        fontSize: 16,
      }}
    >
      Text
    </span>
  );
}
