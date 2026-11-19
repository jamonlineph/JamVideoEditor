import { useEffect, useRef, useState } from "react";
import { editingCache, useEditingCache } from "./editingCache.js";
import { live } from "./live.js";
import { invalidateMediaThumbnails } from "./TimelineFilmstrip.js";

interface ProxyJob {
  jobId: string;
  status: "running" | "done" | "failed" | "cancelled";
  progress: number;
  message?: string;
  error?: { message: string };
}

function storageSize(bytes: number) {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export function EditingCacheDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cache = useEditingCache();
  const [job, setJob] = useState<ProxyJob | null>(null);
  const [pending, setPending] = useState(false);
  const activeId = job?.status === "running" ? job.jobId : null;
  const proxyCount = Object.keys(cache.proxies).length;
  const previewBytes = cache.previewBytes + cache.thumbnailBytes;

  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) {
      dialog.current.showModal();
      void editingCache.refresh();
    }
  }, [open]);

  useEffect(() => {
    if (!activeId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const current = await live.call<ProxyJob>("editingProxyStatus", { jobId: activeId }).catch(() => null);
      if (disposed) return;
      if (current) setJob(current);
      if (!current || current.status === "running") timer = setTimeout(poll, 1000);
      else void editingCache.refresh();
    };
    timer = setTimeout(poll, 1000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [activeId]);

  async function proxyAction() {
    setPending(true);
    try {
      const result = activeId
        ? await live.run<ProxyJob>("cancelEditingProxies", { jobId: activeId })
        : await live.run<ProxyJob>("generateEditingProxies");
      if (result) {
        setJob(result);
        if (result.status !== "running") await editingCache.refresh();
      }
    } finally {
      setPending(false);
    }
  }

  async function clear(scope: "proxies" | "previews") {
    setPending(true);
    try {
      const result = await live.run("clearEditingCache", { scope });
      if (result) {
        if (scope === "previews") invalidateMediaThumbnails();
        await editingCache.refresh();
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <dialog ref={dialog} className="dialog editing-cache-dialog" aria-labelledby="editing-cache-title" onClose={onClose}>
      <h3 id="editing-cache-title">Editing cache</h3>
      <p className="muted">Proxies are smaller copies of your clips for editing. Exports use the original media.</p>
      <label className="cache-toggle">
        <input type="checkbox" checked={cache.enabled} onChange={(e) => editingCache.setEnabled(e.target.checked)} />
        Use proxies in preview when available
      </label>
      <dl className="cache-sizes">
        <div><dt>Editing proxies <span className="muted">({proxyCount} of {cache.eligibleVideos} videos)</span></dt><dd>{storageSize(cache.proxyBytes)}</dd></div>
        <div><dt>Generated previews and thumbnails</dt><dd>{storageSize(previewBytes)}</dd></div>
      </dl>
      {job && <div className="cache-progress">
        {activeId && <progress aria-label="Proxy generation progress" value={job.progress} max={1} />}
        <span role="status">{job.error?.message ?? (job.status === "done" ? "Proxies ready" : job.status === "cancelled" ? "Proxy generation cancelled" : job.message ?? "Preparing proxies…")}</span>
      </div>}
      <div className="row cache-actions">
        <button className={activeId ? "" : "primary"} disabled={pending || (!activeId && cache.eligibleVideos <= proxyCount)} onClick={() => void proxyAction()}>{activeId ? "Cancel generation" : "Generate proxies"}</button>
        <button disabled={pending || !!activeId || !cache.proxyBytes} onClick={() => void clear("proxies")}>Clear proxies</button>
        <button disabled={pending || !previewBytes} onClick={() => void clear("previews")}>Clear previews</button>
        <button className="ghost" onClick={() => dialog.current?.close()}>Close</button>
      </div>
    </dialog>
  );
}
