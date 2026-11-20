import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { produce } from "immer";
import { canvasShortSide, clipBoundaries, compositionDuration, type DrawLayer, type Element, type Project } from "@openedits/core";
import { useEditingCache } from "./editingCache.js";
import { EditorIcon } from "./EditorIcon.js";
import { live, useLive, WEB } from "./live.js";
import { Player, Preview } from "./preview.js";
import { formatTime, ui, useUi, capturePointer, type UiState } from "./uiStore.js";
import { recorder } from "./recorder.js";

export interface ViewportApi {
  player: Player | null;
}

type Drag = { mode: "move" | "scale" | "rotate"; startX: number; startY: number; cx: number; cy: number; base: { x: number; y: number; scale: number; rotationDegrees: number }; elementId: string };
const ANDROID_PREVIEW = WEB && window.__openedits?.android === true;

/** A box around a drawn layer, in canvas pixels. Text sizes are estimated (the compositor rasterizes them). */
function layerBox(l: DrawLayer): { cx: number; cy: number; w: number; h: number; rot: number } {
  if (l.kind === "text" || l.kind === "caption") {
    const text = l.kind === "text" ? l.text : l.words.slice(0, l.maxWords).map((w) => w.text).join(" ");
    const est = Math.min(l.maxWidthPx, text.length * l.fontPx * 0.56);
    const lines = Math.max(1, Math.ceil((text.length * l.fontPx * 0.56) / Math.max(1, l.maxWidthPx)));
    return { cx: l.cx, cy: l.cy, w: est + l.fontPx * 0.6, h: lines * l.fontPx * l.style.lineHeight + l.fontPx * 0.4, rot: l.rotationDegrees };
  }
  return { cx: l.cx, cy: l.cy, w: l.width, h: l.height, rot: l.rotationDegrees };
}

function withTextStyleDraft(project: Project, draft: UiState["textStyleDraft"]): Project {
  if (!draft) return project;
  return produce(project, (copy) => {
    for (const id of draft.elementIds) {
      const element = copy.elements[id];
      if (element?.type === "text") Object.assign(element.style, draft.patch);
      if (element?.type === "caption") {
        Object.assign(element.styleOverrides, draft.patch);
        if (draft.highlightColor !== undefined) element.highlightColor = draft.highlightColor;
      }
    }
  });
}

export const Viewport = forwardRef<ViewportApi, { blocked: boolean; onImportMedia: () => void; onOpenEditingCache: () => void }>(function Viewport({ blocked, onImportMedia, onOpenEditingCache }, ref) {
  const s = useLive();
  const playing = useUi("playing");
  const loop = useUi("loop");
  const showGuides = useUi("showGuides");
  const showRecorder = useUi("recorder");
  const quality = useUi("previewQuality");
  const project = s.project!;
  const textStyleDraft = useUi("textStyleDraft");
  const previewProject = useMemo(() => withTextStyleDraft(project, textStyleDraft), [project, textStyleDraft]);
  const cache = useEditingCache();
  const proxies = cache.enabled && cache.projectId === project.id ? cache.proxies : undefined;
  const wrap = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [engine, setEngine] = useState<{ preview: Preview; player: Player } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [drawnShortSide, setDrawnShortSide] = useState(0);
  const previousShortSide = useRef(0);
  const [androidMediaCodec, setAndroidMediaCodec] = useState(false);
  const [, force] = useState(0);
  const dragProject = useRef<Project | null>(null);

  useLayoutEffect(() => {
    const preview = new Preview(canvasRef.current!);
    const player = new Player(preview);
    preview.onDrawn = (scene) => {
      const shortSide = Math.min(scene.width, scene.height);
      if (shortSide !== previousShortSide.current) {
        previousShortSide.current = shortSide;
        setDrawnShortSide(shortSide);
      }
      if (!ui.get().playing) force((n) => n + 1);
    };
    let previous = ui.get();
    const unsubscribe = ui.subscribe(() => {
      const next = ui.get();
      if (!next.playing && (next.playhead !== previous.playhead || previous.playing)) {
        void preview.draw(next.playhead, "seek");
        player.warmPausedAudio();
      }
      previous = next;
    });
    setEngine({ preview, player });
    return () => {
      unsubscribe();
      player.dispose();
      preview.dispose();
    };
  }, []);
  useImperativeHandle(ref, () => ({ player: engine?.player ?? null }), [engine]);
  useEffect(() => {
    if (!ui.get().playing) engine?.player.warmPausedAudio();
  }, [engine, project, s.connected]);

  // Fit the canvas into the viewport, preserving the project aspect ratio.
  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => {
      const [width, height] = project.canvas.aspectRatio.split(":").map(Number);
      const aspect = width / height;
      const availW = Math.max(0, el.clientWidth - 24);
      const availH = Math.max(0, el.clientHeight - 24);
      const w = Math.min(availW, availH * aspect);
      setBox((previous) => previous.w === w && previous.h === w / aspect ? previous : { w, h: w / aspect });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.canvas.aspectRatio]);

  const maxShortSide = quality === "draft" ? 360 : quality === "high" || !WEB ? 1080 : 720;
  const shortSide = Math.max(180, Math.min(maxShortSide, canvasShortSide(project.canvas), Math.round(Math.min(box.w, box.h) * Math.min(2, devicePixelRatio) / 90) * 90));
  useLayoutEffect(() => {
    if (!engine) return;
    engine.preview.quality.configure(shortSide, quality === "auto");
    engine.preview.androidMediaCodec = androidMediaCodec;
    engine.preview.setProject(dragProject.current ?? previewProject, proxies);
    if (!ui.get().playing) void engine.preview.draw(ui.get().playhead);
  }, [engine, previewProject, shortSide, quality, proxies, androidMediaCodec]);

  const scene = engine?.preview.scene;
  const scale = scene ? box.w / scene.width : 1;
  const selectedId = s.appState?.selection.elementIds[0];
  const layer = scene?.layers.find((l): l is DrawLayer => "elementId" in l && l.elementId === selectedId && l.kind !== "adjustment" && l.kind !== "transition") as DrawLayer | undefined;
  const el: Element | undefined = selectedId ? project.elements[selectedId] : undefined;

  const begin = (mode: Drag["mode"]) => (e: React.PointerEvent) => {
    if (!layer || !el || !("transform" in el)) return;
    e.stopPropagation();
    capturePointer(e.target as Element & HTMLElement, e.pointerId);
    const r = wrap.current!.getBoundingClientRect();
    const b = layerBox(layer);
    setDrag({
      mode,
      startX: e.clientX,
      startY: e.clientY,
      cx: r.left + (r.width - box.w) / 2 + b.cx * scale,
      cy: r.top + (r.height - box.h) / 2 + b.cy * scale,
      base: { x: el.transform.x, y: el.transform.y, scale: el.transform.scale, rotationDegrees: el.transform.rotationDegrees },
      elementId: el.id,
    });
  };

  const nextTransform = (d: Drag, e: React.PointerEvent) => {
    if (d.mode === "move") return { x: d.base.x + (e.clientX - d.startX) / box.w, y: d.base.y + (e.clientY - d.startY) / box.h };
    if (d.mode === "scale") {
      const d0 = Math.hypot(d.startX - d.cx, d.startY - d.cy);
      const d1 = Math.hypot(e.clientX - d.cx, e.clientY - d.cy);
      return { scale: Math.max(0.02, d.base.scale * (d1 / Math.max(1, d0))) };
    }
    const a0 = Math.atan2(d.startY - d.cy, d.startX - d.cx);
    const a1 = Math.atan2(e.clientY - d.cy, e.clientX - d.cx);
    let r = d.base.rotationDegrees + ((a1 - a0) * 180) / Math.PI;
    if (e.shiftKey) r = Math.round(r / 15) * 15;
    return { rotationDegrees: Math.round(r * 10) / 10 };
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag || !engine) return;
    const patch = nextTransform(drag, e);
    // Live preview of the drag on a local copy; the engine gets one edit on release.
    dragProject.current = produce(previewProject, (p) => {
      const target = p.elements[drag.elementId];
      if (target && "transform" in target) Object.assign(target.transform, patch);
    });
    engine.preview.setProject(dragProject.current, proxies);
    void engine.preview.draw(ui.get().playhead);
  };

  const clearDrag = () => {
    dragProject.current = null;
    setDrag(null);
    if (engine) {
      const latest = live.state.project;
      engine.preview.setProject(latest && withTextStyleDraft(latest, ui.get().textStyleDraft), proxies);
      if (!ui.get().playing) void engine.preview.draw(ui.get().playhead);
    }
  };

  const onUp = (e: React.PointerEvent) => {
    if (!drag) return;
    const patch = nextTransform(drag, e);
    const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 2;
    setDrag(null);
    const target = project.elements[drag.elementId];
    if (moved && target) {
      const keyed = Object.keys(patch).some((k) => target.keyframes[k as keyof typeof target.keyframes]?.length);
      void live.run("setTransform", { elementId: drag.elementId, ...patch, ...(keyed ? { time: ui.get().playhead } : {}) }).finally(clearDrag);
    } else clearDrag();
  };

  /** Click on the picture: select the top-most layer under the pointer. */
  const pick = (e: React.MouseEvent) => {
    if (!scene) return;
    const r = canvasRef.current!.getBoundingClientRect();
    const px = (e.clientX - r.left) / scale;
    const py = (e.clientY - r.top) / scale;
    const hit = [...scene.layers].reverse().find((l): l is DrawLayer => {
      if (!("cx" in l)) return false;
      const b = layerBox(l as DrawLayer);
      const a = (-b.rot * Math.PI) / 180;
      const dx = px - b.cx;
      const dy = py - b.cy;
      const lx = dx * Math.cos(a) - dy * Math.sin(a);
      const ly = dx * Math.sin(a) + dy * Math.cos(a);
      return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
    });
    void live.run("setSelection", { elementIds: hit ? [hit.elementId] : [] });
  };

  const duration = compositionDuration(project);
  const b = layer ? layerBox(layer) : null;
  const reducedQuality = quality === "auto" && drawnShortSide > 0 && drawnShortSide < shortSide;
  function jumpToEdit(direction: -1 | 1) {
    const time = ui.get().playhead;
    const edges = clipBoundaries(project);
    const target = direction < 0 ? edges.findLast((edge) => edge < time - 1e-3) ?? 0 : edges.find((edge) => edge > time + 1e-3) ?? duration;
    engine?.player.seek(target);
  }
  return (
    <section className="stage" aria-label="Preview" inert={blocked}>
      <div className="preview-bar">
        <strong>Preview</strong>
        <div className="preview-controls">
          {ANDROID_PREVIEW && <label title="Experimental Android hardware preview decoding. Unsupported clips fall back to software.">
            <input type="checkbox" checked={androidMediaCodec} onChange={(e) => setAndroidMediaCodec(e.target.checked)} />
            <span className="muted">Try MediaCodec</span>
          </label>}
          <label>
            <span className="muted preview-quality-label">Quality</span>
            <select aria-label="Preview quality" title={reducedQuality ? "Auto lowered the preview resolution to keep playback smooth" : "Affects preview playback only"} value={quality} onChange={(e) => {
              const value = e.target.value;
              if (value === "auto" || value === "draft" || value === "high") ui.set({ previewQuality: value });
            }}>
              <option value="auto">{reducedQuality ? `Auto · ${drawnShortSide}p` : "Auto"}</option>
              <option value="draft">Draft</option>
              <option value="high">High</option>
            </select>
          </label>
          <button className="ghost icon preview-proxies" aria-label="Editing proxies" aria-haspopup="dialog" title="Manage smaller video copies for smoother playback" onClick={onOpenEditingCache}>
            <EditorIcon name="storage" />
            <span>Proxies</span>
          </button>
        </div>
      </div>
      <div className="viewport" ref={wrap} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={clearDrag}>
        <canvas ref={canvasRef} className="preview" style={{ width: box.w, height: box.h }} onMouseDown={pick} />
        {!duration && !showRecorder && !s.appState?.teleprompterOpen && (
          <div className="preview-empty">
            <span>Your timeline is empty</span>
            <button className="ghost" disabled={!s.connected} onClick={onImportMedia}>Import media</button>
          </div>
        )}
        {showGuides && <div className="guides" style={{ width: box.w, height: box.h, backgroundSize: `${box.w / 10}px ${box.h / 10}px` }} />}
        {b && !playing && (
          <div
            className="gizmo"
            style={{ width: b.w * scale, height: b.h * scale, transform: `translate(${(b.cx - b.w / 2) * scale - box.w / 2}px, ${(b.cy - b.h / 2) * scale - box.h / 2}px) rotate(${b.rot}deg)`, left: "50%", top: "50%" }}
            onPointerDown={begin("move")}
          >
            {[
              [0, 0],
              [1, 0],
              [0, 1],
              [1, 1],
            ].map(([x, y]) => (
              <div key={`${x}${y}`} className="h" style={{ left: `calc(${x * 100}% - 5px)`, top: `calc(${y * 100}% - 5px)`, cursor: x === y ? "nwse-resize" : "nesw-resize" }} onPointerDown={begin("scale")} />
            ))}
            <div className="rot" onPointerDown={begin("rotate")} title="Rotate (Shift snaps to 15°)" />
          </div>
        )}
        {s.appState?.teleprompterOpen && <Teleprompter />}
        {showRecorder && <RecorderPanel />}
      </div>
      <div className="transport">
        <div className="left">
          <button className={loop ? "on icon" : "icon"} aria-label="Loop" aria-pressed={loop} onClick={() => ui.set({ loop: !loop })} title="Loop">
            ⟲
          </button>
        </div>
        <div className="center">
          <button className="icon ghost jump-edit" aria-label="Previous edit" title="Previous edit" onClick={() => jumpToEdit(-1)}>
            <span className="transport-glyph previous-edit" aria-hidden="true" />
          </button>
          <button className="icon ghost" aria-label="Back one frame" title="Back one frame" onClick={() => engine?.player.seek(ui.get().playhead - 1 / project.canvas.fps)}>
            <span className="transport-glyph back-frame" aria-hidden="true" />
          </button>
          <button className="icon play" disabled={!duration} onClick={() => engine?.player.toggle()} aria-label={playing ? "Pause" : "Play"} title="Play / pause (Space)">
            <span className={`transport-glyph ${playing ? "pause-glyph" : "play-glyph"}`} aria-hidden="true" />
          </button>
          <button className="icon ghost" aria-label="Forward one frame" title="Forward one frame" onClick={() => engine?.player.seek(ui.get().playhead + 1 / project.canvas.fps)}>
            <span className="transport-glyph forward-frame" aria-hidden="true" />
          </button>
          <button className="icon ghost jump-edit" aria-label="Next edit" title="Next edit" onClick={() => jumpToEdit(1)}>
            <span className="transport-glyph next-edit" aria-hidden="true" />
          </button>
        </div>
        <Timecode duration={duration} fps={project.canvas.fps} />
      </div>
    </section>
  );
});

function Timecode({ duration, fps }: { duration: number; fps: number }) {
  const playhead = useUi("playhead");
  return <span className="time" title="Playhead and total duration"><strong>{formatTime(playhead, fps)}</strong><span> / {formatTime(duration, fps)}</span></span>;
}

function Teleprompter() {
  const s = useLive();
  const tp = s.project!.teleprompter;
  const [running, setRunning] = useState(false);
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState(!tp.text);
  const scroll = useRef<HTMLDivElement>(null);
  const rec = useSyncExternalStore(recorder.subscribe, () => recorder.state);
  const active = running || rec.phase === "recording";
  useEffect(() => {
    if (!active) return;
    let last = performance.now();
    let raf = 0;
    const words = Math.max(1, tp.text.split(/\s+/).filter(Boolean).length);
    const tick = (now: number) => {
      const height = scroll.current?.scrollHeight ?? 1000;
      // Pixels per second so the whole script takes words / (wpm / 60) seconds.
      const pxPerSec = (height * 0.5) / (words / (tp.scrollSpeed / 60));
      setOffset((o) => Math.min(height, o + ((now - last) / 1000) * pxPerSec));
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, tp.text, tp.scrollSpeed]);
  return (
    <div className="teleprompter">
      <div className="controls">
        <button className="icon" onClick={() => setRunning(!running)}>
          {running ? "❚❚" : "▶"}
        </button>
        <button className="icon" onClick={() => setOffset(0)} title="Back to the top">
          ⤒
        </button>
        <button className="icon" onClick={() => void live.run("openTeleprompter", { fontSize: Math.max(12, tp.fontSize - 4) })}>
          A−
        </button>
        <button className="icon" onClick={() => void live.run("openTeleprompter", { fontSize: Math.min(160, tp.fontSize + 4) })}>
          A+
        </button>
        <select value={tp.scrollSpeed} onChange={(e) => void live.run("openTeleprompter", { scrollSpeed: Number(e.target.value) })} title="Words per minute">
          {[100, 120, 140, 160, 180, 200].map((v) => (
            <option key={v} value={v}>
              {v} wpm
            </option>
          ))}
        </select>
        <button className="icon" onClick={() => setEditing(!editing)}>
          ✎
        </button>
        <button className="icon" onClick={() => void live.run("openTeleprompter", { open: false })}>
          ✕
        </button>
      </div>
      {editing ? (
        <textarea
          defaultValue={tp.text}
          placeholder="Paste your script…"
          style={{ position: "absolute", inset: 0, height: "100%", fontSize: 16, background: "rgba(0,0,0,0.6)", border: "none", padding: 40 }}
          onBlur={(e) => {
            setEditing(false);
            if (e.target.value !== tp.text) void live.run("setTeleprompterText", { text: e.target.value });
          }}
        />
      ) : (
        <div className="scroll" ref={scroll} style={{ fontSize: tp.fontSize / 2, transform: `translateY(${-offset}px)` }}>
          {tp.text || "No script yet."}
        </div>
      )}
    </div>
  );
}

function RecorderPanel() {
  const r = useSyncExternalStore(recorder.subscribe, () => recorder.state);
  useEffect(() => {
    void recorder.ensureOpen().catch(() => {});
    return () => {
      if (recorder.state.phase === "idle") recorder.close();
    };
  }, []);
  const pct = Math.max(0, Math.min(100, ((r.levelDb + 60) / 60) * 100));
  return (
    <>
      {r.phase === "countdown" && <div className="countdown">{r.count}</div>}
      <div className="recorder">
        {r.phase === "recording" && <span className="rec-dot" />}
        <select value={r.deviceId ?? ""} onChange={(e) => void recorder.open(e.target.value)} disabled={r.phase !== "idle"} style={{ maxWidth: 160 }}>
          {r.devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <div className="meter" title={`${r.levelDb.toFixed(1)} dBFS`}>
          <div style={{ width: `${pct}%` }} />
        </div>
        <span className="muted small" style={{ minWidth: 60 }}>
          {r.phase === "recording" ? `${r.elapsed.toFixed(1)} s` : r.phase === "saving" ? "Saving…" : `${r.levelDb.toFixed(0)} dB`}
        </span>
        {r.phase === "recording" ? (
          <button className="primary" onClick={() => void recorder.stop().catch((e) => live.toast("error", (e as Error).message))}>
            Stop
          </button>
        ) : (
          <button className="primary" disabled={r.phase !== "idle"} onClick={() => void recorder.start({ start: ui.get().playhead }).catch((e) => live.toast("error", (e as Error).message))}>
            Record
          </button>
        )}
        <button className="ghost icon" onClick={() => ui.set({ recorder: false })} disabled={r.phase !== "idle"}>
          ✕
        </button>
        {r.error && <span className="small" style={{ color: "var(--accent)" }}>{r.error}</span>}
      </div>
    </>
  );
}
