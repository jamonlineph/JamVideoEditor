import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AspectRatioSchema, EditError, FpsSchema, ResolutionSchema, addMediaToTimeline, compositionDuration, mainTrack, setBrief } from "@openedits/core";
import { AutopilotWatcher, expandHome, listAutopilotJobs, transcriptionAvailable } from "@openedits/engine";
import { defineTool, type ToolContext } from "../defineTool.js";
import { expectedVersion, mutate, projectSummary, round, summarize, summarizeProject } from "./common.js";

const canvasInput = z
  .object({ aspectRatio: AspectRatioSchema.optional(), resolution: ResolutionSchema.optional(), fps: FpsSchema.optional() })
  .optional();

function projectRow(ctx: ToolContext, id: string) {
  const row = ctx.host.requireProjectRow(id);
  return { ...row, isOpen: ctx.host.appState.openProjectId === id };
}

/** Resolve inbox file names (or absolute/relative paths) to absolute paths. */
function resolveFiles(ctx: ToolContext, files: string[]): string[] {
  return files.map((f) => {
    const expanded = expandHome(f);
    if (path.isAbsolute(expanded)) return expanded;
    const inInbox = path.join(ctx.host.paths.inbox, expanded);
    return fs.existsSync(inInbox) ? inInbox : path.resolve(expanded);
  });
}

export const projectTools = [
  defineTool({
    name: "projectTemplates",
    title: "List project templates",
    category: "project",
    description: "List built-in and saved creator templates.",
    input: z.object({}),
    readOnly: true,
    handler: (_a, ctx) => ({ templates: ctx.host.listTemplates() }),
  }),
  defineTool({
    name: "saveProjectTemplate",
    title: "Save as template",
    category: "project",
    description: "Save titles, brand overlays, music, caption style and export settings from the open edit as a reusable local template.",
    input: z.object({ name: z.string().trim().min(1).max(80) }),
    handler: (a, ctx) => ({ template: ctx.host.saveTemplate(a.name) }),
  }),
  defineTool({
    name: "newProjectFromTemplate",
    title: "Use project template",
    category: "project",
    description: "Start a new project from a listed template, ready to add new footage.",
    input: z.object({ templateId: z.string(), name: z.string().trim().min(1).max(80).optional() }),
    handler: (a, ctx) => ({ projectId: ctx.host.startFromTemplate(a.templateId, a.name, ctx.source) }),
  }),
  defineTool({
    name: "backupProject",
    title: "Save project backup",
    category: "project",
    description: "Save the current edit to a new folder inside destination. collectMedia copies the source files beside the project manifest.",
    input: z.object({ destination: z.string().min(1), collectMedia: z.boolean().default(true), projectId: z.string().optional() }),
    handler: async (a, ctx) => {
      if (a.projectId !== undefined && a.projectId !== ctx.host.projectId) throw new EditError("VERSION_CONFLICT", "The open project changed while choosing a backup location.");
      return { path: await ctx.host.backupProject(a.destination, a.collectMedia) };
    },
  }),
  defineTool({
    name: "openProjectBackup",
    title: "Open project backup",
    category: "project",
    description: "Open a backup manifest as a new project without replacing an existing project.",
    input: z.object({ path: z.string().min(1) }),
    handler: (a, ctx) => ({ projectId: ctx.host.openProjectBackup(a.path) }),
  }),
  defineTool({
    name: "projectTrash",
    title: "List trashed projects",
    category: "project",
    description: "List projects that can be restored from workspace Trash.",
    input: z.object({}),
    readOnly: true,
    handler: (_a, ctx) => ({ projects: ctx.host.listTrash() }),
  }),
  defineTool({
    name: "restoreProject",
    title: "Restore from Trash",
    category: "project",
    description: "Restore a project listed by projectTrash to the project library.",
    input: z.object({ entry: z.string() }),
    handler: (a, ctx) => ({ project: ctx.host.restoreTrash(a.entry) }),
  }),
  defineTool({
    name: "projects",
    title: "List projects",
    category: "project",
    description: "Projects in the library (pinned first), with filter, sort and search.",
    input: z.object({
      filter: z.enum(["all", "pinned", "favorites"]).optional(),
      sort: z.enum(["updated", "created", "name", "opened"]).optional(),
      query: z.string().optional(),
    }),
    readOnly: true,
    handler: (a, ctx) => ({ openProjectId: ctx.host.appState.openProjectId, projects: ctx.host.listProjects(a) }),
  }),
  defineTool({
    name: "newProject",
    title: "New project",
    category: "project",
    description: "Create a project and open it in the editor. Defaults: 9:16, 1080p, 30 fps.",
    input: z.object({ name: z.string().optional(), canvas: canvasInput }),
    handler: (a, ctx) => {
      const p = ctx.host.newProject({ name: a.name, canvas: a.canvas });
      return { ok: true, projectId: p.id, project: projectSummary(ctx) };
    },
  }),
  defineTool({
    name: "openProject",
    title: "Open project",
    category: "project",
    description: "Open a project in the editor (closing the current one).",
    input: z.object({ projectId: z.string() }),
    handler: (a, ctx) => {
      ctx.host.openProject(a.projectId);
      return { ok: true, project: projectSummary(ctx) };
    },
  }),
  defineTool({
    name: "saveProject",
    title: "Save project",
    category: "project",
    description: "Flush the open project to disk (edits autosave anyway). With revisionLabel, also records a numbered revision.",
    input: z.object({ revisionLabel: z.string().optional() }),
    handler: (a, ctx) => ({ ok: true, ...ctx.host.saveProject({ revisionLabel: a.revisionLabel, source: ctx.source }) }),
  }),
  defineTool({
    name: "closeProject",
    title: "Close project",
    category: "project",
    description: "Save and close the open project, returning to the home screen.",
    input: z.object({}),
    handler: (_a, ctx) => ({ ok: true, closedProjectId: ctx.host.closeProject() }),
  }),
  defineTool({
    name: "renameProject",
    title: "Rename project",
    category: "project",
    description: "Rename a project.",
    input: z.object({ projectId: z.string(), name: z.string().min(1) }),
    handler: (a, ctx) => ({ ok: true, project: ctx.host.renameProject(a.projectId, a.name) }),
  }),
  defineTool({
    name: "togglePin",
    title: "Toggle pin",
    category: "project",
    description: "Pin or unpin a project on the home screen.",
    input: z.object({ projectId: z.string() }),
    handler: (a, ctx) => ({ ok: true, pinned: ctx.host.togglePin(a.projectId), project: projectRow(ctx, a.projectId) }),
  }),
  defineTool({
    name: "toggleFavorite",
    title: "Toggle favorite",
    category: "project",
    description: "Mark or unmark a project as favorite.",
    input: z.object({ projectId: z.string() }),
    handler: (a, ctx) => ({ ok: true, favorite: ctx.host.toggleFavorite(a.projectId), project: projectRow(ctx, a.projectId) }),
  }),
  defineTool({
    name: "deleteProject",
    title: "Delete project",
    category: "project",
    description: "Remove a project from the library. Its folder is moved to the workspace .trash folder (recoverable), not erased.",
    input: z.object({ projectId: z.string() }),
    destructive: true,
    handler: (a, ctx) => ({ ok: true, ...ctx.host.deleteProject(a.projectId) }),
  }),
  defineTool({
    name: "undo",
    title: "Undo",
    category: "project",
    description: "Undo the last edit (each tool call is one step). Works for edits made in the UI too.",
    input: z.object({ expectedVersion }),
    handler: (a, ctx) => ({ ok: true, ...ctx.host.undo(ctx.source, a.expectedVersion) }),
  }),
  defineTool({
    name: "redo",
    title: "Redo",
    category: "project",
    description: "Redo the last undone edit.",
    input: z.object({ expectedVersion }),
    handler: (a, ctx) => ({ ok: true, ...ctx.host.redo(ctx.source, a.expectedVersion) }),
  }),
  defineTool({
    name: "saveRevision",
    title: "Save revision",
    category: "project",
    description: "Snapshot the whole project as a numbered revision (e.g. before trying a rough-cut pass).",
    input: z.object({ label: z.string().min(1) }),
    handler: (a, ctx) => ({ ok: true, revision: ctx.host.saveRevision(a.label, ctx.source) }),
  }),
  defineTool({
    name: "revisions",
    title: "List revisions",
    category: "project",
    description: "Numbered revisions of the open project.",
    input: z.object({}),
    readOnly: true,
    handler: (_a, ctx) => ({ revisions: ctx.host.listRevisions() }),
  }),
  defineTool({
    name: "revert",
    title: "Revert to revision",
    category: "project",
    description: "Restore a numbered revision. The current state is saved as a new revision first, and the revert itself is one undo step.",
    input: z.object({ revision: z.number().int().positive(), expectedVersion }),
    destructive: true,
    handler: (a, ctx) => {
      const r = ctx.host.revert(a.revision, ctx.source, a.expectedVersion);
      return { ok: true, version: r.version, undoLabel: r.label, backupRevision: r.backupRevision, project: projectSummary(ctx) };
    },
  }),
  defineTool({
    name: "setBrief",
    title: "Set brief",
    category: "project",
    description: "Record the creator's brief / what you learned about the video's purpose.",
    input: z.object({ brief: z.string(), expectedVersion }),
    handler: (a, ctx) => mutate(ctx, "Update brief", (c) => setBrief(c, a.brief), { expectedVersion: a.expectedVersion, skipFinalize: true }),
  }),
  // ------------------------------------------------------------ OpenCut-style workflow tools
  defineTool({
    name: "list_inbox",
    title: "List inbox",
    category: "project",
    description: "Media files dropped in the inbox watch folder (the workspace inbox folder). With probe, includes duration, size and codecs.",
    input: z.object({ probe: z.boolean().optional() }),
    readOnly: true,
    handler: async (a, ctx) => ({ inbox: ctx.host.paths.inbox, files: await ctx.host.listInbox({ probe: a.probe }) }),
  }),
  defineTool({
    name: "create_project",
    title: "Create project from files",
    category: "project",
    description: "Create and open a project from inbox file names or paths: imports the files, places videos/images on the main track in order and audio on a music lane.",
    input: z.object({ name: z.string().optional(), files: z.array(z.string()).min(1), canvas: canvasInput, brief: z.string().optional() }),
    handler: async (a, ctx) => {
      const files = resolveFiles(ctx, a.files);
      for (const f of files) if (!fs.existsSync(f)) throw new EditError("FILE_NOT_FOUND", `File not found: ${f}`, { path: f });
      const p = ctx.host.newProject({ name: a.name ?? path.parse(files[0]).name, canvas: a.canvas });
      const imported = await ctx.host.importMedia(files, { source: ctx.source });
      if (ctx.host.appState.openProjectId !== p.id) throw new EditError("INVALID_ARGUMENT", "The project changed before the imported media could be placed on the timeline.");
      const res = mutate(ctx, "Add files to timeline", (c) => {
        for (const asset of imported.assets) addMediaToTimeline(c, c.draft.media[asset.id], {});
        if (a.brief) setBrief(c, a.brief);
      });
      const hdr = imported.assets.some((media) => media.colorTransfer === "smpte2084" || media.colorTransfer === "arib-std-b67");
      const warnings = [...(res.warnings ?? []), ...(hdr ? ["HDR footage will export as SDR without tone mapping. Colors may look different."] : [])];
      return { ...res, ...(warnings.length ? { warnings } : {}), projectId: p.id, mediaIds: imported.assets.map((m) => m.id), project: projectSummary(ctx) };
    },
  }),
  defineTool({
    name: "get_project",
    title: "Get project overview",
    category: "project",
    description: "Overview of the open project (or projectId): brief, duration, main-track clips, media, revisions, and analysis status. Inspecting another project leaves the active editor session unchanged.",
    input: z.object({ projectId: z.string().optional() }),
    readOnly: true,
    handler: async (a, ctx) => {
      const overview = ctx.host.readProjectOverview(a.projectId);
      const p = overview.project;
      const media = Object.values(p.media);
      const transcribed = new Set(overview.transcribedMediaIds);
      const audioMedia = media.filter((asset) => asset.hasAudio);
      return {
        project: summarizeProject(p, overview),
        brief: p.brief,
        durationSeconds: round(compositionDuration(p)),
        clips: mainTrack(p).elementIds.map((id, index) => ({ index, ...summarize(p, p.elements[id]) })),
        media: media.map((m) => ({ id: m.id, name: m.name, kind: m.kind, durationSourceSeconds: m.durationSourceSeconds, width: m.width, height: m.height })),
        revisions: overview.revisions,
        analysis: {
          transcripts: {
            available: await transcriptionAvailable(ctx.host.settings.whisperModelPath),
            transcribedMediaIds: audioMedia.filter((asset) => transcribed.has(asset.id)).map((asset) => asset.id),
            missingMediaIds: audioMedia.filter((asset) => !transcribed.has(asset.id)).map((asset) => asset.id),
          },
          silences: "use findPauses",
          loudness: "use loudness",
        },
      };
    },
  }),
  defineTool({
    name: "get_style_guide",
    title: "Get style guide",
    category: "project",
    description: "The creator's editing rules (STYLE.md). Read and follow them before editing.",
    input: z.object({}),
    readOnly: true,
    handler: (_a, ctx) => ({ path: ctx.host.paths.styleGuideFile, markdown: ctx.host.getStyleGuide() }),
  }),
  defineTool({
    name: "save_style_guide",
    title: "Save style guide",
    category: "project",
    description: "Replace STYLE.md with new markdown (e.g. to record a rule the creator asked for).",
    input: z.object({ markdown: z.string().min(1) }),
    handler: (a, ctx) => {
      ctx.host.saveStyleGuide(a.markdown);
      return { ok: true, path: ctx.host.paths.styleGuideFile, bytes: Buffer.byteLength(a.markdown) };
    },
  }),
  defineTool({
    name: "list_autopilot_jobs",
    title: "List autopilot jobs",
    category: "project",
    description: "Hands-free jobs: videos dropped in the workspace auto-edit folder become projects with the STYLE.md first pass applied and a final render in the outbox (run `openedits autopilot` or `openedits serve --autopilot` to watch the folder). Shows recent jobs and files still waiting.",
    input: z.object({ limit: z.number().int().min(1).max(200).optional() }),
    readOnly: true,
    handler: (a, ctx) => ({
      folder: ctx.host.paths.autoEdit,
      waiting: new AutopilotWatcher({ workspaceRoot: ctx.host.paths.root }).pending(),
      jobs: listAutopilotJobs(ctx.host.paths, a.limit ?? 20),
    }),
  }),
];
