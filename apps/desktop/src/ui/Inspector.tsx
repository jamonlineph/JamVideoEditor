import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ipcRenderer } from "electron";
import {
  ADJUST_PRESETS,
  COLOR_GRADE_KEYS,
  EFFECTS_CATALOG,
  FILTERS_CATALOG,
  HSL_BANDS,
  LUTS_CATALOG,
  SPEED_PRESETS,
  TEXT_ANIMATIONS,
  TOOL_PANELS,
  TRANSITIONS_CATALOG,
  WHEELS,
  evaluateKeyframes,
  mainTrack,
  type Element,
  type KeyframeProperty,
  type Project,
} from "@openedits/core";
import { live, selectedElements, useFeatures, useLive, type Features } from "./live.js";
import { ui, useUi, capturePointer, seek } from "./uiStore.js";
import { PreviewTile } from "./PreviewTile.js";
import { EditorIcon } from "./EditorIcon.js";
import { TextStylePanel } from "./TextStylePanel.js";
import type { PreviewKind } from "./thumbs.js";

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
        <button className={value ? "on" : ""} onClick={() => onChange(!value)}>
          {value ? "On" : "Off"}
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

export function Inspector() {
  const s = useLive();
  const activePanel = useUi("panel");
  const project = s.project!;
  const sel = selectedElements(s);

  if (sel.length === 0) return <ProjectPanel project={project} />;
  if (sel.length > 1) return <MultiPanel project={project} ids={sel.map((e) => e.id)} />;

  const el = sel[0];
  const styleAliases = ["textFont", "textPreset", "captionStyle"];
  const panels = TOOL_PANELS.filter((p) => p.data.appliesTo.includes(el.type) && !styleAliases.includes(p.id));
  const defaultPanel = el.type === "text" || el.type === "caption" ? "textStyle" : panels[0]?.id;
  const requestedPanel = activePanel ?? s.appState?.activeTool ?? defaultPanel;
  const panel = panels.find((p) => p.id === (styleAliases.includes(requestedPanel) ? "textStyle" : requestedPanel)) ?? panels.find((p) => p.id === defaultPanel) ?? panels[0];
  const onMain = mainTrack(project).elementIds.includes(el.id);
  return (
    <div className="inspector">
      <div className="head">
        <div className="kind">
          {el.type}
          {onMain ? " · main track" : ""}
        </div>
        <div className="inspector-selection-name">{el.name ?? (el.type === "text" ? el.text : "mediaId" in el ? project.media[el.mediaId]?.name ?? el.type : el.type)}</div>
        <div className="muted small">
          {el.start.toFixed(2)}s → {(el.start + el.duration).toFixed(2)}s ({el.duration.toFixed(2)}s)
        </div>
      </div>
      <div className="panel-list">
        {panels.map((p) => (
          <button key={p.id} className={p.id === panel.id ? "on" : ""} aria-pressed={p.id === panel.id} onClick={() => ui.set({ panel: p.id })}>
            {p.id === "textStyle" ? "Style" : p.name}
          </button>
        ))}
      </div>
      <div className="pane">
        <SelectedPanel id={panel.id} el={el} project={project} onMain={onMain} />
      </div>
    </div>
  );
}

function SelectedPanel(props: Omit<Parameters<typeof PanelBody>[0], "playhead">) {
  const { el, id } = props;
  // Subscribe to visible changes only. Actions that use a timestamp read it when clicked.
  useSyncExternalStore(ui.subscribe, () => {
    const { playhead } = ui.get();
    if (id === "split") return playhead > el.start && playhead < el.start + el.duration;
    if (id === "keyframeEasing" && Object.values(el.keyframes ?? {}).some((frames) => frames?.length)) return Math.round((playhead - el.start) * 100);
    if (id === "opacity" && "opacity" in el && el.keyframes?.opacity?.length) return Math.round(propAt(el, "opacity", el.opacity, playhead) * 100);
    if (id === "transform" && "transform" in el) {
      const { x, y, scale, rotationDegrees } = el.transform;
      return [
        el.keyframes?.x?.length ? Math.round(propAt(el, "x", x, playhead) * 100) : 0,
        el.keyframes?.y?.length ? Math.round(propAt(el, "y", y, playhead) * 100) : 0,
        el.keyframes?.scale?.length ? Math.round(propAt(el, "scale", scale, playhead) * 100) : 0,
        el.keyframes?.rotationDegrees?.length ? Math.round(propAt(el, "rotationDegrees", rotationDegrees, playhead)) : 0,
      ].join(",");
    }
    return null;
  });
  return <PanelBody {...props} playhead={ui.get().playhead} />;
}

function ProjectPanel({ project }: { project: Project }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [brief, setBrief] = useState(project.brief);
  useEffect(() => setBrief(project.brief), [project.brief]);
  return (
    <div className="inspector">
      <div className="head">
        <div className="inspector-heading"><EditorIcon name="inspector" /> Inspector</div>
      </div>
      {!settingsOpen ? <div className="inspector-empty">
        <EditorIcon name="timeline" />
        <strong>Select a clip</strong>
        <button className="ghost" onClick={() => setSettingsOpen(true)}>Project settings</button>
      </div> : <>
      <div className="pane">
        <button className="ghost inspector-back" onClick={() => setSettingsOpen(false)}><EditorIcon name="back" /> Project settings</button>
        <Title>Canvas</Title>
        <Select label="Aspect" value={project.canvas.aspectRatio} options={["9:16", "16:9", "1:1", "4:5"]} onChange={(v) => run("setCanvas", { aspectRatio: v })} />
        <Select label="Resolution" value={project.canvas.resolution} options={["720p", "1080p", "4K"]} onChange={(v) => run("setCanvas", { resolution: v })} />
        <Select label="Frame rate" value={String(project.canvas.fps)} options={["24", "25", "30", "50", "60"]} onChange={(v) => run("setCanvas", { fps: Number(v) })} />
        <ColorField label="Background" value={project.canvas.backgroundColor} onChange={(v) => run("setCanvas", { backgroundColor: v })} />
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
      </>}
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
  const selectedCaption = project.elements[ids[0]];
  const allSelectedAreCaptions = selectedCaption?.type === "caption" && ids.every((id) => project.elements[id]?.type === "caption");
  return (
    <div className="inspector">
      <div className="head">
        <div className="kind">Selection</div>
        <div style={{ fontWeight: 600, marginTop: 2 }}>{ids.length} items</div>
      </div>
      <div className="pane">
        {allSelectedAreCaptions && <TextStylePanel element={selectedCaption} selectedIds={ids} captionIds={Object.values(project.elements).filter((item) => item.type === "caption").map((item) => item.id)} />}
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button onClick={() => run("splitAt", { times: [ui.get().playhead], elementIds: ids })}>Split at playhead</button>
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
  const isKeyframed = (prop: KeyframeProperty) => Boolean(el.keyframes?.[prop]?.length);
  const addKf = (prop: KeyframeProperty, fallback: number) => () => {
    const time = ui.get().playhead;
    call("setTransformKeyframe", { property: prop, time, value: propAt(el, prop, fallback, time) });
  };

  switch (id) {
    case "transform": {
      if (!("transform" in el)) return null;
      const t = el.transform;
      const x = propAt(el, "x", t.x, playhead);
      const y = propAt(el, "y", t.y, playhead);
      const sc = propAt(el, "scale", t.scale, playhead);
      const rot = propAt(el, "rotationDegrees", t.rotationDegrees, playhead);
      const set = (prop: KeyframeProperty, v: number) => call("setTransform", { [prop]: v, ...(isKeyframed(prop) ? { time: ui.get().playhead } : {}) });
      return (
        <>
          <Slider reset={0.5} label="Position X" value={x} min={-0.5} max={1.5} onCommit={(v) => set("x", v)} keyframed={isKeyframed("x")} onKeyframe={addKf("x", t.x)} />
          <Slider reset={0.5} label="Position Y" value={y} min={-0.5} max={1.5} onCommit={(v) => set("y", v)} keyframed={isKeyframed("y")} onKeyframe={addKf("y", t.y)} />
          <Slider reset={1} label="Scale" value={sc} min={0.05} max={5} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => set("scale", v)} keyframed={isKeyframed("scale")} onKeyframe={addKf("scale", t.scale)} />
          <Slider label="Rotation" value={rot} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}°`} onCommit={(v) => set("rotationDegrees", v)} keyframed={isKeyframed("rotationDegrees")} onKeyframe={addKf("rotationDegrees", t.rotationDegrees)} />
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
      return <Slider reset={1} label="Opacity" value={o} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => (isKeyframed("opacity") ? call("setTransformKeyframe", { property: "opacity", time: ui.get().playhead, value: v }) : call("setOpacity", { opacity: v }))} keyframed={isKeyframed("opacity")} onKeyframe={addKf("opacity", el.opacity)} />;
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
        <button className="primary" onClick={() => call("split", { time: ui.get().playhead })} disabled={playhead <= el.start || playhead >= el.start + el.duration}>
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
          <button onClick={() => run("addBeatMarker", { time: ui.get().playhead })}>Add marker at playhead</button>
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
            <button className="primary" disabled={noVision} onClick={() => call("addStickerFromCutout", { time: ui.get().playhead, kind: "person" })}>
              Cut out person
            </button>
            <button disabled={noVision} onClick={() => call("addStickerFromCutout", { time: ui.get().playhead, kind: "subject" })}>Cut out subject</button>
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
      return <TextEdit key={el.id} elementId={el.id} text={el.text} onCommit={(text) => call("editText", { text })} />;
    case "textStyle":
      if (el.type !== "text" && el.type !== "caption") return null;
      return <TextStylePanel element={el} captionIds={el.type === "caption" ? Object.values(project.elements).filter((item) => item.type === "caption").map((item) => item.id) : []} />;
    case "textAnimation": {
      if (el.type !== "text") return null;
      return (
        <>
          {(["in", "out", "loop"] as const).map((slot) => (
            <Select
              key={slot}
              label={slot === "in" ? "In" : slot === "out" ? "Out" : "Loop"}
              value={el.animation[slot]?.id ?? "none"}
              options={[["none", "None"], ...TEXT_ANIMATIONS.filter((a) => a.data.slot === slot).map((a) => [a.id, a.name] as [string, string])]}
              onChange={(v) => call("setTextAnimation", { [slot]: { id: v } })}
            />
          ))}
        </>
      );
    }
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
                <Slider key={p.name} reset={Number(p.default)} label={p.name} value={Number(fx.params[p.name] ?? p.default)} min={p.min ?? 0} max={p.max ?? 100} onCommit={(v) => call("applyEffect", { effectId: fx.effectId, instanceId: fx.instanceId, params: { [p.name]: v } })} />
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

function TextEdit({ elementId, text, onCommit }: { elementId: string; text: string; onCommit: (t: string) => void }) {
  const [v, setV] = useState(text);
  const field = useRef<HTMLTextAreaElement>(null);
  const focusId = useUi("focusTitleId");
  useEffect(() => {
    if (focusId === elementId) {
      field.current?.focus();
      field.current?.select();
      ui.set({ focusTitleId: undefined });
    }
  }, [elementId, focusId]);
  return <textarea aria-label="Title text" ref={field} rows={4} style={{ width: "100%" }} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== text && v.trim() && onCommit(v)} />;
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
