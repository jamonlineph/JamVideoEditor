import type { z } from "zod";
import type { EngineHost } from "@openedits/engine";

export type ToolCategory = "discovery" | "project" | "timeline" | "transform" | "color" | "text" | "audio" | "export";

export interface ToolContext {
  host: EngineHost;
  /** Who is calling: `mcp:<client>`, `cli`, `ui`... recorded in undo history. */
  source: string;
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  category: ToolCategory;
  description: string;
  input: S;
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  handler: (args: z.infer<S>, ctx: ToolContext) => unknown | Promise<unknown>;
}

export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/** Tools specified for later phases; reported by getCapabilities but not registered yet. */
export interface PlannedTool {
  name: string;
  phase: 3 | 4 | 5;
  category: string;
  summary: string;
}

/** Tools attach images for the agent to look at under this key; they are sent as image content, not JSON. */
export const IMAGES_KEY = "_images";

export interface ToolImage {
  path: string;
  mimeType: string;
}
