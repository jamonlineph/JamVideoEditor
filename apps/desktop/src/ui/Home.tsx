import { useCallback, useEffect, useState } from "react";
import path from "node:path";
import { ipcRenderer } from "electron";
import { additiveClick, fileUrl, live, useLive, WEB, WORKSPACE } from "./live.js";
import { SHORTCUT_MAPS, type ShortcutMapId } from "./shortcuts.js";
import { Icon } from "./Icon.js";

interface ProjectRow {
  id: string;
  name: string;
  updatedAt: number;
  pinned: boolean;
  favorite: boolean;
  durationSeconds: number;
  aspectRatio: string;
  thumbnailPath?: string | null;
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

const ASPECTS = [
  { id: "9:16", label: "Vertical", hint: "Reels, Shorts, TikTok" },
  { id: "16:9", label: "Wide", hint: "YouTube, TV" },
  { id: "1:1", label: "Square", hint: "Feeds" },
  { id: "4:5", label: "Portrait", hint: "Instagram posts" },
] as const;
type Aspect = (typeof ASPECTS)[number]["id"];

/** Readable names for the shortcut map's actions ("stepBack" -> "Step back"). */
const actionName = (a: string) =>
  a
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
const keyName = (k: string) =>
  k.replace(/Meta\+/g, navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl+").replace(/Arrow(Left|Right|Up|Down)/, (_m, d: string) => ({ Left: "←", Right: "→", Up: "↑", Down: "↓" })[d] ?? d);

function ago(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

function duration(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/** A stable color pair per project, so cards are told apart at a glance. */
function hue(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/** A frame in the project's shape, inside its card. */
function AspectFrame({ aspect }: { aspect: string }) {
  const [w, h] = aspect.split(":").map(Number);
  const s = 46 / Math.max(w, h);
  return (
    <div className="frame" style={{ width: w * s, height: h * s }}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
        <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
      </svg>
    </div>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id="oe-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff4d6a" />
          <stop offset="1" stopColor="#9b4dff" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="6" fill="url(#oe-logo)" />
      <path d="M9.2 7.4v9.2l7.6-4.6z" fill="#fff" />
    </svg>
  );
}

export function Home() {
  const s = useLive();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<"all" | "pinned" | "favorites">("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [inbox, setInbox] = useState<InboxFile[]>([]);
  const [jobs, setJobs] = useState<AutopilotJob[]>([]);
  const [waiting, setWaiting] = useState<string[]>([]);
  const [aspect, setAspect] = useState<Aspect>("9:16");
  const [shortcutMap, setShortcutMap] = useState<ShortcutMapId>("edits");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const refresh = useCallback(async () => {
    const [p, i, a, st] = await Promise.all([
      live.call<{ projects: ProjectRow[] }>("projects", {
        filter,
        ...(query ? { query } : {}),
      }),
      live.call<{ files: InboxFile[] }>("list_inbox", {}),
      live.call<{ jobs: AutopilotJob[]; waiting: string[] }>("list_autopilot_jobs", { limit: 8 }),
      live.call<{ shortcutMap: ShortcutMapId }>("getSettings"),
    ]).catch((e) => {
      live.toast("error", (e as Error).message);
      return [null, null, null, null];
    });
    if (p) {
      setProjects(p.projects);
      setLoaded(true);
    }
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
  const open = (id: string) => void live.run("openProject", { projectId: id });
  const newProject = () => void live.run("newProject", { canvas: { aspectRatio: aspect } });

  /** Pick videos, make a project and put them on the timeline in order. */
  const startFromVideos = async () => {
    const files = (await ipcRenderer.invoke("pick-files", {
      multi: true,
    })) as string[];
    if (!files?.length) return;
    setStarting(true);
    try {
      const made = await live.run("newProject", {
        canvas: { aspectRatio: aspect },
      });
      if (!made) return;
      for (const file of files) await live.run("addMedia", { path: file });
    } finally {
      setStarting(false);
    }
  };

  const filtered = filter !== "all" || !!query;
  const showAutopilot = !WEB || jobs.length > 0 || waiting.length > 0;

  return (
    <>
      <div className="titlebar home-titlebar">
        <span className="brand">
          <Logo />
          <span>
            Open<b>Edits</b> Studio
          </span>
        </span>
        <span className={`status-dot ${s.connected ? "" : "off"}`} title={s.connected ? "Engine connected" : "Engine disconnected"} />
        <div className="spacer" />
        <button onClick={() => void startFromVideos()} disabled={starting || !s.connected} title="Pick videos and start a project with them">
          <Icon name="import" size={16} /> {starting ? "Adding…" : "Start from videos"}
        </button>
        <button className="primary" onClick={newProject}>
          New project
        </button>
      </div>
      <div className="home">
        <main>
          <section className="hero">
            <div className="create-card">
              <button className="create-main" onClick={newProject} disabled={!s.connected} aria-label="Create a new project">
                <span className="plus-orb"><Icon name="plus" size={30} /></span>
                <span className="create-text">
                  <b>New project</b>
                  <span>{ASPECTS.find((a) => a.id === aspect)!.label} {aspect} · {ASPECTS.find((a) => a.id === aspect)!.hint}</span>
                </span>
              </button>
              <div className="aspect-row" role="radiogroup" aria-label="Shape of new projects">
                {ASPECTS.map((a) => (
                  <button key={a.id} role="radio" aria-checked={aspect === a.id} className={aspect === a.id ? "on" : ""} onClick={() => setAspect(a.id)} title={`${a.label} (${a.id}): ${a.hint}`}>
                    <span className="aspect-glyph" style={{ aspectRatio: a.id.replace(":", " / ") }} />
                    <span className="label">{a.id}</span>
                  </button>
                ))}
              </div>
            </div>
            <button className="quick-card" onClick={() => void startFromVideos()} disabled={starting || !s.connected}>
              <span className="quick-icon v"><Icon name="media" size={22} /></span>
              <b>{starting ? "Adding…" : "Start from videos"}</b>
              <span className="muted small">Pick clips; they go on the timeline in order</span>
            </button>
            <div className="quick-card inbox-card">
              <span className="quick-icon i"><Icon name="folder" size={22} /></span>
              <b>Inbox {inbox.length ? <span className="count">{inbox.length}</span> : null}</b>
              {inbox.length === 0 ? (
                <span className="muted small">{WEB ? "Videos you share to OpenEdits Studio land here." : <>Drop media into {path.join(WORKSPACE, "inbox")}.</>}</span>
              ) : (
                <div className="inbox-list">
                  {inbox.slice(0, 3).map((f) => (
                    <div className="list-row" key={f.path}>
                      <span className={`kind-dot ${f.kind}`}><Icon name={f.kind === "video" ? "media" : f.kind === "audio" ? "audio" : "image"} size={12} /></span>
                      <span className="grow ellipsis" title={f.name}>{f.name}</span>
                      <button className="small-btn" onClick={() => void live.run("create_project", { files: [f.name], canvas: { aspectRatio: aspect } })}>Edit</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
          <div className="toolbar">
            <h1>Projects</h1>
            <div className="segmented small-seg">
              {(["all", "pinned", "favorites"] as const).map((f) => (
                <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                  {f[0].toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
            <input className="search" type="search" placeholder="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} />
            <div style={{ flex: 1 }} />
            {selected.length > 0 && (
              <div className="selection-bar">
                <span className="muted small">{selected.length} selected</span>
                <button
                  onClick={() => {
                    // Pin the selection (or unpin it when every selected project is already pinned).
                    const rows = projects.filter((p) => selected.includes(p.id));
                    const pin = rows.some((p) => !p.pinned);
                    void Promise.all(rows.filter((p) => p.pinned !== pin).map((p) => live.run("togglePin", { projectId: p.id }))).then(refresh);
                  }}
                >
                  {projects.filter((p) => selected.includes(p.id)).every((p) => p.pinned) ? "Unpin" : "Pin"}
                </button>
                <button
                  className="danger"
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
                <button className="ghost" onClick={() => setSelected([])}>
                  Done
                </button>
              </div>
            )}
          </div>
          {projects.length === 0 ? (
            loaded && filtered ? (
              <div className="empty">Nothing matches. Try another search or filter.</div>
            ) : (
              <div className="empty empty-projects">
                <h2>No projects yet</h2>
                <p className="muted">Your edits show up here. Start with the videos you want to edit, or an empty {ASPECTS.find((a) => a.id === aspect)!.label.toLowerCase()} canvas.</p>
              </div>
            )
          ) : (
            <div className="grid">
              {projects.map((p) => {
                const h = hue(p.id);
                const isSelected = selected.includes(p.id);
                return (
                  <div
                    key={p.id}
                    className={`card ${isSelected ? "selected" : ""}`}
                    tabIndex={0}
                    onClick={(e) => (additiveClick(e) || selected.length > 0 ? toggle(p.id, true) : open(p.id))}
                    onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && open(p.id)}
                    title="Open"
                  >
                    <div
                      className="thumb"
                      style={{
                        background: `radial-gradient(120% 90% at 20% 0%, hsl(${h} 70% 38% / 0.9), transparent 60%), linear-gradient(135deg, hsl(${(h + 40) % 360} 55% 22%), hsl(${(h + 90) % 360} 45% 12%))`,
                      }}
                    >
                      {p.thumbnailPath ? <img className="poster" src={`${fileUrl(p.thumbnailPath)}${fileUrl(p.thumbnailPath).includes("?") ? "&" : "?"}v=${p.updatedAt}`} alt="" draggable={false} /> : <AspectFrame aspect={p.aspectRatio} />}
                      <span className="duration">{duration(p.durationSeconds)}</span>
                      <button
                        className={`check ${isSelected ? "on" : ""}`}
                        title={isSelected ? "Deselect" : "Select"}
                        aria-pressed={isSelected}
                        onClick={(e) => (e.stopPropagation(), toggle(p.id, true))}
                      >
                        {isSelected ? "✓" : ""}
                      </button>
                      <div className="badges">
                        <button
                          className={p.pinned ? "on" : ""}
                          title={p.pinned ? "Unpin" : "Pin"}
                          onClick={(e) => (e.stopPropagation(), void live.run("togglePin", { projectId: p.id }).then(refresh))}
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                            <path
                              d="M15 3l6 6-3 1-4 4 1 5-2 2-4-5-5 5-1-1 5-5-5-4 2-2 5 1 4-4z"
                              fill={p.pinned ? "currentColor" : "none"}
                              stroke="currentColor"
                              strokeWidth="1.6"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                        <button
                          className={p.favorite ? "on fav" : ""}
                          title={p.favorite ? "Remove from favorites" : "Add to favorites"}
                          onClick={(e) => (e.stopPropagation(), void live.run("toggleFavorite", { projectId: p.id }).then(refresh))}
                        >
                          {p.favorite ? "★" : "☆"}
                        </button>
                      </div>
                    </div>
                    <div className="meta">
                      {renaming === p.id ? (
                        <input
                          autoFocus
                          defaultValue={p.name}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={(e) => {
                            setRenaming(null);
                            if (e.target.value.trim() && e.target.value !== p.name)
                              void live
                                .run("renameProject", {
                                  projectId: p.id,
                                  name: e.target.value.trim(),
                                })
                                .then(refresh);
                          }}
                          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                          style={{ width: "100%" }}
                        />
                      ) : (
                        <div className="title-row">
                          <div className="title" onDoubleClick={(e) => (e.stopPropagation(), setRenaming(p.id))} title={p.name}>
                            {p.name}
                          </div>
                          <button className="ghost icon rename" title="Rename" onClick={(e) => (e.stopPropagation(), setRenaming(p.id))}>
                            ✎
                          </button>
                        </div>
                      )}
                      <div className="sub">
                        {p.aspectRatio} · {ago(p.updatedAt)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </main>
        <aside className="home-extras">
          {showAutopilot && (
            <section className="side-card">
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
            </section>
          )}
          <section className="side-card">
            <h2>Keyboard shortcuts</h2>
            <select
              value={shortcutMap}
              onChange={(e) => {
                const v = e.target.value as ShortcutMapId;
                setShortcutMap(v);
                void live.run("updateSettings", { shortcutMap: v });
              }}
              style={{ width: "100%" }}
              aria-label="Shortcut layout"
            >
              {Object.entries(SHORTCUT_MAPS).map(([id, m]) => (
                <option key={id} value={id}>
                  {m.name}
                </option>
              ))}
            </select>
            <div className="shortcuts">
              {Object.entries(SHORTCUT_MAPS[shortcutMap].keys)
                .slice(0, 8)
                .map(([action, key]) => (
                  <div key={action} className="shortcut">
                    <span>{actionName(action)}</span>
                    <kbd>{keyName(String(key))}</kbd>
                  </div>
                ))}
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
