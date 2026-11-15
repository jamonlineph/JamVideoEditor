import { z } from "zod";
import {
  AspectRatioSchema,
  EditError,
  FpsSchema,
  ResolutionSchema,
  SCHEMA_VERSION,
  TOOL_PANELS,
  RENDER_SUPPORT,
  canvasPixelSize,
  compositionDuration,
  evaluateProperty,
  getCatalogItem,
  keyframeableProperties,
  listCatalog,
  listCatalogKinds,
  mainTrack,
  requireCatalogKind,
  setCanvas,
  setRippleTiers,
  setTrackFlags,
  gainToDb,
} from "@openedits/core";
import { defineTool } from "../defineTool.js";
import { allTools, PLANNED_TOOLS, VERSION } from "../registry.js";
import { element, expectedVersion, hexColor, inRange, mutate, pageInput, paginate, projectSummary, rangeInput, round, summarize } from "./common.js";

export const CONVENTIONS = {
  time: "Timeline positions/durations are float seconds (0 = start). Source timestamps end in *SourceSeconds.",
  canvas: "Normalized coordinates 0..1, origin top-left, +x right, +y down. Element (x, y) is the center of its bounding box.",
  scale: "Media elements: scale multiplies the baseline fit (cover or contain) of the canvas. Shapes: widthNorm/heightNorm are fractions of canvas width/height.",
  rotation: "Degrees clockwise.",
  colors: "#RRGGBB or #RRGGBBAA.",
  volume: "Linear gain 0..10 (0 = mute, 1 = 0 dB, 10 = +20 dB). setSound also accepts volumeDb.",
  undo: "Every mutating tool call is exactly one undo step. saveRevision/revert manage numbered snapshots.",
  concurrency: "Mutations accept expectedVersion; on mismatch they fail with VERSION_CONFLICT.",
  keyframes: "Keyframe offsets are seconds from the element start (they move with the clip). Tools also accept timeline `time`.",
};

export const discoveryTools = [
  defineTool({
    name: "getCapabilities",
    title: "Get capabilities",
    category: "discovery",
    description: "Describe the app: coordinate conventions, implemented tools by category, tools planned for later phases, and catalog kinds. Call this first.",
    input: z.object({}),
    readOnly: true,
    handler: (_args, ctx) => {
      const tools = allTools();
      const byCategory: Record<string, string[]> = {};
      for (const t of tools) (byCategory[t.category] ??= []).push(t.name);
      return {
        app: "OpenEdits Studio",
        version: VERSION,
        schemaVersion: SCHEMA_VERSION,
        conventions: CONVENTIONS,
        toolCount: tools.length,
        tools: byCategory,
        planned: PLANNED_TOOLS,
        rendering: RENDER_SUPPORT,
        catalogKinds: listCatalogKinds().map((k) => ({ kind: k.kind, count: k.count })),
        workspace: { root: ctx.host.paths.root, inbox: ctx.host.paths.inbox, autoEdit: ctx.host.paths.autoEdit, styleGuide: ctx.host.paths.styleGuideFile },
        openProject: projectSummary(ctx),
      };
    },
  }),
  defineTool({
    name: "appState",
    title: "App state",
    category: "discovery",
    description: "Current screen (home/editor/loading), open project summary with version, selection, playhead and active inspector tool.",
    input: z.object({}),
    readOnly: true,
    handler: (_a, ctx) => ({ ...ctx.host.appState, project: projectSummary(ctx) }),
  }),
  defineTool({
    name: "setSelection",
    title: "Set selection",
    category: "discovery",
    description: "Select elements (shared with the UI). Tools that take an optional elementId act on the first selected element.",
    input: z.object({ elementIds: z.array(z.string()) }),
    handler: (a, ctx) => {
      for (const id of a.elementIds) if (!ctx.host.project.elements[id]) throw new EditError("ELEMENT_NOT_FOUND", `No element with id "${id}"`);
      return ctx.host.setAppState({ selection: { elementIds: a.elementIds } });
    },
  }),
  defineTool({
    name: "setPlayhead",
    title: "Set playhead",
    category: "discovery",
    description: "Move the shared playhead (timeline seconds).",
    input: z.object({ seconds: z.number().min(0) }),
    handler: (a, ctx) => {
      ctx.host.project;
      return ctx.host.setAppState({ playheadSeconds: a.seconds });
    },
  }),
  defineTool({
    name: "state",
    title: "Project state",
    category: "discovery",
    description: "The full project document (canvas, tracks, elements, media, transitions, markers, settings) with its version. Use `omit` to drop large sections.",
    input: z.object({ omit: z.array(z.enum(["elements", "media", "tracks", "transitions", "beatMarkers", "teleprompter", "exportSettings"])).optional() }),
    readOnly: true,
    handler: (a, ctx) => {
      const p = { ...ctx.host.project } as Record<string, unknown>;
      for (const k of a.omit ?? []) delete p[k];
      return { version: ctx.host.session.version, project: p };
    },
  }),
  defineTool({
    name: "getCanvas",
    title: "Get canvas",
    category: "discovery",
    description: "Canvas aspect ratio, resolution, fps, background and derived pixel size.",
    input: z.object({}),
    readOnly: true,
    handler: (_a, ctx) => {
      const c = ctx.host.project.canvas;
      return { ...c, pixelSize: canvasPixelSize(c), durationSeconds: round(compositionDuration(ctx.host.project)) };
    },
  }),
  defineTool({
    name: "setCanvas",
    title: "Set canvas",
    category: "discovery",
    description: "Change aspect ratio (9:16, 16:9, 1:1, 4:5), resolution (720p/1080p/4K), fps or background. Normalized element positions are preserved.",
    input: z.object({
      aspectRatio: AspectRatioSchema.optional(),
      resolution: ResolutionSchema.optional(),
      fps: FpsSchema.optional(),
      backgroundColor: hexColor.optional(),
      expectedVersion,
    }),
    handler: ({ expectedVersion: ev, ...patch }, ctx) => mutate(ctx, "Change canvas", (c) => setCanvas(c, patch), { expectedVersion: ev }, () => ({ canvas: ctx.host.project.canvas, pixelSize: canvasPixelSize(ctx.host.project.canvas) })),
  }),
  defineTool({
    name: "rippleState",
    title: "Ripple state",
    category: "discovery",
    description: "Magnet, snapping and the two ripple tiers. Tier 1: overlays follow the main clip they start on. Tier 2: unanchored overlays downstream of a main-track edit shift too.",
    input: z.object({}),
    readOnly: true,
    handler: (_a, ctx) => ctx.host.project.rippleSettings,
  }),
  defineTool({
    name: "setRippleTiers",
    title: "Set ripple tiers",
    category: "discovery",
    description: "Toggle magnetEnabled (gapless main track), snappingEnabled, tier1RippleEnabled and tier2RippleEnabled.",
    input: z.object({
      magnetEnabled: z.boolean().optional(),
      snappingEnabled: z.boolean().optional(),
      tier1RippleEnabled: z.boolean().optional(),
      tier2RippleEnabled: z.boolean().optional(),
      expectedVersion,
    }),
    handler: ({ expectedVersion: ev, ...patch }, ctx) => mutate(ctx, "Change ripple settings", (c) => setRippleTiers(c, patch), { expectedVersion: ev }, () => ({ rippleSettings: ctx.host.project.rippleSettings })),
  }),
  defineTool({
    name: "tracks",
    title: "List tracks",
    category: "discovery",
    description: "All tracks in stacking order (index 0 = main track; visual lanes bottom to top, then audio lanes).",
    input: z.object({}),
    readOnly: true,
    handler: (_a, ctx) => ({
      tracks: ctx.host.project.tracks.map((t, index) => {
        const els = t.elementIds.map((id) => ctx.host.project.elements[id]);
        return {
          index,
          id: t.id,
          kind: t.kind,
          behavior: t.behavior,
          name: t.name,
          locked: t.locked,
          hidden: t.hidden,
          muted: t.muted,
          elementCount: t.elementIds.length,
          endSeconds: round(Math.max(0, ...els.map((e) => e.start + e.duration))),
        };
      }),
    }),
  }),
  defineTool({
    name: "setTrackFlags",
    title: "Set track flags",
    category: "discovery",
    description: "Lock, hide, mute or rename a track.",
    input: z.object({ trackId: z.string(), locked: z.boolean().optional(), hidden: z.boolean().optional(), muted: z.boolean().optional(), name: z.string().optional(), expectedVersion }),
    handler: ({ trackId, expectedVersion: ev, ...flags }, ctx) => mutate(ctx, "Change track", (c) => setTrackFlags(c, trackId, flags), { expectedVersion: ev, skipFinalize: true }),
  }),
  defineTool({
    name: "clips",
    title: "Main-track clips",
    category: "discovery",
    description: "Clips on the magnetic main track in playback order, with index, timing and source window.",
    input: z.object({ ...rangeInput, ...pageInput }),
    readOnly: true,
    handler: (a, ctx) => {
      const p = ctx.host.project;
      const items = mainTrack(p)
        .elementIds.map((id, index) => ({ index, ...summarize(p, p.elements[id]) }) as Record<string, unknown>)
        .filter((c) => inRange({ start: Number(c.start), duration: Number(c.duration) }, a.from, a.to));
      return paginate(items, a.offset, a.limit);
    },
  }),
  defineTool({
    name: "elements",
    title: "List elements",
    category: "discovery",
    description: "Elements on any track, filtered by track, type and time range.",
    input: z.object({
      trackId: z.string().optional(),
      type: z.enum(["video", "image", "audio", "text", "caption", "shape", "sticker", "adjustment"]).optional(),
      ...rangeInput,
      ...pageInput,
    }),
    readOnly: true,
    handler: (a, ctx) => {
      const p = ctx.host.project;
      const items = p.tracks
        .flatMap((t) => t.elementIds.map((id) => p.elements[id]))
        .filter((el) => (!a.trackId || el.trackId === a.trackId) && (!a.type || el.type === a.type) && inRange(el, a.from, a.to))
        .map((el) => summarize(p, el));
      return paginate(items, a.offset, a.limit);
    },
  }),
  defineTool({
    name: "getElement",
    title: "Get element",
    category: "discovery",
    description: "Full element record plus its media asset; with `time`, also every animatable property evaluated at that timeline time.",
    input: z.object({ elementId: z.string().optional(), time: z.number().min(0).optional() }),
    readOnly: true,
    handler: (a, ctx) => {
      const el = element(ctx, a.elementId);
      const p = ctx.host.project;
      const media = "mediaId" in el ? p.media[el.mediaId] : undefined;
      const evaluated = a.time !== undefined ? Object.fromEntries(keyframeableProperties(el).map((prop) => [prop, round(evaluateProperty(el, prop, a.time!))])) : undefined;
      return {
        element: el,
        ...(media ? { media } : {}),
        ...("volume" in el ? { volumeDb: round(gainToDb(el.volume), 3) } : {}),
        ...(evaluated ? { evaluatedAt: a.time, evaluated } : {}),
      };
    },
  }),
  defineTool({
    name: "listCatalogKinds",
    title: "List catalog kinds",
    category: "discovery",
    description: "Kinds of built-in catalog items (text presets, caption styles, filters, LUTs, effects, transitions, stickers, tool panels...).",
    input: z.object({}),
    readOnly: true,
    handler: () => ({ kinds: listCatalogKinds() }),
  }),
  defineTool({
    name: "listCatalog",
    title: "List catalog",
    category: "discovery",
    description: "Items of one catalog kind, with optional search and category filter.",
    input: z.object({ kind: z.string(), query: z.string().optional(), category: z.string().optional(), includeData: z.boolean().optional(), ...pageInput }),
    readOnly: true,
    handler: (a) => listCatalog(requireCatalogKind(a.kind), a),
  }),
  defineTool({
    name: "getCatalogItem",
    title: "Get catalog item",
    category: "discovery",
    description: "Full definition of one catalog item.",
    input: z.object({ kind: z.string(), id: z.string() }),
    readOnly: true,
    handler: (a) => getCatalogItem(requireCatalogKind(a.kind), a.id),
  }),
  defineTool({
    name: "tools",
    title: "Inspector tools",
    category: "discovery",
    description: "Inspector tool panels that apply to the selected (or given) element, and which MCP tools back each panel.",
    input: z.object({ elementId: z.string().optional() }),
    readOnly: true,
    handler: (a, ctx) => {
      const id = a.elementId ?? ctx.host.appState.selection.elementIds[0];
      const el = id ? ctx.host.project.elements[id] : undefined;
      if (id && !el) throw new EditError("ELEMENT_NOT_FOUND", `No element with id "${id}"`);
      const panels = TOOL_PANELS.filter((p) => !el || p.data.appliesTo.includes(el.type)).map((p) => ({ id: p.id, name: p.name, category: p.category, mcpTools: p.data.mcpTools }));
      return { elementId: el?.id ?? null, elementType: el?.type ?? null, activeTool: ctx.host.appState.activeTool, panels };
    },
  }),
  defineTool({
    name: "selectTool",
    title: "Select inspector tool",
    category: "discovery",
    description: "Open an inspector panel (shared with the UI). Optionally selects elementId first. Pass toolId null to close the inspector panel.",
    input: z.object({ toolId: z.string().nullable(), elementId: z.string().optional() }),
    handler: (a, ctx) => {
      if (a.elementId) {
        if (!ctx.host.project.elements[a.elementId]) throw new EditError("ELEMENT_NOT_FOUND", `No element with id "${a.elementId}"`);
        ctx.host.setAppState({ selection: { elementIds: [a.elementId] } });
      }
      if (a.toolId === null) return ctx.host.setAppState({ activeTool: null });
      const panel = TOOL_PANELS.find((p) => p.id === a.toolId);
      if (!panel) throw new EditError("CATALOG_ITEM_NOT_FOUND", `Unknown tool panel "${a.toolId}"`, { panels: TOOL_PANELS.map((p) => p.id) });
      const sel = ctx.host.appState.selection.elementIds[0];
      const el = sel ? ctx.host.project.elements[sel] : undefined;
      if (el && !panel.data.appliesTo.includes(el.type)) throw new EditError("INVALID_ARGUMENT", `Panel "${panel.id}" does not apply to ${el.type} elements`, { appliesTo: panel.data.appliesTo });
      return ctx.host.setAppState({ activeTool: panel.id });
    },
  }),
];
