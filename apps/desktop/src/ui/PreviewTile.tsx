import { useEffect, useRef, useState, type ReactNode } from "react";
import { THUMB_H, THUMB_W, drawHoverFrame, thumbnail, type PreviewKind } from "./thumbs.js";

/**
 * A catalog tile with a rendered preview of what it does: a still, which animates while the pointer
 * is over it. Falls back to the name alone when previews cannot be drawn.
 */
export function PreviewTile(props: { kind: PreviewKind; id: string; name: string; label?: string; active?: boolean; title?: string; onPick: () => void; badge?: ReactNode }) {
  const { kind, id } = props;
  const [still, setStill] = useState<string | null | undefined>(undefined);
  const [hover, setHover] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tile = useRef<HTMLDivElement>(null);

  // Render the still once the tile scrolls into view (catalogs are long).
  useEffect(() => {
    let alive = true;
    const el = tile.current;
    if (!el) return;
    const load = () => void thumbnail(kind, id).then((url) => alive && setStill(url));
    if (typeof IntersectionObserver === "undefined") {
      load();
      return () => {
        alive = false;
      };
    }
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      io.disconnect();
      clearTimeout(fallback);
      load();
    };
    const io = new IntersectionObserver((entries) => entries.some((x) => x.isIntersecting) && start(), { rootMargin: "200px" });
    io.observe(el);
    // Visible tiles go first; the rest follow shortly after so scrolling finds them ready.
    const fallback = setTimeout(start, 2500);
    return () => {
      alive = false;
      io.disconnect();
      clearTimeout(fallback);
    };
  }, [kind, id]);

  useEffect(() => {
    if (!hover || still === null) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      if (canvas.current) drawHoverFrame(kind, id, (now - start) / 1000, canvas.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hover, still, kind, id]);

  return (
    <div
      ref={tile}
      className={`tile preview${props.active ? " active" : ""}`}
      data-preview={`${kind}:${id}`}
      onClick={props.onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={props.title ?? props.name}
    >
      <div className="thumb">
        {hover && still ? <canvas ref={canvas} width={THUMB_W} height={THUMB_H} /> : still ? <img src={still} alt="" draggable={false} /> : <div className="ph" />}
        {props.badge}
      </div>
      <div className="meta">
        <span className="name">{props.name}</span>
        {props.label && <span className="label">{props.label}</span>}
      </div>
    </div>
  );
}
