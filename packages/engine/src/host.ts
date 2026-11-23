import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  EditError,
  Session,
  addText,
  addMediaAssets,
  compositionDuration,
  createProject,
  getCatalogItem,
  randomIds,
  type Canvas,
  type CommitResult,
  type EditContext,
  type IdGenerator,
  type MediaAsset,
  type Project,
  type SessionEvent,
} from "@openedits/core";
import { Library, type ProjectFilter, type ProjectRow, type ProjectSort } from "./library.js";
import { ProjectStore, type RevisionInfo } from "./projectStore.js";
import { readPortableProject, writePortableProject } from "./portableProject.js";
import { CREATOR_TEMPLATES, listCreatorTemplates, readCreatorTemplate, saveCreatorTemplate } from "./templates.js";
import { acquireLock } from "./lock.js";
import { expandHome } from "./ffmpeg.js";
import { createFfprobe, type Prober } from "./media/probe.js";
import { listMediaFolder } from "./inbox.js";
import { JobManager } from "./jobs.js";
import { AudioService } from "./audio/service.js";
import { RenderService } from "./render/service.js";
import { TranscriptService } from "./transcript/service.js";
import { VisionService } from "./vision/service.js";
import { ClaudeClient, type AiClient } from "./ai/claude.js";
import { ensureWorkspace, loadSettings, resolveWorkspace, saveSettings, type Settings, type WorkspacePaths } from "./workspace.js";

export type Screen = "home" | "editor" | "loading";

/** Ephemeral UI/session state shared by the desktop UI and every MCP client. Not undoable. */
export interface AppState {
  screen: Screen;
  openProjectId: string | null;
  selection: { elementIds: string[] };
  playheadSeconds: number;
  isPlaying: boolean;
  loop: boolean;
  activeTool: string | null;
  homeSelection: string[];
  gridGuides: boolean;
  teleprompterOpen: boolean;
}

export interface EngineOptions {
  workspaceRoot?: string;
  ids?: IdGenerator;
  now?: () => number;
  prober?: Prober;
  /** Run invariant validation after every commit (tests). */
  validate?: boolean;
  /** Re-open the project that was open when the engine last stopped (default true). */
  restoreLastProject?: boolean;
  /** Model client (defaults to Claude, used only when enabled in settings). */
  ai?: AiClient;
  /** Remember the open project for the next start (default true; background engines turn it off). */
  persistSession?: boolean;
}

export interface ChangeEvent {
  projectId: string;
  kind: SessionEvent["kind"] | "revert" | "open" | "close";
  version: number;
  label: string;
  source: string;
  patches: SessionEvent["patches"];
}

interface OpenProject {
  id: string;
  session: Session;
  store: ProjectStore;
  release: () => void;
  unsubscribe: () => void;
}

/**
 * The engine: owns the workspace, the project library and the single open project session.
 * The desktop UI and all MCP clients drive the same instance, so they see one live composition.
 */
export class EngineHost extends EventEmitter {
  readonly paths: WorkspacePaths;
  settings: Settings;
  readonly library: Library;
  readonly ids: IdGenerator;
  readonly now: () => number;
  readonly prober: Prober;
  readonly instanceToken = randomUUID();
  readonly jobs = new JobManager();
  readonly audio: AudioService;
  readonly render: RenderService;
  readonly transcripts: TranscriptService;
  readonly vision: VisionService;
  readonly ai: AiClient;
  private readonly validate: boolean;
  private readonly persistSession: boolean;
  private current: OpenProject | null = null;
  private _appState: AppState = {
    screen: "home",
    openProjectId: null,
    selection: { elementIds: [] },
    playheadSeconds: 0,
    isPlaying: false,
    loop: false,
    activeTool: null,
    homeSelection: [],
    gridGuides: false,
    teleprompterOpen: false,
  };

  private constructor(opts: EngineOptions) {
    super();
    this.paths = resolveWorkspace(opts.workspaceRoot);
    ensureWorkspace(this.paths);
    this.settings = loadSettings(this.paths);
    this.library = new Library(this.paths.libraryDb);
    this.ids = opts.ids ?? randomIds;
    this.now = opts.now ?? Date.now;
    this.prober = opts.prober ?? createFfprobe();
    this.validate = opts.validate ?? false;
    this.audio = new AudioService(this);
    this.render = new RenderService(this);
    this.transcripts = new TranscriptService(this);
    this.vision = new VisionService(this);
    this.ai = opts.ai ?? new ClaudeClient(() => this.settings);
    this.persistSession = opts.persistSession ?? true;
  }

  static create(opts: EngineOptions = {}): EngineHost {
    const host = new EngineHost(opts);
    if (opts.restoreLastProject ?? true) host.restoreLastProject();
    return host;
  }

  // ------------------------------------------------------------------ desktop UI bridge

  private uiClients: ((req: { id: number; command: string; args: Record<string, unknown> }) => void)[] = [];
  private uiPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private uiSeq = 0;

  /** A desktop window connected; returns the detach function. */
  attachUi(send: (req: { id: number; command: string; args: Record<string, unknown> }) => void): () => void {
    this.uiClients.push(send);
    return () => {
      this.uiClients = this.uiClients.filter((c) => c !== send);
    };
  }

  get uiConnected(): boolean {
    return this.uiClients.length > 0;
  }

  resolveUi(id: number, ok: boolean, value: unknown) {
    const p = this.uiPending.get(id);
    if (!p) return;
    this.uiPending.delete(id);
    clearTimeout(p.timer);
    if (ok) p.resolve(value);
    else p.reject(new EditError("INTERNAL", String(value)));
  }

  /** Ask the most recently connected desktop window to do something only it can (e.g. record the mic). */
  requestUi(command: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    const send = this.uiClients[this.uiClients.length - 1];
    if (!send) return Promise.reject(new EditError("NOT_IMPLEMENTED", `${command} needs the OpenEdits desktop app to be open`));
    const id = ++this.uiSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.uiPending.delete(id);
        reject(new EditError("INTERNAL", `The desktop app did not answer ${command} in time`));
      }, timeoutMs);
      this.uiPending.set(id, { resolve, reject, timer });
      send({ id, command, args });
    });
  }

  // ------------------------------------------------------------------ app state

  get appState(): AppState {
    return structuredClone(this._appState);
  }

  setAppState(patch: Partial<AppState>): AppState {
    this._appState = { ...this._appState, ...patch };
    this.emit("appState", this.appState);
    return this.appState;
  }

  // ------------------------------------------------------------------ projects

  private projectDir(id: string) {
    return path.join(this.paths.projects, id);
  }

  listProjects(opts: { filter?: ProjectFilter; sort?: ProjectSort; query?: string } = {}): ProjectRow[] {
    return this.library.list(opts);
  }

  requireProjectRow(id: string): ProjectRow {
    const row = this.library.get(id);
    if (!row) throw new EditError("PROJECT_NOT_FOUND", `No project "${id}"`, { projectId: id });
    return row;
  }

  newProject(opts: { name?: string; canvas?: Partial<Canvas> } = {}): Project {
    const id = this.ids("prj");
    const now = this.now();
    const name = opts.name?.trim() || `Project ${this.library.list().length + 1}`;
    const project = createProject({ id, name, canvas: opts.canvas, ids: this.ids, now });
    this.addProject(project);
    return project;
  }

  private addProject(project: Project) {
    const { id, name } = project;
    const now = this.now();
    const dir = this.projectDir(id);
    fs.mkdirSync(dir);
    try {
      const store = ProjectStore.create(dir, project, now);
      store.close();
      this.library.create({ id, name, dir, aspectRatio: project.canvas.aspectRatio, now });
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    this.library.updateSummary(id, { updatedAt: now, durationSeconds: compositionDuration(project) });
    this.openProject(id);
  }

  backupProject(destination: string, collectMedia: boolean) {
    return writePortableProject(this.project, destination, collectMedia);
  }

  openProjectBackup(file: string) {
    const project = readPortableProject(file);
    project.id = this.ids("prj");
    project.createdAt = this.now();
    this.addProject(project);
    return project.id;
  }

  listTemplates() { return listCreatorTemplates(path.join(this.paths.root, "templates")); }

  saveTemplate(name: string) {
    return saveCreatorTemplate(path.join(this.paths.root, "templates"), name, this.project);
  }

  startFromTemplate(templateId: string, name: string | undefined, source: string) {
    const builtin = CREATOR_TEMPLATES.find((item) => item.id === templateId);
    if (builtin) {
      const preset = getCatalogItem("textPresets", builtin.titleStyle);
      const id = this.ids("prj");
      const project = createProject({ id, name: name ?? builtin.name, ids: this.ids, now: this.now() });
      project.preferredCaptionStyle = builtin.caption;
      this.addProject(project);
      const { style } = preset.data as { style?: Partial<import("@openedits/core").TextStyle> };
      this.mutate("Add template title", source, (ctx) => addText(ctx, {
        text: builtin.title, start: 0, duration: 3, presetId: preset.id,
        style, transform: { y: 0.18 },
      }));
      return id;
    }
    const project = readCreatorTemplate(path.join(this.paths.root, "templates"), templateId);
    project.id = this.ids("prj");
    project.name = name ?? project.name;
    project.createdAt = this.now();
    this.addProject(project);
    return project.id;
  }

  openProject(id: string): Project {
    const row = this.requireProjectRow(id);
    if (this.current?.id === id) return this.current.session.state;
    this.closeProject();
    this.setAppState({ screen: "loading" });
    let release: (() => void) | undefined;
    let store: ProjectStore | undefined;
    try {
      release = acquireLock(path.join(row.dir, "project.lock"), this.instanceToken);
      store = ProjectStore.open(row.dir);
      const { project, version } = store.load();
      const session = new Session(project, { ids: this.ids, now: this.now, version, validate: this.validate });
      session.importHistory(store.loadHistory());
      const s = store;
      const unsubscribe = session.onEvent((e) => {
        s.recordEvent(e.kind, e.entry, session.state, e.version, this.now());
        this.library.updateSummary(id, {
          name: session.state.name,
          durationSeconds: compositionDuration(session.state),
          aspectRatio: session.state.canvas.aspectRatio,
          updatedAt: this.now(),
        });
        const change: ChangeEvent = { projectId: id, kind: e.kind, version: e.version, label: e.label, source: e.source, patches: e.patches };
        this.emit("change", change);
      });
      this.current = { id, session, store, release, unsubscribe };
    } catch (e) {
      store?.close();
      release?.();
      this.setAppState({ screen: "home" });
      throw e;
    }
    this.library.touchOpened(id, this.now());
    this.setAppState({ screen: "editor", openProjectId: id, selection: { elementIds: [] }, playheadSeconds: 0, activeTool: null, isPlaying: false });
    this.persistSessionFile();
    this.emit("change", { projectId: id, kind: "open", version: this.current.session.version, label: "open", source: "engine", patches: [] } satisfies ChangeEvent);
    return this.current.session.state;
  }

  closeProject(): string | null {
    const cur = this.current;
    if (!cur) return null;
    cur.unsubscribe();
    cur.store.saveState(cur.session.state, cur.session.version, this.now());
    cur.store.close();
    cur.release();
    this.current = null;
    this.setAppState({ screen: "home", openProjectId: null, selection: { elementIds: [] }, activeTool: null, isPlaying: false });
    this.persistSessionFile();
    this.emit("change", { projectId: cur.id, kind: "close", version: cur.session.version, label: "close", source: "engine", patches: [] } satisfies ChangeEvent);
    return cur.id;
  }

  /** Flush state to disk; optionally record a numbered revision. */
  saveProject(opts: { revisionLabel?: string; source?: string } = {}): { projectId: string; version: number; revision?: RevisionInfo } {
    const cur = this.requireOpen();
    cur.store.saveState(cur.session.state, cur.session.version, this.now());
    const revision = opts.revisionLabel ? cur.store.saveRevision(cur.session.state, cur.session.version, opts.revisionLabel, opts.source ?? "engine", this.now()) : undefined;
    return { projectId: cur.id, version: cur.session.version, ...(revision ? { revision } : {}) };
  }

  renameProject(id: string, name: string) {
    this.requireProjectRow(id);
    if (this.current?.id === id) {
      this.mutate("Rename project", "engine", (ctx) => {
        ctx.draft.name = name;
      }, { skipFinalize: true });
    }
    this.library.rename(id, name, this.now());
    return this.library.get(id)!;
  }

  /** Moves the project folder to the workspace trash (recoverable) and removes it from the library. */
  deleteProject(id: string): { projectId: string; trashedTo: string } {
    const row = this.requireProjectRow(id);
    if (this.current?.id === id) this.closeProject();
    const dest = path.join(this.paths.trash, `${id}-${this.now()}`);
    const exists = fs.existsSync(row.dir);
    if (exists) {
      fs.writeFileSync(path.join(row.dir, "trash-info.json"), JSON.stringify(row));
      fs.renameSync(row.dir, dest);
    }
    try {
      this.library.delete(id);
    } catch (error) {
      if (exists) fs.renameSync(dest, row.dir);
      throw error;
    }
    this.setAppState({ homeSelection: this._appState.homeSelection.filter((x) => x !== id) });
    return { projectId: id, trashedTo: dest };
  }

  private trashedProject(entry: string): { row: ProjectRow; deletedAt: number } {
    const match = /^([\w-]+)-(\d+)$/.exec(entry);
    if (!match) throw new EditError("PROJECT_NOT_FOUND", "Trash entry unavailable.");
    const [, id, deletedAt] = match;
    const folder = path.join(this.paths.trash, entry);
    if (!fs.lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
      throw new EditError("PROJECT_NOT_FOUND", "Trash entry unavailable.");
    }
    const dir = this.projectDir(id);
    try {
      const previous = JSON.parse(fs.readFileSync(path.join(folder, "trash-info.json"), "utf8")) as ProjectRow;
      if (previous.id === id) return { row: { ...previous, dir }, deletedAt: Number(deletedAt) };
    } catch {
      // Projects deleted before Trash was added have only the project database.
    }
    const { project } = ProjectStore.readOverview(folder);
    if (project.id !== id) throw new EditError("PROJECT_NOT_FOUND", "Trash entry does not match its project.");
    return {
      deletedAt: Number(deletedAt),
      row: {
        id, dir, name: project.name, aspectRatio: project.canvas.aspectRatio,
        createdAt: project.createdAt, updatedAt: Number(deletedAt), openedAt: null,
        pinned: false, favorite: false, thumbnailPath: null, durationSeconds: compositionDuration(project),
      },
    };
  }

  listTrash() {
    return fs.readdirSync(this.paths.trash, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      try {
        const { row, deletedAt } = this.trashedProject(entry.name);
        return [{ entry: entry.name, name: row.name, deletedAt }];
      } catch {
        return [];
      }
    }).sort((a, b) => b.deletedAt - a.deletedAt);
  }

  restoreTrash(entry: string) {
    const { row } = this.trashedProject(entry);
    if (this.library.get(row.id) || fs.existsSync(row.dir)) {
      throw new EditError("INVALID_ARGUMENT", "A project with this ID already exists.");
    }
    const folder = path.join(this.paths.trash, entry);
    fs.renameSync(folder, row.dir);
    try {
      this.library.restore(row);
    } catch (error) {
      fs.renameSync(row.dir, folder);
      throw error;
    }
    return row;
  }

  togglePin(id: string): boolean {
    this.requireProjectRow(id);
    return this.library.togglePin(id);
  }

  toggleFavorite(id: string): boolean {
    this.requireProjectRow(id);
    return this.library.toggleFavorite(id);
  }

  private persistSessionFile() {
    if (!this.persistSession) return;
    try {
      fs.writeFileSync(this.paths.sessionFile, JSON.stringify({ openProjectId: this.current?.id ?? null }) + "\n");
    } catch {
      /* non-fatal */
    }
  }

  private restoreLastProject() {
    try {
      const { openProjectId } = JSON.parse(fs.readFileSync(this.paths.sessionFile, "utf8"));
      if (openProjectId && this.library.get(openProjectId)) this.openProject(openProjectId);
    } catch {
      /* nothing to restore */
    }
  }

  // ------------------------------------------------------------------ session access

  get isOpen(): boolean {
    return this.current !== null;
  }

  private requireOpen(): OpenProject {
    if (!this.current) throw new EditError("NO_PROJECT_OPEN", "No project is open. Use newProject or openProject first.");
    return this.current;
  }

  get session(): Session {
    return this.requireOpen().session;
  }

  get project(): Project {
    return this.requireOpen().session.state;
  }

  /** Inspect any project without taking its edit lock or changing the editor session. */
  readProjectOverview(projectId?: string) {
    if (projectId !== undefined && projectId !== this.current?.id) {
      return ProjectStore.readOverview(this.requireProjectRow(projectId).dir);
    }
    const { session, store } = this.requireOpen();
    return {
      project: session.state,
      version: session.version,
      canUndo: session.canUndo,
      canRedo: session.canRedo,
      revisions: store.listRevisions(),
      transcribedMediaIds: store.listTranscribedMediaIds(),
    };
  }

  get projectId(): string {
    return this.requireOpen().id;
  }

  get projectDirPath(): string {
    return this.requireOpen().store.dir;
  }

  /** The open project's database (transcripts and other analysis data live here, outside undo). */
  get store(): ProjectStore {
    return this.requireOpen().store;
  }

  /** Run one atomic, undoable edit on the open project. */
  mutate<R>(label: string, source: string, recipe: (ctx: EditContext) => R, opts: { expectedVersion?: number; skipFinalize?: boolean } = {}): CommitResult<R> {
    const res = this.requireOpen().session.transact(label, source, recipe, opts);
    // Drop selections that no longer exist.
    const sel = this._appState.selection.elementIds.filter((id) => this.project.elements[id]);
    if (sel.length !== this._appState.selection.elementIds.length) this.setAppState({ selection: { elementIds: sel } });
    return res;
  }

  undo(source: string, expectedVersion?: number) {
    return this.requireOpen().session.undo(source, { expectedVersion });
  }

  redo(source: string, expectedVersion?: number) {
    return this.requireOpen().session.redo(source, { expectedVersion });
  }

  saveRevision(label: string, source: string): RevisionInfo {
    const cur = this.requireOpen();
    return cur.store.saveRevision(cur.session.state, cur.session.version, label, source, this.now());
  }

  listRevisions(): RevisionInfo[] {
    return this.requireOpen().store.listRevisions();
  }

  /**
   * Restore a numbered revision. The current state is saved as a new revision first,
   * and the revert itself is a single undoable step.
   */
  revert(revisionNumber: number, source: string, expectedVersion?: number) {
    const cur = this.requireOpen();
    const snapshot = cur.store.getRevision(revisionNumber);
    if (!snapshot) throw new EditError("REVISION_NOT_FOUND", `No revision #${revisionNumber}`, { revisions: cur.store.listRevisions().map((r) => r.number) });
    const backup = cur.store.saveRevision(cur.session.state, cur.session.version, `Before revert to #${revisionNumber}`, source, this.now());
    const res = cur.session.replace(`Revert to revision #${revisionNumber}`, source, snapshot, { expectedVersion });
    return { ...res, backupRevision: backup.number };
  }

  // ------------------------------------------------------------------ media

  /** Probe files and add them to the media panel (deduplicated by path). */
  async importMedia(paths: string[], opts: { folderId?: string; source?: string } = {}): Promise<{ assets: MediaAsset[]; added: string[]; existing: string[] }> {
    const target = this.requireOpen();
    if (paths.length === 0) throw new EditError("INVALID_ARGUMENT", "No paths given");
    const resolved = paths.map((p) => path.resolve(expandHome(p)));
    const byPath = new Map(Object.values(this.project.media).map((m) => [m.path, m]));
    const assets: MediaAsset[] = [];
    const toAdd: MediaAsset[] = [];
    const existing: string[] = [];
    for (const file of resolved) {
      const prev = byPath.get(file);
      if (prev) {
        assets.push(prev);
        existing.push(prev.id);
        continue;
      }
      const probe = await this.prober(file);
      const asset: MediaAsset = {
        id: this.ids("med"),
        name: path.basename(file),
        path: file,
        importedAt: this.now(),
        ...(opts.folderId ? { folderId: opts.folderId } : {}),
        ...probe,
      };
      byPath.set(file, asset);
      toAdd.push(asset);
      assets.push(asset);
    }
    if (this.current !== target) throw new EditError("INVALID_ARGUMENT", "The project changed during import. Reopen it to import these files.");
    if (toAdd.length) {
      if (opts.folderId && !this.project.mediaFolders.some((f) => f.id === opts.folderId)) throw new EditError("INVALID_ARGUMENT", `No media folder ${opts.folderId}`);
      this.mutate(`Import ${toAdd.length} media file${toAdd.length > 1 ? "s" : ""}`, opts.source ?? "engine", (ctx) => addMediaAssets(ctx, toAdd), { skipFinalize: true });
    }
    return { assets, added: toAdd.map((a) => a.id), existing };
  }

  /** Reconnect an imported source without changing clip, transcript or asset IDs. */
  async relinkMedia(mediaId: string, file: string, source: string, expectedVersion?: number) {
    const target = this.requireOpen();
    const asset = target.session.state.media[mediaId];
    if (!asset) throw new EditError("MEDIA_NOT_FOUND", `No media with id "${mediaId}"`);
    const replacement = path.resolve(expandHome(file));
    const probe = await this.prober(replacement);
    if (this.current !== target) throw new EditError("VERSION_CONFLICT", "The open project changed while locating media.");
    if (probe.kind !== asset.kind || probe.hasAudio !== asset.hasAudio || probe.hasVideo !== asset.hasVideo
      || probe.width !== asset.width || probe.height !== asset.height
      || (asset.sizeBytes > 0 && probe.sizeBytes !== asset.sizeBytes)
      || Math.abs((probe.durationSourceSeconds ?? 0) - (asset.durationSourceSeconds ?? 0)) > 0.05) {
      throw new EditError("UNSUPPORTED_MEDIA", `Choose the original file for ${asset.name}. The selected file does not match.`);
    }
    return this.mutate(`Locate ${asset.name}`, source, (c) => {
      const current = c.draft.media[mediaId];
      if (!current || current.path !== asset.path) throw new EditError("VERSION_CONFLICT", "The media changed while locating it.");
      current.path = replacement;
    }, { expectedVersion, skipFinalize: true });
  }

  // ------------------------------------------------------------------ watch folders & style guide

  listInbox(opts: { probe?: boolean } = {}) {
    return listMediaFolder(this.paths.inbox, { probe: opts.probe ? this.prober : undefined });
  }

  listAutoEditFolder() {
    return listMediaFolder(this.paths.autoEdit);
  }

  getStyleGuide(): string {
    try {
      return fs.readFileSync(this.paths.styleGuideFile, "utf8");
    } catch {
      return "";
    }
  }

  saveStyleGuide(text: string) {
    fs.writeFileSync(this.paths.styleGuideFile, text);
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.paths, this.settings);
    return this.settings;
  }

  dispose() {
    void this.jobs.cancelAll();
    this.render.dispose();
    this.closeProjectKeepingSession();
    this.library.close();
    this.removeAllListeners();
  }

  /** Close without forgetting which project was open (so the next start restores it). */
  private closeProjectKeepingSession() {
    const cur = this.current;
    if (!cur) return;
    cur.unsubscribe();
    cur.store.saveState(cur.session.state, cur.session.version, this.now());
    cur.store.close();
    cur.release();
    this.current = null;
  }
}
