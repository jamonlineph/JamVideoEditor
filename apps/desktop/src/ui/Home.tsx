import { useEffect, useRef, useState, type FormEvent } from "react";
import path from "node:path";
import { ipcRenderer } from "electron";
import { EditorIcon } from "./EditorIcon.js";
import { additiveClick, fileUrl, live, useLive, WEB, WORKSPACE } from "./live.js";
import { SHORTCUT_MAPS, type ShortcutMapId } from "./shortcuts.js";

interface ProjectRow {
  id: string;
  name: string;
  updatedAt: number;
  openedAt: number | null;
  pinned: boolean;
  favorite: boolean;
  durationSeconds: number;
  aspectRatio: string;
  thumbnailPath: string | null;
}

interface InboxFile {
  name: string;
  path: string;
  kind: string;
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

const sections = [
  { id: "projects", label: "Projects", icon: "projects" },
  { id: "inbox", label: "Inbox", icon: "inbox" },
  { id: "settings", label: "Settings", icon: "settings" },
] as const;

const filters = [
  { id: "all", label: "All projects" },
  { id: "pinned", label: "Pinned" },
  { id: "favorites", label: "Favorites" },
] as const;

const aspects = [
  { id: "9:16", label: "Vertical" },
  { id: "16:9", label: "Widescreen" },
  { id: "1:1", label: "Square" },
  { id: "4:5", label: "Portrait" },
] as const;

type Section = (typeof sections)[number]["id"];
type Filter = (typeof filters)[number]["id"];
type Aspect = (typeof aspects)[number]["id"];
type CreationMode = "empty" | "files";

const actionName = (action: string) => action.replace(/([A-Z])/g, " $1").toLowerCase().replace(/^./, (c) => c.toUpperCase());
const keyName = (key: string) =>
  key.replace(/Meta\+/g, navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl+").replace(/Arrow(Left|Right|Up|Down)/, (_match, direction: string) => ({ Left: "←", Right: "→", Up: "↑", Down: "↓" })[direction] ?? direction);

function editedLabel(time: number) {
  const date = new Date(time);
  return `Edited ${date.toDateString() === new Date().toDateString() ? "today" : date.toLocaleDateString(undefined, { dateStyle: "medium" })}`;
}

function duration(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="6" fill="#a3e7d5" />
      <path d="M8 5.5v13l10.5-6.5z" fill="#102923" />
    </svg>
  );
}

export function Home({ onOpenProject, onOpenMcp }: { onOpenProject: () => void; onOpenMcp: () => void }) {
  const { connected, appState } = useLive();
  const openProjectId = appState?.openProjectId;
  const [projects, setProjects] = useState<ProjectRow[]>();
  const [projectsError, setProjectsError] = useState("");
  const [section, setSection] = useState<Section>("projects");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<"updated" | "name">("updated");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [inbox, setInbox] = useState<InboxFile[]>();
  const [inboxError, setInboxError] = useState(false);
  const [jobs, setJobs] = useState<AutopilotJob[]>([]);
  const [waiting, setWaiting] = useState<string[]>([]);
  const [shortcutMap, setShortcutMap] = useState<ShortcutMapId>("edits");
  const [aspect, setAspect] = useState<Aspect>("9:16");
  const [createMode, setCreateMode] = useState<CreationMode | null>(null);
  const [opening, setOpening] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const tasks = [
        live.call<{ projects: ProjectRow[] }>("projects").then((result) => {
          if (stopped) return;
          setProjects(result.projects);
          setProjectsError("");
          const ids = new Set(result.projects.map((project) => project.id));
          setSelected((current) => current.filter((id) => ids.has(id)));
        }).catch(() => { if (!stopped) setProjectsError("Couldn’t load projects."); }),
        live.call<{ files: InboxFile[] }>("list_inbox").then((result) => {
          if (stopped) return;
          setInbox(result.files);
          setInboxError(false);
        }).catch(() => { if (!stopped) setInboxError(true); }),
        live.call<{ jobs: AutopilotJob[]; waiting: string[] }>("list_autopilot_jobs", { limit: 8 }).then((result) => {
          if (stopped) return;
          setJobs(result.jobs);
          setWaiting(result.waiting);
        }),
        live.call<{ shortcutMap: ShortcutMapId }>("getSettings").then((result) => { if (!stopped) setShortcutMap(result.shortcutMap); }),
      ];
      await Promise.allSettled(tasks);
      if (!stopped) timer = setTimeout(refresh, 5000);
    };
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [connected, refreshKey, openProjectId]);

  const refresh = () => setRefreshKey((key) => key + 1);
  const toggleSelection = (id: string) => setSelected((current) =>
    current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const open = async (id: string) => {
    if (!connected || opening) return;
    setOpening(true);
    try {
      const result = await live.run("openProject", { projectId: id });
      if (result && live.state.appState?.openProjectId === id) onOpenProject();
    } finally {
      setOpening(false);
    }
  };

  const currentProject = projects?.find((project) => project.id === openProjectId);
  const lastProject = projects?.reduce<ProjectRow | undefined>((latest, project) =>
    (project.openedAt ?? 0) > (latest?.openedAt ?? 0) ? project : latest, undefined);
  const recent = currentProject ?? lastProject;
  const matching = (projects ?? []).filter((project) => {
    if (filter === "pinned" && !project.pinned) return false;
    if (filter === "favorites" && !project.favorite) return false;
    return project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  });
  if (sort === "name") matching.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
  const selectedProjects = matching.filter((project) => selected.includes(project.id));
  const pinSelection = selectedProjects.some((project) => !project.pinned);
  const showAutopilot = !WEB || jobs.length > 0 || waiting.length > 0;

  return (
    <div className="home-shell">
      <header className="titlebar home-titlebar">
        <span className="brand"><Logo />OpenEdits Studio</span>
        <div className="spacer" />
        <span className="connection-status" role="status">
          <i className={`status-dot ${connected ? "" : "off"}`} />
          <span>{connected ? "Engine online" : "Reconnecting"}</span>
        </span>
        <button className="home-mcp" aria-haspopup="dialog" onClick={onOpenMcp}><EditorIcon name="plug" />MCP settings</button>
      </header>
      <div className="home">
        <nav className="home-nav" aria-label="Home">
          {sections.map((item) => (
            <button key={item.id} className={section === item.id ? "on" : "ghost"} aria-current={section === item.id ? "page" : undefined} onClick={() => setSection(item.id)}>
              <EditorIcon name={item.icon} />{item.label}
              {item.id === "inbox" && !!inbox?.length && <span className="nav-count">{inbox.length}</span>}
            </button>
          ))}
        </nav>
        <main className="home-content" key={section}>
          {section === "projects" && <>
            <header className="home-heading">
              <div><h1>Projects</h1><p>Find a past edit or start a new one.</p></div>
              <div className="home-actions">
                <button onClick={() => setCreateMode("files")} disabled={!connected || opening}><EditorIcon name="import" />Start from files</button>
                <button className="primary" onClick={() => setCreateMode("empty")} disabled={!connected || opening}><EditorIcon name="plus" />New project</button>
              </div>
            </header>
            {recent && <div className="resume-project">
              <ProjectArt project={recent} />
              <div>
                <span className="muted small">{currentProject ? "Current project" : "Last opened"}</span>
                <strong title={recent.name}>{recent.name}</strong>
                <span className="muted small">{recent.aspectRatio} · {duration(recent.durationSeconds)}</span>
              </div>
              <button disabled={!connected || opening} onClick={() => void open(recent.id)}><EditorIcon name="play" />Resume editing</button>
            </div>}
            <div className="project-toolbar">
              <div className="segmented" role="group" aria-label="Filter projects">
                {filters.map((item) => (
                  <button key={item.id} className={filter === item.id ? "on" : ""} aria-pressed={filter === item.id} onClick={() => {
                    setFilter(item.id);
                    setSelected([]);
                  }}>{item.label}</button>
                ))}
              </div>
              <label className="project-search">
                <EditorIcon name="search" />
                <input type="search" aria-label="Search projects" placeholder="Search projects" value={query} onChange={(e) => {
                  setQuery(e.target.value);
                  setSelected([]);
                }} />
              </label>
              <select aria-label="Sort projects" value={sort} onChange={(e) => setSort(e.target.value === "name" ? "name" : "updated")}>
                <option value="updated">Last edited</option>
                <option value="name">Name</option>
              </select>
            </div>
            {!!selectedProjects.length && <div className="selection-bar">
              <span>{selectedProjects.length} selected</span>
              <button disabled={!connected} onClick={async () => {
                await Promise.all(selectedProjects.filter((project) => project.pinned !== pinSelection)
                  .map((project) => live.run("togglePin", { projectId: project.id })));
                refresh();
              }}>{pinSelection ? "Pin selection" : "Unpin selection"}</button>
              <button className="danger" disabled={!connected} onClick={async () => {
                const label = selectedProjects.length === 1 ? "1 project" : `${selectedProjects.length} projects`;
                if (!confirm(`Move ${label} to the workspace trash?`)) return;
                await Promise.all(selectedProjects.map((project) => live.run("deleteProject", { projectId: project.id })));
                setSelected([]);
                refresh();
              }}>Move to trash</button>
              <button className="ghost" onClick={() => setSelected([])}>Clear selection</button>
            </div>}
            {projectsError && <div className="home-message" role="status">
              <span>{projectsError}</span>
              <button disabled={!connected} onClick={refresh}>Retry</button>
            </div>}
            {!projects && !projectsError && <div className="home-message" role="status">{connected ? "Loading projects…" : "Waiting for the engine…"}</div>}
            {projects && !matching.length && <div className="home-empty">
              <EditorIcon name="projects" />
              <h2>{filter !== "all" || query.trim() ? "No matching projects" : "No projects yet"}</h2>
              <p>{filter !== "all" || query.trim() ? "Try another search or filter." : "Create a project or start with media from your device."}</p>
            </div>}
            {!!matching.length && <div className="project-grid">
              {matching.map((project) => <ProjectCard key={project.id} project={project} busy={!connected || opening}
                selected={selected.includes(project.id)} onOpen={() => void open(project.id)}
                onSelect={() => toggleSelection(project.id)} onChange={refresh} />)}
            </div>}
          </>}
          {section === "inbox" && <>
            <header className="home-heading"><div><h1>Inbox</h1><p>Media shared with your workspace.</p></div></header>
            <section className="home-settings-card" aria-label="Shared media">
              {inboxError && <div className="home-message" role="status">
                <span>Couldn’t load the inbox.</span><button disabled={!connected} onClick={refresh}>Retry</button>
              </div>}
              {!inbox && !inboxError && <p className="muted" role="status">{connected ? "Loading inbox…" : "Waiting for the engine…"}</p>}
              {inbox?.length === 0 && <p className="muted">{WEB ? "Files shared to OpenEdits Studio from other apps appear here." : <>Drop media into <code>{path.join(WORKSPACE, "inbox")}</code>.</>}</p>}
              {inbox?.map((file) => (
                <div className="list-row" key={file.path}>
                  <EditorIcon name={file.kind === "audio" ? "audio" : "media"} />
                  <span className="grow" title={file.name}>{file.name}</span>
                  <button disabled={!connected || opening} onClick={async () => {
                    setOpening(true);
                    try {
                      await live.run("create_project", { files: [file.name], canvas: { aspectRatio: aspect } });
                    } finally {
                      setOpening(false);
                    }
                  }}>Edit</button>
                </div>
              ))}
            </section>
            {showAutopilot && <section className="home-settings-card">
              <h2>Autopilot</h2>
              <p className="muted">Videos in the auto-edit folder get a first pass based on STYLE.md.</p>
              {waiting.map((file) => <div className="list-row" key={file}><span className="grow">{file}</span>Waiting</div>)}
              {jobs.map((job) => <div className="list-row" key={job.id} title={job.error ?? job.output}>
                <span className="grow">{job.projectName ?? path.basename(job.files[0] ?? "")}</span>
                <span className="muted">{job.status === "running" ? job.step : job.status}</span>
              </div>)}
              {!jobs.length && !waiting.length && <p className="muted">No jobs yet.</p>}
            </section>}
          </>}
          {section === "settings" && <>
            <header className="home-heading"><div><h1>Settings</h1><p>Manage connections and keyboard shortcuts.</p></div></header>
            <section className="home-settings-card settings-mcp">
              <div><h2>MCP connection</h2><p className="muted">Connect Antigravity or another Streamable HTTP MCP client to your editor.</p></div>
              <button aria-haspopup="dialog" onClick={onOpenMcp}><EditorIcon name="plug" />MCP settings</button>
            </section>
            <section className="home-settings-card">
              <div className="settings-mcp">
                <h2>Keyboard shortcuts</h2>
                <select aria-label="Shortcut layout" value={shortcutMap} disabled={!connected} onChange={(e) => {
                  const value = e.target.value as ShortcutMapId;
                  setShortcutMap(value);
                  void live.run("updateSettings", { shortcutMap: value }).then(refresh);
                }}>
                  {Object.entries(SHORTCUT_MAPS).map(([id, map]) => <option key={id} value={id}>{map.name}</option>)}
                </select>
              </div>
              <div className="shortcuts">
                {Object.entries(SHORTCUT_MAPS[shortcutMap].keys).map(([action, key]) => (
                  <div className="shortcut" key={action}><span>{actionName(action)}</span><kbd>{keyName(String(key))}</kbd></div>
                ))}
              </div>
            </section>
          </>}
        </main>
      </div>
      {createMode && <CreateProjectDialog mode={createMode} aspect={aspect} setAspect={setAspect} onClose={() => setCreateMode(null)} />}
    </div>
  );
}

function ProjectArt({ project }: { project: ProjectRow }) {
  const [failed, setFailed] = useState(false);
  const tone = [...project.id].reduce((total, char) => (total * 31 + char.charCodeAt(0)) % 6, 0);
  return (
    <span className={`project-art tone-${tone}`} aria-hidden="true">
      {project.thumbnailPath && !failed
        ? <img loading="lazy" src={fileUrl(project.thumbnailPath)} alt="" onError={() => setFailed(true)} />
        : <span className="project-frame" style={{ aspectRatio: project.aspectRatio.replace(":", " / ") }}><EditorIcon name="timeline" /></span>}
    </span>
  );
}

function ProjectCard({ project, busy, selected, onOpen, onSelect, onChange }: {
  project: ProjectRow;
  busy: boolean;
  selected: boolean;
  onOpen: () => void;
  onSelect: () => void;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const actions = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);

  function run(tool: "togglePin" | "toggleFavorite") {
    if (actions.current) actions.current.open = false;
    trigger.current?.focus();
    void live.run(tool, { projectId: project.id }).then(onChange);
  }

  async function rename(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) return;
    const result = await live.run("renameProject", { projectId: project.id, name: name.trim() });
    if (!result) return;
    setEditing(false);
    onChange();
  }

  return (
    <article className={`project-card ${selected ? "selected" : ""}`}>
      <button className="project-open" aria-label={`Open ${project.name}`} disabled={busy} onClick={(e) => additiveClick(e) ? onSelect() : onOpen()}>
        <ProjectArt project={project} />
        <span className="project-duration">{duration(project.durationSeconds)}</span>
        <span className="project-meta">
          <strong title={project.name}>{project.name}</strong>
          <span className="muted small">{project.aspectRatio} · {editedLabel(project.updatedAt)}</span>
        </span>
      </button>
      <button className={`project-select icon ${selected ? "on" : ""}`} aria-label={`Select ${project.name}`} aria-pressed={selected} disabled={busy} onClick={onSelect}>
        {selected && <EditorIcon name="check" />}
      </button>
      <div className="project-actions">
        {project.pinned && <span title="Pinned"><EditorIcon name="pin" /></span>}
        {project.favorite && <span title="Favorite"><EditorIcon name="star" /></span>}
        <details ref={actions} className="editor-more" onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false;
        }} onKeyDown={(e) => {
          if (e.key !== "Escape" || !e.currentTarget.open) return;
          e.currentTarget.open = false;
          trigger.current?.focus();
        }}>
          <summary ref={trigger} aria-label={`Actions for ${project.name}`} title="Project actions"><EditorIcon name="more" /></summary>
          <div className="editor-menu">
            <button disabled={busy} onClick={() => {
              if (actions.current) actions.current.open = false;
              setName(project.name);
              setEditing(true);
            }}>Rename</button>
            <button disabled={busy} onClick={() => run("togglePin")}>{project.pinned ? "Unpin" : "Pin to projects"}</button>
            <button disabled={busy} onClick={() => run("toggleFavorite")}>{project.favorite ? "Remove favorite" : "Add to favorites"}</button>
          </div>
        </details>
      </div>
      {editing && <form className="project-rename" onSubmit={rename} onKeyDown={(e) => {
        if (e.key === "Escape") setEditing(false);
      }}>
        <input autoFocus required aria-label="Project name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="primary">Save</button>
        <button type="button" className="icon ghost" aria-label="Cancel rename" onClick={() => setEditing(false)}><EditorIcon name="close" /></button>
      </form>}
    </article>
  );
}

function CreateProjectDialog({ mode, aspect, setAspect, onClose }: {
  mode: CreationMode;
  aspect: Aspect;
  setAspect: (aspect: Aspect) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fromFiles = mode === "files";

  useEffect(() => { dialog.current?.showModal(); }, []);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
    setBusy(true);
    setError("");
    try {
      const options = { ...(name ? { name } : {}), canvas: { aspectRatio: aspect } };
      if (fromFiles) {
        const files = await ipcRenderer.invoke("pick-files", { multi: true }) as string[];
        if (files.length) await live.call("create_project", { ...options, files });
      } else {
        await live.call("newProject", options);
      }
    } catch (cause) {
      const message = (cause as Error).message;
      if (dialog.current?.open) setError(message);
      else live.toast("error", message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog className="dialog setup-dialog" ref={dialog} aria-labelledby="create-title" onClose={onClose} onCancel={(e) => {
      if (busy) e.preventDefault();
    }}>
      <h3 id="create-title">{fromFiles ? "Start from files" : "New project"}</h3>
      <form onSubmit={create}>
        <label className="setup-field">Project name<input name="name" placeholder="Optional" maxLength={160} autoFocus disabled={busy} /></label>
        <label className="setup-field">Canvas format
          <select value={aspect} onChange={(e) => setAspect(e.target.value as Aspect)} disabled={busy}>
            {aspects.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.id}</option>)}
          </select>
        </label>
        {error && <p className="setup-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? "Opening…" : fromFiles ? "Choose files" : "Create project"}</button>
        </div>
      </form>
    </dialog>
  );
}
