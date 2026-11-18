import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { compositionDuration, isAudioKind, mainTrack, type Element, type MediaAsset, type Project, type Track } from "@openedits/core";
import { additiveClick, live, selectedElements, useLive } from "./live.js";
import { droppedPaths, importFiles, StickerArt } from "./Dock.js";
import { formatTime, ui, useUi, capturePointer, seek } from "./uiStore.js";
import { Icon } from "./Icon.js";
import { mediaFrame } from "./frames.js";

const LANE_H: Record<string, number> = { main: 60, audio: 40, default: 34 };
const TRACK_ICON: Record<string, string> = { main: "media", overlay: "layers", adjustment: "adjust", shape: "shape", text: "text", sticker: "sticker", caption: "captions", music: "audio", sfx: "audio", voiceover: "mic", audio: "audio" };
const CLIP_ICON: Record<string, string> = { video: "media", image: "image", audio: "audio", text: "text", caption: "captions", shape: "shape", sticker: "sticker", adjustment: "effects" };

/** Ask the editor to show a library tab (the side panel, or the bottom sheet on small screens). */
export function openDock(tab: string) {
  window.dispatchEvent(new CustomEvent("openedits-dock", { detail: tab }));
}
/** Ask the editor to show a properties tab for the selection. */
export function openProps(tab: string) {
  window.dispatchEvent(new CustomEvent("openedits-props", { detail: tab }));
}
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

  const main = mainTrack(project);
  const mainEnd = main.elementIds.length ? Math.max(...main.elementIds.map((id) => project.elements[id].start + project.elements[id].duration)) : 0;
  /** Pick files, import them and put them at the end of the main track. */
  const addToEnd = async () => {
    const before = new Set(Object.keys(live.state.project?.media ?? {}));
    await importFiles();
    const fresh = Object.values(live.state.project?.media ?? {}).filter((m) => !before.has(m.id));
    for (const m of fresh) await live.run("addMedia", m.kind === "audio" ? { mediaId: m.id, start: ui.get().playhead, role: "music" } : { mediaId: m.id });
  };

  const step = rulerStep(pps);
  const width = Math.max(duration, 10) * pps + 160;
  const inRange = (start: number, end = start) => end * pps >= range.left && start * pps <= range.right;
  const ticks: number[] = [];
  const right = Math.min(Math.max(width, range.right - OVERSCAN), range.right);
  for (let n = Math.ceil(range.left / (pps * step)); n <= right / (pps * step); n++) ticks.push(n * step);

  return (
    <section className="timeline" aria-label="Timeline">
      <TimelineBar duration={duration} selection={selection} project={project} zoom={zoom} fit={() => {
        const w = scroller.current?.clientWidth ?? 800;
        ui.set({ pxPerSecond: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (w - 80) / Math.max(1, duration))) });
        if (scroller.current) scroller.current.scrollLeft = 0;
      }} pps={pps} />
      <div className="body">
        <div className="track-heads">
          <div className="track-head-caption" />
          <div className="track-head-scroll">
            <div ref={trackHeads}>
              {lanes.map((t) => (
                <div key={t.id} className={`track-head${t.kind === "main" ? " main" : ""}`} style={{ height: laneHeight(t) }}>
                  <span className="track-name" title={t.kind === "main" ? "Main track" : t.name}>
                    <Icon name={TRACK_ICON[t.kind] ?? "layers"} size={14} />
                    <span>{t.kind === "main" ? "Main" : t.name}</span>
                  </span>
                  <span className="track-flags">
                    <button className={t.locked ? "on" : ""} aria-pressed={t.locked} title={t.locked ? "Unlock track" : "Lock track"} aria-label={t.locked ? "Unlock track" : "Lock track"} onClick={() => void live.run("setTrackFlags", { trackId: t.id, locked: !t.locked })}>
                      <Icon name={t.locked ? "lock" : "unlock"} size={13} />
                    </button>
                    {isAudioKind(t.kind) || t.kind === "main" ? (
                      <button className={t.muted ? "on" : ""} aria-pressed={t.muted} title={t.muted ? "Unmute track" : "Mute track"} aria-label={t.muted ? "Unmute track" : "Mute track"} onClick={() => void live.run("setTrackFlags", { trackId: t.id, muted: !t.muted })}>
                        <Icon name={t.muted ? "mute" : "volume"} size={13} />
                      </button>
                    ) : null}
                    {!isAudioKind(t.kind) && (
                      <button className={t.hidden ? "on" : ""} aria-pressed={t.hidden} title={t.hidden ? "Show track" : "Hide track"} aria-label={t.hidden ? "Show track" : "Hide track"} onClick={() => void live.run("setTrackFlags", { trackId: t.id, hidden: !t.hidden })}>
                        <Icon name={t.hidden ? "eyeOff" : "eye"} size={13} />
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="lanes" ref={scroller} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => setDrag(null)}>
          <div className="lanes-inner" style={{ width, minWidth: "100%" }}>
            <div
              className="ruler"
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
                  t.elementIds.slice(0, -1).map((id) => {
                    const from = project.elements[id];
                    if (!from) return null;
                    const cut = from.start + from.duration;
                    const tr = project.transitions.find((x) => x.fromElementId === id);
                    if (!inRange(cut - 1, cut + 1)) return null;
                    return (
                      <div key={`tr-${id}`}>
                        {tr && <div className="tr" style={{ left: (cut - tr.durationSeconds / 2) * pps, width: tr.durationSeconds * pps }} />}
                        <button
                          className={`tr-btn${tr ? " on" : ""}`}
                          data-from={id}
                          style={{ left: cut * pps }}
                          title={tr ? `Transition: ${tr.type.replace(/_/g, " ")} (${tr.durationSeconds.toFixed(2)}s). Click to change.` : "Add a transition"}
                          aria-label={tr ? `Change transition after ${from.name ?? "clip"}` : `Add a transition after ${from.name ?? "clip"}`}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            void live.call("setSelection", { elementIds: [id] }).catch(() => {});
                            openDock("transitions");
                          }}
                        >
                          <Icon name={tr ? "transitions" : "plus"} size={11} />
                        </button>
                      </div>
                    );
                  })}
                {t.kind === "main" && (
                  <button className="add-clip" style={{ left: mainEnd * pps + 8 }} title="Import and add media" aria-label="Add media to the end of the main track" onPointerDown={(e) => e.stopPropagation()} onClick={() => void addToEnd()}>
                    <Icon name="plus" size={18} />
                  </button>
                )}
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
  const label = el.name ?? (el.type === "text" ? el.text : el.type === "caption" ? el.words.map((w) => w.text).join(" ") : "mediaId" in el ? project.media[el.mediaId]?.name : el.type === "adjustment" ? "Adjustment" : el.type);
  const kfOffsets = [...new Set(Object.values(el.keyframes ?? {}).flatMap((k) => (k ?? []).map((x) => x.offsetSeconds)))];
  const speed = (el.type === "video" || el.type === "audio") && (el.speed.mode === "curve" || el.speed.rate !== 1) ? (el.speed.mode === "curve" ? "ramp" : `${el.speed.rate}×`) : "";
  const media = "mediaId" in el ? project.media[el.mediaId] : undefined;
  const anim = (el as { animation?: { in?: unknown; out?: unknown; loop?: unknown } }).animation;
  const fx = "effects" in el ? el.effects.length : 0;
  const lane = project.tracks.find((t) => t.id === el.trackId);
  const h = lane ? laneHeight(lane) : 34;
  return (
    <div
      className={`clip t-${el.type}${selected ? " selected" : ""}`}
      data-id={el.id}
      style={{ left, width: Math.max(2, width), opacity: drag?.kind === "move" && drag.moved ? 0.8 : 1 }}
      onPointerDown={(e) => onPointerDown(e, "body")}
      onDoubleClick={() => seek(el.start)}
    >
      {(el.type === "video" || el.type === "image") && media && width > 8 && <Filmstrip el={el} media={media} width={Math.max(2, width)} height={h} />}
      {(el.type === "video" || el.type === "audio") && <Waveform el={el} project={project} pps={pps} />}
      <div className="name">
        {el.type === "sticker" && el.stickerId ? <StickerArt id={el.stickerId} size={13} /> : <Icon name={CLIP_ICON[el.type] ?? "layers"} size={12} />}
        <span className="label-text">{label}</span>
        {speed && <span className="chip-mini">{speed}</span>}
        {anim && Boolean(anim.in || anim.out || anim.loop) && <span className="chip-mini" title="Animated"><Icon name="animation" size={10} /></span>}
        {fx > 0 && <span className="chip-mini" title={`${fx} effect${fx > 1 ? "s" : ""}`}><Icon name="effects" size={10} /></span>}
      </div>
      {selected && width > 60 && <div className="dur">{el.duration.toFixed(1)}s</div>}
      {kfOffsets.map((o) => (
        <div key={o} className="kf" style={{ left: o * pps }} />
      ))}
      <div className="trim l" onPointerDown={(e) => onPointerDown(e, "l")} />
      <div className="trim r" onPointerDown={(e) => onPointerDown(e, "r")} />
    </div>
  );
}

/** Frames along a video or photo clip, like a strip of film. */
function Filmstrip({ el, media, width, height }: { el: Extract<Element, { type: "video" | "image" }>; media: MediaAsset; width: number; height: number }) {
  const aspect = media.width && media.height ? media.width / media.height : 16 / 9;
  const tileW = Math.max(height * 0.56, Math.min(height * 1.78, height * aspect));
  const count = Math.max(1, Math.min(48, Math.ceil(width / tileW)));
  const times = Array.from({ length: count }, (_, i) => {
    if (el.type !== "video") return 0;
    const frac = Math.min(1, ((i + 0.5) * tileW) / width);
    return el.sourceInSourceSeconds + (el.reversed ? 1 - frac : frac) * el.sourceDurationSourceSeconds;
  });
  return (
    <div className="filmstrip" aria-hidden="true">
      {times.map((t, i) => (
        <FilmFrame key={i} media={media} seconds={t} style={{ left: i * tileW, width: tileW }} />
      ))}
    </div>
  );
}

function FilmFrame({ media, seconds, style }: { media: MediaAsset; seconds: number; style: React.CSSProperties }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void mediaFrame(media, seconds, 72).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [media.id, Math.round(seconds * 2)]);
  return <div className="frame" style={{ ...style, backgroundImage: url ? `url(${url})` : undefined }} />;
}

/** Edit actions over the timeline (CapCut-style), then the timeline switches and zoom. */
function TimelineBar({ duration, selection, project, zoom, fit, pps }: { duration: number; selection: Set<string>; project: Project; zoom: (next: number, anchor?: number) => void; fit: () => void; pps: number }) {
  const s = useLive();
  const rs = project.rippleSettings;
  const sel = selectedElements(s);
  const one = sel.length === 1 ? sel[0] : undefined;
  const timed = one && (one.type === "video" || one.type === "audio") ? one : undefined;
  const flippable = one && (one.type === "video" || one.type === "image") ? one : undefined;
  const visual = one && "transform" in one ? one : undefined;
  const tool = (icon: string, label: string, onClick: () => void, opts: { disabled?: boolean; on?: boolean; title?: string } = {}) => (
    <button className={`tool${opts.on ? " on" : ""}`} aria-label={label} aria-pressed={opts.on} title={opts.title ?? label} disabled={opts.disabled} onClick={onClick}>
      <Icon name={icon} size={17} />
    </button>
  );
  return (
    <div className="bar">
      <div className="timeline-edit">
        {tool("undo", "Undo", () => void live.run("undo"), { title: "Undo (Ctrl/Cmd+Z)" })}
        {tool("redo", "Redo", () => void live.run("redo"), { title: "Redo" })}
        <span className="sep" />
        {tool("split", "Split", () => void live.run("splitAt", { times: [ui.get().playhead], elementIds: selection.size ? [...selection] : mainTrack(project).elementIds }), { disabled: !duration, title: "Split at the playhead (S)" })}
        {tool("trash", "Delete", () => void live.run("delete", { elementIds: [...selection] }), { disabled: !selection.size, title: "Delete (Backspace)" })}
        {tool("duplicate", "Duplicate", () => one && void live.run("duplicate", { elementId: one.id }), { disabled: !one })}
        {tool("reverse", "Reverse", () => timed && void live.run("setReversed", { elementId: timed.id, reversed: !timed.reversed }), { disabled: !timed, on: !!timed?.reversed, title: "Play backwards" })}
        {tool("mirror", "Mirror", () => flippable && void live.run("setFlip", { elementId: flippable.id, horizontal: !flippable.flip.horizontal }), { disabled: !flippable, on: !!flippable?.flip.horizontal })}
        {tool("rotate", "Rotate", () => visual && void live.run("setTransform", { elementId: visual.id, rotationDegrees: (Math.round(visual.transform.rotationDegrees / 90) * 90 + 90) % 360 }), { disabled: !visual, title: "Rotate 90°" })}
        {tool("crop", "Crop", () => openProps("basic"), { disabled: !flippable, title: "Crop and position" })}
        {tool("speed", "Speed", () => openProps("speed"), { disabled: !timed })}
        {tool("animation", "Animation", () => openProps("animation"), { disabled: !one || !["video", "image", "sticker", "shape", "text"].includes(one.type) })}
      </div>
      <div className="timeline-zoom">
        {tool("magnet", "Magnetic main track", () => void live.run("setRippleTiers", { magnetEnabled: !rs.magnetEnabled }), { on: rs.magnetEnabled, title: "Magnetic main track (no gaps)" })}
        {tool("snap", "Snapping", () => void live.run("setRippleTiers", { snappingEnabled: !rs.snappingEnabled }), { on: rs.snappingEnabled, title: "Snap to edges, playhead and beats" })}
        {tool("link", "Ripple linked", () => void live.run("setRippleTiers", { tier1RippleEnabled: !rs.tier1RippleEnabled }), { on: rs.tier1RippleEnabled, title: "Overlays follow the main clip they sit on" })}
        {tool("ripple", "Ripple all", () => void live.run("setRippleTiers", { tier2RippleEnabled: !rs.tier2RippleEnabled }), { on: rs.tier2RippleEnabled, title: "Everything after an edit shifts with it" })}
        <span className="sep" />
        {tool("zoomOut", "Zoom out", () => zoom(pps / 1.5))}
        <input type="range" aria-label="Timeline zoom" min={Math.log(MIN_ZOOM)} max={Math.log(MAX_ZOOM)} step={0.01} value={Math.log(pps)} onChange={(e) => zoom(Math.exp(Number(e.target.value)))} />
        {tool("zoomIn", "Zoom in", () => zoom(pps * 1.5))}
        {tool("fit", "Fit", fit, { title: "Fit the whole timeline" })}
      </div>
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
