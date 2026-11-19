import { useEffect, useRef, useState } from "react";
import { sourceTimeAt, type ImageElement, type MediaAsset, type Project, type VideoElement } from "@openedits/core";
import { fileUrl, live } from "./live.js";

let queue = Promise.resolve();
const cachedUrls = new Map<string, string>();
const visibleCallbacks = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | undefined;

function onVisible(target: Element, callback: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    callback();
    return () => {};
  }
  observer ??= new IntersectionObserver((entries, self) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      self.unobserve(entry.target);
      visibleCallbacks.get(entry.target)?.();
    }
  });
  visibleCallbacks.set(target, callback);
  observer.observe(target);
  return () => {
    visibleCallbacks.delete(target);
    observer?.unobserve(target);
  };
}

function useThumbnail(projectId: string | undefined, media: MediaAsset | undefined, time: number) {
  const target = useRef<HTMLElement>(null);
  const [result, setResult] = useState<{ key: string; url: string }>();
  const sourceSeconds = Math.floor(time * 4) / 4;
  const mediaId = media?.kind === "audio" ? undefined : media?.id;
  const key = JSON.stringify([projectId, mediaId, media?.path, media?.sizeBytes, sourceSeconds]);
  useEffect(() => {
    if (!target.current || !mediaId || !projectId) return;
    let active = true;
    const disconnect = onVisible(target.current, () => {
      const load = async () => {
        if (!active || live.state.project?.id !== projectId) return;
        let url = cachedUrls.get(key);
        if (!url) {
          const response = await live.call<{ path: string }>("mediaThumbnail", { mediaId, sourceSeconds });
          url = fileUrl(response.path);
          cachedUrls.set(key, url);
          if (cachedUrls.size > 128) cachedUrls.delete(cachedUrls.keys().next().value!);
        }
        if (active) setResult({ key, url });
      };
      queue = queue.then(load).catch(() => {});
    });
    return () => {
      active = false;
      disconnect();
    };
  }, [key, projectId, mediaId, sourceSeconds]);
  return { target, url: result?.key === key ? result.url : undefined, forget: () => cachedUrls.delete(key) };
}

export function invalidateMediaThumbnails() {
  cachedUrls.clear();
}

export function MediaThumbnail({ media }: { media: MediaAsset }) {
  const { target, url, forget } = useThumbnail(live.state.project?.id, media, 0);
  return <span className="media-thumbnail" ref={target} aria-hidden="true">{url && <img src={url} alt="" draggable={false} onError={forget} />}</span>;
}

function Cell({ projectId, media, time }: { projectId: string; media: MediaAsset | undefined; time: number }) {
  const { target, url } = useThumbnail(projectId, media, time);
  return <span ref={target} style={url ? { backgroundImage: `url(${JSON.stringify(url)})` } : undefined} />;
}

export function TimelineFilmstrip({ el, project, pps }: { el: VideoElement | ImageElement; project: Project; pps: number }) {
  const count = el.type === "image" ? 1 : Math.min(12, Math.max(1, Math.ceil(el.duration * pps / 76)));
  const media = project.media[el.mediaId];
  return <div className="timeline-filmstrip" aria-hidden="true">{
    Array.from({ length: count }, (_, i) => {
      const t = el.start + el.duration * ((i + 0.5) / count);
      return <Cell key={i} projectId={project.id} media={media} time={el.type === "video" ? sourceTimeAt(project, el, t) : 0} />;
    })
  }</div>;
}
