import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { compositionDuration, isAudioKind, mainTrack, type Element, type Project, type Track } from "@openedits/core";
import { additiveClick, live, useLive } from "./live.js";
import { droppedPaths } from "./Dock.js";
import { EditorIcon } from "./EditorIcon.js";
import { formatTime, ui, useUi, capturePointer, seek } from "./uiStore.js";
import { TimelineFilmstrip } from "./TimelineFilmstrip.js";

const LANE_H: Record<string, number> = { main: 80, audio: 44, default: 38 };
const COLORS: Record<string, string> = {
  video: "var(--video)",
  image: "var(--image)",
  audio: "var(--audio)",
  text: "var(--text-el)",
  caption: "var(--caption)",
  shape: "var(--shape)",
  sticker: "var(--sticker)",
  adjustment: "var(--adjust)",
};
const SNAP_PX = 8;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 800;
const OVERSCAN = 360;

/** Lanes top → bottom: overlays (top layer first), main, then audio. */
export function laneOrder(project: Project): Track[] {
  const visual = project.tracks.filter((t) => t.kind !== "main" && !isAudioKind(t.kind)).reverse();
  const audio = project.tracks.filter((t) => isAudioKind(t.kind));
  return [...visual, mainTrack(project), ...audio];
}

export function laneHeight(t: Track) {
  return t.kind === "main" ? LANE_H.main : isAudioKind(t.kind) ? LANE_H.audio : LANE_H.default;
}

/** Ruler step (seconds) so labels are at least ~70 px apart. */
export function rulerStep(pxPerSecond: number) {
  for (const s of [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]) if (s * pxPerSecond >= 70) return s;
  return 3600;
}

/** Nearest snap target within SNAP_PX, else the time unchanged. */
export function snapTime(t: number, targets: number[], pxPerSecond: number) {
  let best = t;
  let dist = SNAP_PX / pxPerSecond;
  for (const s of targets) {
    const d = Math.abs(s - t);
    if (d < dist) {
      dist = d;
      best = s;
    }
  }
  return best;
}

type Drag =
  | { kind: "move"; id: string; startX: number; startY: number; origStart: number; dx: number; laneId: string; moved: boolean }
  | { kind: "trim"; id: string; side: "l" | "r"; startX: number; dx: number }
  | { kind: "scrub" };

export function Timeline({ onSeek }: { onSeek: (t: number) => void }) {
  const s = useLive();
  const project = s.project!;
  const pps = useUi("pxPerSecond");
  const selection = new Set(s.appState?.selection.elementIds ?? []);
  const lanes = useMemo(() => laneOrder(project), [project]);
  const duration = useMemo(() => compositionDuration(project), [project]);
  const scroller = useRef<HTMLDivElement>(null);
  const trackHeads = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ left: 0, right: 800 });
  const [drag, setDragState] = useState<Drag | null>(null);
  // Pointer handlers read the ref: several events can arrive before React re-renders.
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const [dropX, setDropX] = useState<number | null>(null);
  const rs = project.rippleSettings;

  const snapTargets = useMemo(() => {
    const t: number[] = [0];
    for (const el of Object.values(project.elements)) t.push(el.start, el.start + el.duration);
    for (const b of project.beatMarkers) t.push(b.timeSeconds);
    return t;
  }, [project]);

  const timeAt = (clientX: number) => {
    const r = scroller.current!.getBoundingClientRect();
    return Math.max(0, (clientX - r.left + scroller.current!.scrollLeft) / ui.get().pxPerSecond);
  };

  useLayoutEffect(() => {
    const el = scroller.current!;
    const heads = trackHeads.current!;
    const update = () => {
      heads.style.transform = `translateY(${-el.scrollTop}px)`;
      const left = Math.max(0, Math.floor(el.scrollLeft / OVERSCAN - 1) * OVERSCAN);
      const right = Math.ceil((el.scrollLeft + el.clientWidth) / OVERSCAN + 1) * OVERSCAN;
      setRange((prev) => prev.left === left && prev.right === right ? prev : { left, right });
    };
    const observer = new ResizeObserver(update);
    observer.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, []);

  function zoom(next: number, anchor?: number) {
    const el = scroller.current;
    if (!el) return;
    const before = ui.get().pxPerSecond;
    const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
    if (before === scale) return;
    const playhead = ui.get().playhead * before - el.scrollLeft;
    const offset = anchor ?? (playhead >= 0 && playhead < el.clientWidth ? playhead : el.clientWidth / 2);
    const time = (el.scrollLeft + offset) / before;
    ui.set({ pxPerSecond: scale });
    requestAnimationFrame(() => { el.scrollLeft = time * scale - offset; });
  }

  // Ctrl/Cmd + wheel zooms around the cursor.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoom(ui.get().pxPerSecond * Math.exp(-e.deltaY * 0.01), e.clientX - el.getBoundingClientRect().left);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const select = (id: string, additive: boolean) => {
    const cur = s.appState?.selection.elementIds ?? [];
    const next = additive ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id];
    void live.call("setSelection", { elementIds: next }).catch(() => {});
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === "scrub") return onSeek(timeAt(e.clientX));
    const dx = e.clientX - drag.startX;
    if (drag.kind === "move") {
      const lane = laneAtY(e.clientY);
      setDrag({ ...drag, dx, laneId: lane?.id ?? drag.laneId, moved: drag.moved || Math.abs(dx) > 3 || Math.abs(e.clientY - drag.startY) > 6 });
    } else setDrag({ ...drag, dx });
  };

  const laneAtY = (clientY: number): Track | undefined => {
    const inner = scroller.current?.querySelector(".lanes-inner");
    if (!inner) return undefined;
    for (const node of inner.querySelectorAll<HTMLElement>(".lane")) {
      const r = node.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return project.tracks.find((t) => t.id === node.dataset.track);
    }
    return undefined;
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    setDrag(null);
    if (!d || d.kind === "scrub") return;
    const el = project.elements[d.id];
    if (!el) return;
    if (d.kind === "trim") {
      if (Math.abs(d.dx) < 1) return;
      const raw = d.side === "l" ? el.start + d.dx / pps : el.start + el.duration + d.dx / pps;
      const time = rs.snappingEnabled ? snapTime(raw, [...snapTargets, ui.get().playhead], pps) : raw;
      void live.run(d.side === "l" ? "trimStart" : "trimEnd", { elementId: el.id, time });
      return;
    }
    if (!d.moved) return;
    const main = mainTrack(project);
    const raw = Math.max(0, d.origStart + d.dx / pps);
    if (el.trackId === main.id && d.laneId === main.id) {
      // Reorder on the magnetic main track: drop index from the clip midpoints.
      const center = raw + el.duration / 2;
      const others = main.elementIds.filter((id) => id !== el.id);
      let toIndex = others.findIndex((id) => center < project.elements[id].start + project.elements[id].duration / 2);
      if (toIndex < 0) toIndex = others.length;
      if (main.elementIds.indexOf(el.id) !== toIndex) void live.run("reorderClip", { elementId: el.id, toIndex });
      return;
    }
    if (el.trackId === main.id && d.laneId !== main.id) return void live.run("convertToOverlay", { elementId: el.id, start: raw });
    if (el.trackId !== main.id && d.laneId === main.id) {
      const others = main.elementIds;
      let index = others.findIndex((id) => raw < project.elements[id].start + project.elements[id].duration / 2);
      if (index < 0) index = others.length;
      return void live.run("convertToMain", { elementId: el.id, index });
    }
    const start = rs.snappingEnabled ? snapTime(raw, [...snapTargets.filter((t) => t !== el.start && t !== el.start + el.duration), ui.get().playhead], pps) : raw;
    void live.run("move", { elementId: el.id, start, ...(d.laneId !== el.trackId ? { trackId: d.laneId } : {}), snap: false });
  };

  /** Files dragged in from the desktop: import them, then place them where they were dropped. */
  const dropFiles = async (files: string[], track: Track, t: number) => {
    const r = await live.run<{ media?: { id: string }[] }>("importToMediaPanel", { paths: files });
    const ids = (r?.media ?? []).map((m) => m.id); // in the order they were dropped
    let at = t;
    for (const id of ids) {
      const media = live.state.project?.media[id];
      if (!media) continue;
      const placed = await placeMedia(id, track, at);
      const el = placed?.elementId ? live.state.project?.elements[placed.elementId] : undefined;
      if (el) at = el.start + el.duration;
    }
  };

  const placeMedia = (mediaId: string, track: Track, t: number) => {
    const p = live.state.project!;
    const media = p.media[mediaId];
    if (track.kind === "main" && media?.kind !== "audio") {
      const ids = mainTrack(p).elementIds;
      let index = ids.findIndex((id) => t < p.elements[id].start + p.elements[id].duration / 2);
      if (index < 0) index = ids.length;
      return live.run<{ elementId?: string }>("addMedia", { mediaId, index });
    }
    if (media?.kind === "audio") return live.run<{ elementId?: string }>("addMedia", { mediaId, start: t, role: track.kind === "sfx" || track.kind === "voiceover" ? track.kind : "music" });
    return live.run<{ elementId?: string }>("addMedia", { mediaId, start: t, asOverlay: true });
  };

  const onDrop = (e: React.DragEvent, track: Track) => {
    const mediaId = e.dataTransfer.getData("application/x-openedits-media");
    setDropX(null);
    if (!mediaId) {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      const at = timeAt(e.clientX);
      void droppedPaths(e).then((files) => void (files.length && dropFiles(files, track, at)));
      return;
    }
    e.preventDefault();
    const t = timeAt(e.clientX);
    const target = (e.target as HTMLElement).closest<HTMLElement>(".clip")?.dataset.id;
    if (target && e.altKey) return void live.run("replaceElementMedia", { elementId: target, mediaId });
    const media = project.media[mediaId];
    if (track.kind === "main" && media?.kind !== "audio") {
      const ids = track.elementIds;
      let index = ids.findIndex((id) => t < project.elements[id].start + project.elements[id].duration / 2);
      if (index < 0) index = ids.length;
      return void live.run("addMedia", { mediaId, index });
    }
    if (media?.kind === "audio") return void live.run("addMedia", { mediaId, start: t, role: track.kind === "sfx" || track.kind === "voiceover" ? track.kind : "music" });
    void live.run("addMedia", { mediaId, start: t, asOverlay: true });
  };

  const step = rulerStep(pps);
  const width = Math.max(duration, 10) * pps + 100;
  const inRange = (start: number, end = start) => end * pps >= range.left && start * pps <= range.right;
  const ticks: number[] = [];
  const right = Math.min(Math.max(width, range.right - OVERSCAN), range.right);
  for (let n = Math.ceil(range.left / (pps * step)); n <= right / (pps * step); n++) ticks.push(n * step);

  return (
    <section className="timeline" aria-label="Timeline">
      <div className="bar">
        <div className="timeline-edit">
          <strong><EditorIcon name="timeline" />Timeline</strong>
          <button className="icon ghost" title="Split at playhead" aria-label="Split at playhead" disabled={!duration} onClick={() => void live.run("splitAt", { times: [ui.get().playhead], elementIds: selection.size ? [...selection] : mainTrack(project).elementIds })}>
            <EditorIcon name="split" />
          </button>
          <button className="icon ghost" title="Delete selection" aria-label="Delete selection" disabled={!selection.size} onClick={() => void live.run("delete", { elementIds: [...selection] })}>
            <EditorIcon name="delete" />
          </button>
          <button className="icon ghost" aria-label="Undo" title="Undo" onClick={() => void live.run("undo")}><EditorIcon name="undo" /></button>
          <button className="icon ghost" aria-label="Redo" title="Redo" onClick={() => void live.run("redo")}><EditorIcon name="redo" /></button>
          <span className="sep" />
          <button className={rs.magnetEnabled ? "on" : ""} aria-pressed={rs.magnetEnabled} title="Magnetic main track (no gaps)" onClick={() => void live.run("setRippleTiers", { magnetEnabled: !rs.magnetEnabled })}>
            Magnet
          </button>
          <button className={rs.snappingEnabled ? "on" : ""} aria-pressed={rs.snappingEnabled} title="Snap to edges, playhead and beats" onClick={() => void live.run("setRippleTiers", { snappingEnabled: !rs.snappingEnabled })}>
            Snap
          </button>
          <button className={rs.tier1RippleEnabled ? "on ripple" : "ripple"} aria-pressed={rs.tier1RippleEnabled} title="Overlays follow the main clip they sit on" onClick={() => void live.run("setRippleTiers", { tier1RippleEnabled: !rs.tier1RippleEnabled })}>
            Ripple linked
          </button>
          <button className={rs.tier2RippleEnabled ? "on ripple" : "ripple"} aria-pressed={rs.tier2RippleEnabled} title="Everything after an edit shifts with it" onClick={() => void live.run("setRippleTiers", { tier2RippleEnabled: !rs.tier2RippleEnabled })}>
            Ripple all
          </button>
        </div>
        <div className="timeline-zoom">
          <button className="icon ghost" aria-label="Zoom out" title="Zoom out" onClick={() => zoom(pps / 1.5)}>
            −
          </button>
          <input type="range" aria-label="Timeline zoom" min={Math.log(MIN_ZOOM)} max={Math.log(MAX_ZOOM)} step={0.01} value={Math.log(pps)} onChange={(e) => zoom(Math.exp(Number(e.target.value)))} />
          <button className="icon ghost" aria-label="Zoom in" title="Zoom in" onClick={() => zoom(pps * 1.5)}>
            ＋
          </button>
          <button
            className="ghost"
            title="Fit the whole timeline"
            onClick={() => {
              const w = scroller.current?.clientWidth ?? 800;
              ui.set({ pxPerSecond: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (w - 32) / Math.max(1, duration))) });
              if (scroller.current) scroller.current.scrollLeft = 0;
            }}
          >
            Fit
          </button>
        </div>
      </div>
      <div className="body">
        <div className="track-heads">
          <div className="track-head-caption">Tracks</div>
          <div className="track-head-scroll">
            <div ref={trackHeads}>
              {lanes.map((t) => (
                <div key={t.id} className="track-head" style={{ height: laneHeight(t) }}>
                  <span className="grow" title={t.name}>
                    {t.kind === "main" ? "Main" : t.name}
                  </span>
                  <button title={t.locked ? "Unlock" : "Lock"} onClick={() => void live.run("setTrackFlags", { trackId: t.id, locked: !t.locked })} style={{ opacity: t.locked ? 1 : 0.45 }}>
                    <EditorIcon name={t.locked ? "lock" : "unlock"} />
                  </button>
                  {isAudioKind(t.kind) || t.kind === "main" ? (
                    <button title={t.muted ? "Unmute" : "Mute"} onClick={() => void live.run("setTrackFlags", { trackId: t.id, muted: !t.muted })} style={{ opacity: t.muted ? 1 : 0.45 }}>
                      <EditorIcon name={t.muted ? "muted" : "sound"} />
                    </button>
                  ) : null}
                  {!isAudioKind(t.kind) && (
                    <button title={t.hidden ? "Show" : "Hide"} onClick={() => void live.run("setTrackFlags", { trackId: t.id, hidden: !t.hidden })} style={{ opacity: t.hidden ? 1 : 0.45 }}>
                      <EditorIcon name={t.hidden ? "eyeOff" : "eye"} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="lanes" ref={scroller} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => setDrag(null)}>
          <div className="lanes-inner" style={{ width }}>
            <div
              className="ruler"
              style={{ backgroundSize: `${(step * pps) / 5}px 8px` }}
              onPointerDown={(e) => {
                if (e.button !== 0 || dragRef.current) return;
                capturePointer(scroller.current!, e.pointerId);
                setDrag({ kind: "scrub" });
                onSeek(timeAt(e.clientX));
              }}
            >
              {ticks.map((t) => (
                <div key={t} className="tick" style={{ left: t * pps }}>
                  {formatTime(t, project.canvas.fps).replace(/:00$/, "")}
                </div>
              ))}
              {project.beatMarkers.filter((b) => inRange(b.timeSeconds)).map((b) => (
                <div key={b.id} className="beat" style={{ left: b.timeSeconds * pps, opacity: 0.4 + 0.6 * (b.strength ?? 1) }} title={`Beat ${b.timeSeconds.toFixed(2)}s`} />
              ))}
            </div>
            {lanes.map((t) => (
              <div
                key={t.id}
                data-track={t.id}
                className={`lane${t.kind === "main" ? " main" : ""}${drag?.kind === "move" && drag.moved && drag.laneId === t.id ? " target" : ""}`}
                style={{ height: laneHeight(t), opacity: t.hidden ? 0.45 : 1 }}
                onPointerDown={(e) => {
                  if (e.target === e.currentTarget) {
                    void live.call("setSelection", { elementIds: [] }).catch(() => {});
                    onSeek(timeAt(e.clientX));
                  }
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes("application/x-openedits-media") && !e.dataTransfer.types.includes("Files")) return;
                  e.preventDefault();
                  setDropX(timeAt(e.clientX) * pps);
                }}
                onDragLeave={() => setDropX(null)}
                onDrop={(e) => onDrop(e, t)}
              >
                {t.elementIds.map((id) => {
                  const el = project.elements[id];
                  if (!el || (!(drag && "id" in drag && drag.id === id) && !inRange(el.start, el.start + el.duration))) return null;
                  return <Clip key={id} el={el} project={project} pps={pps} selected={selection.has(id)} drag={drag && "id" in drag && drag.id === id ? drag : null} onPointerDown={(e, kind) => {
                    e.stopPropagation();
                    if (e.button !== 0 || dragRef.current) return;
                    if (t.locked) return select(id, additiveClick(e));
                    if (!selection.has(id) || additiveClick(e)) select(id, additiveClick(e));
                    capturePointer(scroller.current!, e.pointerId);
                    if (kind === "body") setDrag({ kind: "move", id, startX: e.clientX, startY: e.clientY, origStart: el.start, dx: 0, laneId: t.id, moved: false });
                    else setDrag({ kind: "trim", id, side: kind, startX: e.clientX, dx: 0 });
                  }} />;
                })}
                {t.kind === "main" &&
                  project.transitions.map((tr) => {
                    const from = project.elements[tr.fromElementId];
                    if (!from) return null;
                    const cut = from.start + from.duration;
                    if (!inRange(cut - tr.durationSeconds / 2, cut + tr.durationSeconds / 2)) return null;
                    return <div key={tr.id} className="tr" title={`${tr.type} ${tr.durationSeconds.toFixed(2)}s`} style={{ position: "absolute", top: 3, bottom: 3, left: (cut - tr.durationSeconds / 2) * pps, width: tr.durationSeconds * pps, zIndex: 3 }} />;
                  })}
              </div>
            ))}
            {dropX !== null && <div className="drop-line" style={{ left: dropX }} />}
            <TimelinePlayhead scroller={scroller} pps={pps} />
          </div>
        </div>
      </div>
    </section>
  );
}

function TimelinePlayhead({ scroller, pps }: { scroller: RefObject<HTMLDivElement | null>; pps: number }) {
  const marker = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    let previous = ui.get().playhead;
    const update = () => {
      const { playhead, playing } = ui.get();
      const x = playhead * pps;
      marker.current!.style.transform = `translateX(${x}px)`;
      const el = scroller.current;
      if (el && playing && previous !== playhead && (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 24)) {
        el.scrollLeft = Math.max(0, x - Math.min(80, el.clientWidth / 3));
      }
      previous = playhead;
    };
    update();
    return ui.subscribe(update);
  }, [pps, scroller]);
  return <div className="playhead" ref={marker} />;
}

function Clip({ el, project, pps, selected, drag, onPointerDown }: { el: Element; project: Project; pps: number; selected: boolean; drag: Drag | null; onPointerDown: (e: React.PointerEvent, kind: "body" | "l" | "r") => void }) {
  let left = el.start * pps;
  let width = el.duration * pps;
  if (drag?.kind === "move" && drag.moved) left += drag.dx;
  if (drag?.kind === "trim") {
    if (drag.side === "l") {
      left += drag.dx;
      width -= drag.dx;
    } else width += drag.dx;
  }
  const label = el.name ?? (el.type === "text" ? el.text : el.type === "caption" ? el.words.map((w) => w.text).join(" ") : "mediaId" in el ? project.media[el.mediaId]?.name : el.type);
  const kfOffsets = [...new Set(Object.values(el.keyframes ?? {}).flatMap((k) => (k ?? []).map((x) => x.offsetSeconds)))];
  const speed = (el.type === "video" || el.type === "audio") && (el.speed.mode === "curve" || el.speed.rate !== 1) ? (el.speed.mode === "curve" ? " · ramp" : ` · ${el.speed.rate}×`) : "";
  const hasWaveform = (el.type === "video" || el.type === "audio") && project.media[el.mediaId]?.hasAudio && (el.type === "audio" || !el.audioDetached);
  return (
    <div
      className={`clip clip-${el.type}${selected ? " selected" : ""}${hasWaveform ? " has-waveform" : ""}`}
      data-id={el.id}
      style={{ left, width: Math.max(2, width), background: COLORS[el.type], opacity: drag?.kind === "move" && drag.moved ? 0.8 : 1 }}
      onPointerDown={(e) => onPointerDown(e, "body")}
      onDoubleClick={() => seek(el.start)}
    >
      {(el.type === "video" || el.type === "image") && <TimelineFilmstrip el={el} project={project} pps={pps} />}
      {hasWaveform && (el.type === "video" || el.type === "audio") && <Waveform el={el} project={project} pps={pps} />}
      <div className="name">
        {el.type === "video" && width >= 92 && <span className="clip-duration">{formatTime(el.duration, project.canvas.fps).slice(0, 5)}</span>}
        {label}
        {speed}
      </div>
      {kfOffsets.map((o) => (
        <div key={o} className="kf" style={{ left: o * pps }} />
      ))}
      <div className="trim l" onPointerDown={(e) => onPointerDown(e, "l")} />
      <div className="trim r" onPointerDown={(e) => onPointerDown(e, "r")} />
    </div>
  );
}

const peaksCache = new Map<string, Promise<{ pointsPerSecond: number; peaks: number[] }>>();

/** Peak waveform for the clip's source span (linear mapping; speed ramps are approximated). */
function Waveform({ el, project, pps }: { el: Extract<Element, { type: "video" | "audio" }>; project: Project; pps: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const media = project.media[el.mediaId];
  useEffect(() => {
    if (!media?.hasAudio || (el.type === "video" && el.audioDetached)) return;
    let p = peaksCache.get(el.mediaId);
    if (!p) {
      p = live.call<{ pointsPerSecond: number; peaks: number[] }>("waveform", { mediaId: el.mediaId, pointsPerSecond: 50 });
      peaksCache.set(el.mediaId, p);
      if (peaksCache.size > 64) peaksCache.delete(peaksCache.keys().next().value!);
      p.catch(() => peaksCache.delete(el.mediaId));
    }
    let cancelled = false;
    void p.then((w) => {
      const c = canvas.current;
      if (cancelled || !c || !w.peaks.length) return;
      const r = c.getBoundingClientRect();
      c.width = Math.min(2048, Math.max(1, Math.round(r.width * devicePixelRatio)));
      c.height = Math.max(1, Math.round(r.height * Math.min(2, devicePixelRatio)));
      const g = c.getContext("2d")!;
      g.clearRect(0, 0, c.width, c.height);
      g.fillStyle = el.type === "audio" ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.3)";
      const gain = el.muted ? 0 : Math.min(2, el.volume);
      const h = c.height;
      for (let x = 0; x < c.width; x++) {
        const frac = x / c.width;
        const src = el.sourceInSourceSeconds + (el.reversed ? 1 - frac : frac) * el.sourceDurationSourceSeconds;
        const v = (w.peaks[Math.floor(src * w.pointsPerSecond)] ?? 0) * gain;
        const bh = Math.max(1, v * h * 0.8);
        g.fillRect(x, el.type === "audio" ? (h - bh) / 2 : h - bh, 1, bh);
      }
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [el.mediaId, el.sourceInSourceSeconds, el.sourceDurationSourceSeconds, el.duration, el.reversed, el.volume, el.muted, project.id, pps, (el as { audioDetached?: boolean }).audioDetached]);
  return <canvas ref={canvas} />;
}
