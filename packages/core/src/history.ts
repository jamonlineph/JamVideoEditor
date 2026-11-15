import { applyPatches, current, enablePatches, isDraft, produceWithPatches, type Patch } from "immer";
import type { Project } from "./schema.js";
import { EditError } from "./errors.js";
import { randomIds, type IdGenerator } from "./ids.js";
import { EditContext } from "./ops/context.js";
import { finalize, snapshotMain } from "./timeline/finalize.js";
import { validateProject } from "./timeline/validate.js";

enablePatches();

export interface HistoryEntry {
  label: string;
  source: string;
  at: number;
  patches: Patch[];
  inversePatches: Patch[];
}

export interface ChangeSet {
  elementIds: string[];
  trackIds: string[];
}

export interface CommitResult<R> {
  result: R;
  /** Version after the commit (unchanged for no-ops). */
  version: number;
  label: string;
  noop: boolean;
  changed: ChangeSet;
  created: string[];
  removed: string[];
  warnings: string[];
}

export type SessionEventKind = "commit" | "undo" | "redo";

export interface SessionEvent {
  kind: SessionEventKind;
  label: string;
  source: string;
  version: number;
  /** Patches that transform the previous state into the new one. */
  patches: Patch[];
  entry: HistoryEntry;
}

export interface SessionOptions {
  ids?: IdGenerator;
  now?: () => number;
  maxUndo?: number;
  version?: number;
  /** Validate every invariant after each commit (tests / debug). */
  validate?: boolean;
}

export interface TransactOptions {
  expectedVersion?: number;
  /** Skip the timeline solver (for settings that cannot affect layout). */
  skipFinalize?: boolean;
}

function changeSetFrom(patches: Patch[], before: Project, after: Project): ChangeSet {
  const elementIds = new Set<string>();
  const trackIds = new Set<string>();
  for (const p of patches) {
    if (p.path[0] === "elements" && p.path.length >= 2) elementIds.add(String(p.path[1]));
    if (p.path[0] === "tracks") {
      if (p.path.length >= 2) {
        const idx = Number(p.path[1]);
        if (after.tracks[idx]) trackIds.add(after.tracks[idx].id);
        if (before.tracks[idx]) trackIds.add(before.tracks[idx].id);
      } else {
        for (const t of after.tracks) trackIds.add(t.id);
      }
    }
    if (p.path.length === 0) {
      for (const id of Object.keys(after.elements)) elementIds.add(id);
      for (const t of after.tracks) trackIds.add(t.id);
    }
  }
  return { elementIds: [...elementIds], trackIds: [...trackIds] };
}

/** Plain copies of any drafts in a recipe's return value, so it stays readable after the transaction. */
function detach<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (isDraft(value)) return current(value as never) as T;
  if (Array.isArray(value)) return value.map(detach) as T;
  if (Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, detach(v)])) as T;
  return value;
}

/**
 * Live composition with atomic transactions. Every `transact` call is exactly one undo step,
 * no matter how many low-level changes the recipe makes.
 */
export class Session {
  private _state: Project;
  private _version: number;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<(e: SessionEvent) => void>();
  readonly ids: IdGenerator;
  private readonly now: () => number;
  private readonly maxUndo: number;
  private readonly validate: boolean;

  constructor(project: Project, opts: SessionOptions = {}) {
    this._state = project;
    this._version = opts.version ?? 0;
    this.ids = opts.ids ?? randomIds;
    this.now = opts.now ?? Date.now;
    this.maxUndo = opts.maxUndo ?? 300;
    this.validate = opts.validate ?? false;
  }

  get state(): Project {
    return this._state;
  }

  get version(): number {
    return this._version;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  history() {
    const summary = (e: HistoryEntry) => ({ label: e.label, source: e.source, at: e.at });
    return { undo: this.undoStack.map(summary), redo: this.redoStack.map(summary) };
  }

  exportHistory() {
    return { undo: this.undoStack, redo: this.redoStack };
  }

  importHistory(h: { undo: HistoryEntry[]; redo: HistoryEntry[] }) {
    this.undoStack = [...h.undo];
    this.redoStack = [...h.redo];
  }

  onEvent(fn: (e: SessionEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: SessionEvent) {
    for (const fn of this.listeners) fn(e);
  }

  private checkVersion(expected?: number) {
    if (expected !== undefined && expected !== this._version) {
      throw new EditError("VERSION_CONFLICT", `Project changed (version ${this._version}, expected ${expected}); re-read state and retry`, {
        currentVersion: this._version,
        expectedVersion: expected,
      });
    }
  }

  transact<R>(label: string, source: string, recipe: (ctx: EditContext) => R, opts: TransactOptions = {}): CommitResult<R> {
    this.checkVersion(opts.expectedVersion);
    const before = this._state;
    let ctxRef: EditContext | undefined;
    let result!: R;
    const [next, patches, inversePatches] = produceWithPatches(before, (draft) => {
      const ctx = new EditContext(draft, this.ids, this.now());
      ctxRef = ctx;
      const snap = snapshotMain(draft);
      result = recipe(ctx);
      if (!opts.skipFinalize) finalize(ctx, snap);
      // Recipes often return a piece of the draft; drafts are revoked when the transaction ends.
      result = detach(result);
    });
    const ctx = ctxRef!;
    if (patches.length === 0) {
      return { result, version: this._version, label, noop: true, changed: { elementIds: [], trackIds: [] }, created: [], removed: [], warnings: ctx.warnings };
    }
    if (this.validate) {
      const problems = validateProject(next);
      if (problems.length) throw new EditError("INTERNAL", `Invariant violation after "${label}": ${problems.slice(0, 5).join("; ")}`, { problems });
    }
    const entry: HistoryEntry = { label, source, at: this.now(), patches, inversePatches };
    this.commit(next, entry, "commit");
    return {
      result,
      version: this._version,
      label,
      noop: false,
      changed: changeSetFrom(patches, before, next),
      created: ctx.created.filter((id) => next.elements[id]),
      removed: ctx.removed,
      warnings: ctx.warnings,
    };
  }

  /** Replace the whole document as one undoable step (used by revert). */
  replace(label: string, source: string, nextState: Project, opts: { expectedVersion?: number } = {}): CommitResult<void> {
    this.checkVersion(opts.expectedVersion);
    const before = this._state;
    const [next, patches, inversePatches] = produceWithPatches(before, () => nextState);
    if (patches.length === 0) return { result: undefined, version: this._version, label, noop: true, changed: { elementIds: [], trackIds: [] }, created: [], removed: [], warnings: [] };
    const entry: HistoryEntry = { label, source, at: this.now(), patches, inversePatches };
    this.commit(next, entry, "commit");
    return { result: undefined, version: this._version, label, noop: false, changed: changeSetFrom(patches, before, next), created: [], removed: [], warnings: [] };
  }

  private commit(next: Project, entry: HistoryEntry, kind: "commit") {
    this._state = next;
    this._version++;
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxUndo) this.undoStack.splice(0, this.undoStack.length - this.maxUndo);
    this.redoStack = [];
    this.emit({ kind, label: entry.label, source: entry.source, version: this._version, patches: entry.patches, entry });
  }

  undo(source = "unknown", opts: { expectedVersion?: number } = {}): { label: string; version: number; changed: ChangeSet } {
    this.checkVersion(opts.expectedVersion);
    const entry = this.undoStack.pop();
    if (!entry) throw new EditError("NOTHING_TO_UNDO", "Nothing to undo");
    const before = this._state;
    this._state = applyPatches(this._state, entry.inversePatches);
    this._version++;
    this.redoStack.push(entry);
    this.emit({ kind: "undo", label: entry.label, source, version: this._version, patches: entry.inversePatches, entry });
    return { label: entry.label, version: this._version, changed: changeSetFrom(entry.inversePatches, before, this._state) };
  }

  redo(source = "unknown", opts: { expectedVersion?: number } = {}): { label: string; version: number; changed: ChangeSet } {
    this.checkVersion(opts.expectedVersion);
    const entry = this.redoStack.pop();
    if (!entry) throw new EditError("NOTHING_TO_REDO", "Nothing to redo");
    const before = this._state;
    this._state = applyPatches(this._state, entry.patches);
    this._version++;
    this.undoStack.push(entry);
    this.emit({ kind: "redo", label: entry.label, source, version: this._version, patches: entry.patches, entry });
    return { label: entry.label, version: this._version, changed: changeSetFrom(entry.patches, before, this._state) };
  }
}
