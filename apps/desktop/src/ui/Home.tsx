import { useCallback, useEffect, useState } from "react";
import path from "node:path";
import { additiveClick, live, useLive, WORKSPACE } from "./live.js";
import { SHORTCUT_MAPS, type ShortcutMapId } from "./shortcuts.js";

interface ProjectRow {
  id: string;
  name: string;
  updatedAt: number;
  pinned: boolean;
  favorite: boolean;
  durationSeconds: number;
  aspectRatio: string;
}
interface InboxFile {
  name: string;
  path: string;
  kind: string;
  sizeBytes: number;
}
interface AutopilotJob {
  id: string;
  files: string[];
  status: string;
  step: string;
  output?: string;
  error?: string;
  projectName?: string;
}

const ASPECTS = ["9:16", "16:9", "1:1", "4:5"] as const;

function ago(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export function Home() {
  const s = useLive();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [filter, setFilter] = useState<"all" | "pinned" | "favorites">("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [inbox, setInbox] = useState<InboxFile[]>([]);
  const [jobs, setJobs] = useState<AutopilotJob[]>([]);
  const [waiting, setWaiting] = useState<string[]>([]);
  const [aspect, setAspect] = useState<(typeof ASPECTS)[number]>("9:16");
  const [shortcutMap, setShortcutMap] = useState<ShortcutMapId>("edits");
  const [renaming, setRenaming] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [p, i, a, st] = await Promise.all([
      live.call<{ projects: ProjectRow[] }>("projects", { filter, ...(query ? { query } : {}) }),
      live.call<{ files: InboxFile[] }>("list_inbox", {}),
      live.call<{ jobs: AutopilotJob[]; waiting: string[] }>("list_autopilot_jobs", { limit: 8 }),
      live.call<{ shortcutMap: ShortcutMapId }>("getSettings"),
    ]).catch((e) => {
      live.toast("error", (e as Error).message);
      return [null, null, null, null];
    });
    if (p) setProjects(p.projects);
    if (i) setInbox(i.files);
    if (a) {
      setJobs(a.jobs);
      setWaiting(a.waiting);
    }
    if (st) setShortcutMap(st.shortcutMap);
  }, [filter, query]);

  useEffect(() => {
    if (s.connected) void refresh();
    const t = setInterval(() => s.connected && void refresh(), 5000);
    return () => clearInterval(t);
  }, [s.connected, refresh, s.revision]);

  const toggle = (id: string, multi: boolean) => setSelected((cur) => (multi ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id]));

  return (
    <>
      <div className="titlebar">
        <span className="brand">
          Open<b>Edits</b> Studio
        </span>
        <span className={`status-dot ${s.connected ? "" : "off"}`} title={s.connected ? "Engine connected" : "Engine disconnected"} />
        <div className="spacer" />
        <select value={aspect} onChange={(e) => setAspect(e.target.value as (typeof ASPECTS)[number])} title="Aspect ratio for new projects">
          {ASPECTS.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <button className="primary" onClick={() => void live.run("newProject", { canvas: { aspectRatio: aspect } })}>
          New project
        </button>
      </div>
      <div className="home">
        <main>
          <div className="toolbar">
            <h1 style={{ marginRight: 12 }}>Projects</h1>
            {(["all", "pinned", "favorites"] as const).map((f) => (
              <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
            <input placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 180 }} />
            <div style={{ flex: 1 }} />
            {selected.length > 0 && (
              <>
                <span className="muted small">{selected.length} selected</span>
                <button onClick={() => selected.forEach((id) => void live.run("togglePin", { projectId: id }).then(refresh))}>Pin</button>
                <button
                  onClick={() => {
                    if (!confirm(`Move ${selected.length} project${selected.length > 1 ? "s" : ""} to the workspace trash?`)) return;
                    void Promise.all(selected.map((id) => live.run("deleteProject", { projectId: id }))).then(() => {
                      setSelected([]);
                      void refresh();
                    });
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </div>
          {projects.length === 0 ? (
            <div className="empty">No projects yet. Create one, or drop videos into the inbox.</div>
          ) : (
            <div className="grid">
              {projects.map((p) => (
                <div
                  key={p.id}
                  className={`card ${selected.includes(p.id) ? "selected" : ""}`}
                  onClick={(e) => toggle(p.id, additiveClick(e))}
                  onDoubleClick={() => void live.run("openProject", { projectId: p.id })}
                >
                  <div className="thumb" style={{ aspectRatio: p.aspectRatio.replace(":", " / ") }}>
                    ▶
                  </div>
                  <div className="badges">
                    <button title="Pin" onClick={(e) => (e.stopPropagation(), void live.run("togglePin", { projectId: p.id }).then(refresh))}>
                      {p.pinned ? "📌" : "📍"}
                    </button>
                    <button title="Favorite" onClick={(e) => (e.stopPropagation(), void live.run("toggleFavorite", { projectId: p.id }).then(refresh))}>
                      {p.favorite ? "★" : "☆"}
                    </button>
                  </div>
                  <div className="meta">
                    {renaming === p.id ? (
                      <input
                        autoFocus
                        defaultValue={p.name}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          setRenaming(null);
                          if (e.target.value.trim() && e.target.value !== p.name) void live.run("renameProject", { projectId: p.id, name: e.target.value.trim() }).then(refresh);
                        }}
                        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                        style={{ width: "100%" }}
                      />
                    ) : (
                      <div className="title" onDoubleClick={(e) => (e.stopPropagation(), setRenaming(p.id))} title="Double-click to rename">
                        {p.name}
                      </div>
                    )}
                    <div className="sub">
                      {p.aspectRatio} · {p.durationSeconds.toFixed(1)}s · {ago(p.updatedAt)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
        <aside>
          <h2 style={{ marginTop: 0 }}>Inbox</h2>
          {inbox.length === 0 ? (
            <div className="muted small">Drop media into {path.join(WORKSPACE, "inbox")}.</div>
          ) : (
            inbox.map((f) => (
              <div className="list-row" key={f.path}>
                <span>{f.kind === "video" ? "🎬" : f.kind === "audio" ? "🎵" : "🖼"}</span>
                <span className="grow" title={f.name}>
                  {f.name}
                </span>
                <button onClick={() => void live.run("create_project", { files: [f.name], canvas: { aspectRatio: aspect } })}>Edit</button>
              </div>
            ))
          )}
          <h2>Autopilot</h2>
          <div className="muted small" style={{ marginBottom: 6 }}>
            Videos dropped in auto-edit get the STYLE.md first pass and a render in the outbox.
          </div>
          {waiting.map((w) => (
            <div className="list-row small" key={w}>
              ⏳ <span className="grow">{w}</span>
            </div>
          ))}
          {jobs.map((j) => (
            <div className="list-row small" key={j.id} title={j.error ?? j.output ?? ""}>
              <span>{j.status === "done" ? "✅" : j.status === "failed" ? "⚠️" : "⏳"}</span>
              <span className="grow">{j.projectName ?? j.files[0]?.split("/").pop()}</span>
              <span className="muted">{j.status === "running" ? j.step : j.status}</span>
            </div>
          ))}
          {!jobs.length && !waiting.length && <div className="muted small">No jobs yet.</div>}
          <h2>Keyboard shortcuts</h2>
          <select
            value={shortcutMap}
            onChange={(e) => {
              const v = e.target.value as ShortcutMapId;
              setShortcutMap(v);
              void live.run("updateSettings", { shortcutMap: v });
            }}
            style={{ width: "100%" }}
          >
            {Object.entries(SHORTCUT_MAPS).map(([id, m]) => (
              <option key={id} value={id}>
                {m.name}
              </option>
            ))}
          </select>
          <div className="muted small" style={{ marginTop: 8 }}>
            {Object.entries(SHORTCUT_MAPS[shortcutMap].keys)
              .slice(0, 8)
              .map(([action, key]) => (
                <div key={action} className="row" style={{ justifyContent: "space-between" }}>
                  <span>{action}</span>
                  <code>{key}</code>
                </div>
              ))}
          </div>
        </aside>
      </div>
    </>
  );
}
