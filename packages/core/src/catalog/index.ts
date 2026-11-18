import { EditError } from "../errors.js";
import { SPEED_CURVE_PRESETS } from "../speed.js";
import { CAPTION_STYLES, FONTS, TEXT_ANIMATIONS, TEXT_PRESETS } from "./text.js";
import {
  ADJUST_PRESETS,
  BEAT_DENSITIES,
  BLEND_MODES,
  CLIP_ANIMATIONS,
  EFFECTS_CATALOG,
  FILTERS_CATALOG,
  LUTS_CATALOG,
  MASK_TYPES_CATALOG,
  SHAPES_CATALOG,
  SPLIT_SCREEN_LAYOUTS,
  STICKERS_CATALOG,
  TOOL_PANELS,
  TRANSITIONS_CATALOG,
} from "./visual.js";
import type { CatalogItem } from "./types.js";

export * from "./types.js";
export * from "./text.js";
export * from "./visual.js";

const SPEED_PRESETS_CATALOG: CatalogItem<{ points: { position: number; rate: number }[] }>[] = Object.entries(SPEED_CURVE_PRESETS).map(([id, p]) => ({
  id,
  name: p.name,
  category: "speed",
  description: p.description,
  data: { points: p.points },
}));

export const CATALOG = {
  textPresets: { description: "Text style presets (applyTextPreset)", items: TEXT_PRESETS },
  captionStyles: { description: "Animated caption styles (setCaptionStyle)", items: CAPTION_STYLES },
  textAnimations: { description: "Text in/out/loop animations (setTextAnimation)", items: TEXT_ANIMATIONS },
  clipAnimations: { description: "Video, photo, sticker and shape in/out/combo animations (setClipAnimation; combo is the loop slot)", items: CLIP_ANIMATIONS },
  fonts: { description: "Built-in font families (setTextFont)", items: FONTS },
  filters: { description: "Color filter looks (applyFilter)", items: FILTERS_CATALOG },
  adjustPresets: { description: "One-tap adjust presets (setColorGrade preset)", items: ADJUST_PRESETS },
  luts: { description: "Camera log to Rec.709 LUTs (applyLUT)", items: LUTS_CATALOG },
  effects: { description: "Video effects (applyEffect)", items: EFFECTS_CATALOG },
  transitions: { description: "Main-track transitions (addTransition)", items: TRANSITIONS_CATALOG },
  stickers: { description: "Vector stickers (addSticker)", items: STICKERS_CATALOG },
  shapes: { description: "Shapes and scrims (addShape)", items: SHAPES_CATALOG },
  maskTypes: { description: "Parametric mask types (setMask)", items: MASK_TYPES_CATALOG },
  splitScreenLayouts: { description: "Split screen layouts (splitScreen)", items: SPLIT_SCREEN_LAYOUTS },
  speedPresets: { description: "Speed ramp presets (setSpeedCurve)", items: SPEED_PRESETS_CATALOG },
  beatDensities: { description: "Beat marker densities (setBeatDensity)", items: BEAT_DENSITIES },
  blendModes: { description: "Layer blend modes", items: BLEND_MODES },
  toolPanels: { description: "Inspector tool panels (tools / selectTool)", items: TOOL_PANELS },
} as const;

export type CatalogKind = keyof typeof CATALOG;
export const CATALOG_KINDS = Object.keys(CATALOG) as CatalogKind[];

export function listCatalogKinds() {
  return CATALOG_KINDS.map((kind) => ({
    kind,
    description: CATALOG[kind].description,
    count: CATALOG[kind].items.length,
    categories: [...new Set((CATALOG[kind].items as CatalogItem<unknown>[]).map((i) => i.category))],
  }));
}

export function requireCatalogKind(kind: string): CatalogKind {
  if (!(CATALOG_KINDS as string[]).includes(kind)) throw new EditError("INVALID_ARGUMENT", `Unknown catalog kind "${kind}"`, { kinds: CATALOG_KINDS });
  return kind as CatalogKind;
}

export function findCatalogItem(kind: CatalogKind, id: string): CatalogItem<unknown> | undefined {
  return (CATALOG[kind].items as CatalogItem<unknown>[]).find((i) => i.id === id);
}

export function getCatalogItem(kind: CatalogKind, id: string): CatalogItem<unknown> {
  const item = findCatalogItem(kind, id);
  if (!item) {
    const ids = (CATALOG[kind].items as CatalogItem<unknown>[]).map((i) => i.id);
    throw new EditError("CATALOG_ITEM_NOT_FOUND", `No ${kind} item "${id}"`, { kind, available: ids.slice(0, 60) });
  }
  return item;
}

/** Validates an id against a catalog kind (throws CATALOG_ITEM_NOT_FOUND). */
export function assertCatalogId(kind: CatalogKind, id: string) {
  getCatalogItem(kind, id);
}

export function listCatalog(kind: CatalogKind, opts: { query?: string; category?: string; offset?: number; limit?: number; includeData?: boolean } = {}) {
  const q = opts.query?.toLowerCase();
  let items = (CATALOG[kind].items as CatalogItem<unknown>[]).filter((i) => {
    if (opts.category && i.category !== opts.category) return false;
    if (q && !`${i.id} ${i.name} ${i.category} ${i.description ?? ""}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const total = items.length;
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 100;
  items = items.slice(offset, offset + limit);
  return {
    kind,
    total,
    offset,
    nextOffset: offset + items.length < total ? offset + items.length : null,
    items: items.map((i) => (opts.includeData ? i : { id: i.id, name: i.name, category: i.category, ...(i.description ? { description: i.description } : {}) })),
  };
}
