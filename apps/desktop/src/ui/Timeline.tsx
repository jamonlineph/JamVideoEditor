import { useEffect, useMemo, useRef, useState } from "react";
import { compositionDuration, isAudioKind, mainTrack, type Element, type Project, type Track } from "@openedits/core";
import { additiveClick, live, useLive } from "./live.js";
import { droppedPaths } from "./Dock.js";
import { formatTime, ui, useUi, capturePointer } from "./uiStore.js";

const LANE_H: Record<string, number> = { main: 64, audio: 40, default: 34 };
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
  for (const s of [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]) if (s * pxPerSecond >= 70) return s;
  return 600;
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
  const u = useUi();
  const project = s.project!;
  const pps = u.pxPerSecond;
  const selection = new Set(s.appState?.selection.elementIds ?? []);
  const lanes = laneOrder(project);
  const total = Math.max(compositionDuration(project), 10);
  const width = (total + 20) * pps;
  const scroller = useRef<HTMLDivElement>(null);
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
    const t: number[] = [0, u.playhead];
    for (const el of Object.values(project.elements)) t.push(el.start, el.start + el.duration);
    for (const b of project.beatMarkers) t.push(b.timeSeconds);
    return t;
  }, [s.revision, u.playhead]);

  const timeAt = (clientX: number) => {
    const r = scroller.current!.getBoundingClientRect();
    return Math.max(0, (clientX - r.left + scroller.current!.scrollLeft) / pps);
  };

  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !u.playing) return;
    const x = u.playhead * pps;
    if (x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - 80;
  }, [u.playhead, u.playing, pps]);

  // Ctrl/Cmd + wheel zooms around the cursor.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const t = timeAt(e.clientX);
      const next = Math.min(800, Math.max(4, ui.get().pxPerSecond * Math.exp(-e.deltaY * 0.01)));
      ui.set({ pxPerSecond: next });
      requestAnimationFrame(() => (el.scrollLeft = t * next - (e.clientX - el.getBoundingClientRect().left)));
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
      const time = rs.snappingEnabled ? snapTime(raw, snapTargets, pps) : raw;
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
    const start = rs.snappingEnabled ? snapTime(raw, snapTargets.filter((t) => t !== el.start && t !== el.start + el.duration), pps) : raw;
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
      const files = droppedPaths(e);
      if (!files.length) return;
      e.preventDefault();
      void dropFiles(files, track, timeAt(e.clientX));
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
  const ticks: number[] = [];
  for (let t = 0; t <= total + 20; t += step) ticks.push(t);

  return (
    <div className="timeline">
      <div className="bar">
        <button title="Split at playhead (S)" onClick={() => void live.run("splitAt", { times: [u.playhead], elementIds: selection.size ? [...selection] : mainTrack(project).elementIds })}>
          ✂︎ Split
        </button>
        <button title="Delete selection" disabled={!selection.size} onClick={() => void live.run("delete", { elementIds: [...selection] })}>
          Delete
        </button>
        <span className="sep" />
        <button className={rs.magnetEnabled ? "on" : ""} title="Magnetic main track (no gaps)" onClick={() => void live.run("setRippleTiers", { magnetEnabled: !rs.magnetEnabled })}>
          Magnet
        </button>
        <button className={rs.snappingEnabled ? "on" : ""} title="Snap to edges, playhead and beats" onClick={() => void live.run("setRippleTiers", { snappingEnabled: !rs.snappingEnabled })}>
          Snap
        </button>
        <button className={rs.tier1RippleEnabled ? "on" : ""} title="Overlays follow the main clip they sit on" onClick={() => void live.run("setRippleTiers", { tier1RippleEnabled: !rs.tier1RippleEnabled })}>
          Ripple linked
        </button>
        <button className={rs.tier2RippleEnabled ? "on" : ""} title="Everything after an edit shifts with it" onClick={() => void live.run("setRippleTiers", { tier2RippleEnabled: !rs.tier2RippleEnabled })}>
          Ripple all
        </button>
        <span style={{ flex: 1 }} />
        <span className="muted small">{formatTime(total, project.canvas.fps)}</span>
        <button className="icon ghost" title="Zoom out" onClick={() => ui.set({ pxPerSecond: Math.max(4, pps / 1.5) })}>
          −
        </button>
        <input type="range" min={Math.log(4)} max={Math.log(800)} step={0.01} value={Math.log(pps)} onChange={(e) => ui.set({ pxPerSecond: Math.exp(Number(e.target.value)) })} style={{ width: 110 }} />
        <button className="icon ghost" title="Zoom in" onClick={() => ui.set({ pxPerSecond: Math.min(800, pps * 1.5) })}>
          ＋
        </button>
        <button
          className="ghost"
          title="Fit the whole timeline"
          onClick={() => {
            const w = scroller.current?.clientWidth ?? 800;
            ui.set({ pxPerSecond: Math.min(800, Math.max(4, (w - 40) / Math.max(1, compositionDuration(project)))) });
            if (scroller.current) scroller.current.scrollLeft = 0;
          }}
        >
          Fit
        </button>
      </div>
      <div className="body">
        <div className="track-heads">
          <div style={{ height: 26, borderBottom: "1px solid var(--line)" }} />
          {lanes.map((t) => (
            <div key={t.id} className="track-head" style={{ height: laneHeight(t) }}>
              <span className="grow" title={t.name}>
                {t.kind === "main" ? "Main" : t.name}
              </span>
              <button title={t.locked ? "Unlock" : "Lock"} onClick={() => void live.run("setTrackFlags", { trackId: t.id, locked: !t.locked })} style={{ opacity: t.locked ? 1 : 0.45 }}>
                {t.locked ? "🔒" : "🔓"}
              </button>
              {isAudioKind(t.kind) || t.kind === "main" ? (
                <button title={t.muted ? "Unmute" : "Mute"} onClick={() => void live.run("setTrackFlags", { trackId: t.id, muted: !t.muted })} style={{ opacity: t.muted ? 1 : 0.45 }}>
                  {t.muted ? "🔇" : "🔊"}
                </button>
              ) : null}
              {!isAudioKind(t.kind) && (
                <button title={t.hidden ? "Show" : "Hide"} onClick={() => void live.run("setTrackFlags", { trackId: t.id, hidden: !t.hidden })} style={{ opacity: t.hidden ? 1 : 0.45 }}>
                  {t.hidden ? "◌" : "◉"}
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="lanes" ref={scroller} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => setDrag(null)}>
          <div className="lanes-inner" style={{ width }}>
            <div
              className="ruler"
              onPointerDown={(e) => {
                capturePointer(e.currentTarget.parentElement!.parentElement as HTMLElement, e.pointerId);
                setDrag({ kind: "scrub" });
                onSeek(timeAt(e.clientX));
              }}
            >
              {ticks.map((t) => (
                <div key={t} className="tick" style={{ left: t * pps }}>
                  {formatTime(t, project.canvas.fps).replace(/:00$/, "")}
                </div>
              ))}
              {project.beatMarkers.map((b) => (
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
                  if (!el) return null;
                  return <Clip key={id} el={el} project={project} pps={pps} selected={selection.has(id)} drag={drag && "id" in drag && drag.id === id ? drag : null} onPointerDown={(e, kind) => {
                    e.stopPropagation();
                    if (t.locked) return select(id, additiveClick(e));
                    if (!selection.has(id) || additiveClick(e)) select(id, additiveClick(e));
                    capturePointer(e.currentTarget.closest(".lanes") as HTMLElement, e.pointerId);
                    if (kind === "body") setDrag({ kind: "move", id, startX: e.clientX, startY: e.clientY, origStart: el.start, dx: 0, laneId: t.id, moved: false });
                    else setDrag({ kind: "trim", id, side: kind, startX: e.clientX, dx: 0 });
                  }} />;
                })}
                {t.kind === "main" &&
                  project.transitions.map((tr) => {
                    const from = project.elements[tr.fromElementId];
                    if (!from) return null;
                    const cut = from.start + from.duration;
                    return <div key={tr.id} className="tr" title={`${tr.type} ${tr.durationSeconds.toFixed(2)}s`} style={{ position: "absolute", top: 3, bottom: 3, left: (cut - tr.durationSeconds / 2) * pps, width: tr.durationSeconds * pps, zIndex: 3 }} />;
                  })}
              </div>
            ))}
            {dropX !== null && <div className="drop-line" style={{ left: dropX }} />}
            <div className="playhead" style={{ left: u.playhead * pps }} />
          </div>
        </div>
      </div>
    </div>
  );
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
  return (
    <div
      className={`clip${selected ? " selected" : ""}`}
      data-id={el.id}
      style={{ left, width: Math.max(2, width), background: COLORS[el.type], opacity: drag?.kind === "move" && drag.moved ? 0.8 : 1 }}
      onPointerDown={(e) => onPointerDown(e, "body")}
      onDoubleClick={() => ui.set({ playhead: el.start })}
    >
      {(el.type === "video" || el.type === "audio") && <Waveform el={el} project={project} pps={pps} />}
      <div className="name">
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
      p.catch(() => peaksCache.delete(el.mediaId));
    }
    let cancelled = false;
    void p.then((w) => {
      const c = canvas.current;
      if (cancelled || !c || !w.peaks.length) return;
      const r = c.getBoundingClientRect();
      c.width = Math.max(1, Math.round(r.width * devicePixelRatio));
      c.height = Math.max(1, Math.round(r.height * devicePixelRatio));
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
    });
    return () => {
      cancelled = true;
    };
  }, [el.mediaId, el.sourceInSourceSeconds, el.sourceDurationSourceSeconds, el.duration, el.reversed, el.volume, el.muted, project.id, pps, (el as { audioDetached?: boolean }).audioDetached]);
  return <canvas ref={canvas} />;
}
