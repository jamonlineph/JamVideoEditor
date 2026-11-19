import type { PlannedTool, ToolDef } from "./defineTool.js";
import { discoveryTools } from "./tools/discovery.js";
import { projectTools } from "./tools/project.js";
import { timelineTools } from "./tools/timeline.js";
import { transformTools } from "./tools/transform.js";
import { colorTools } from "./tools/color.js";
import { textTools } from "./tools/text.js";
import { audioTools, exportTools } from "./tools/audio.js";
import { analysisTools } from "./tools/analysis.js";
import { renderTools } from "./tools/render.js";
import { transcriptTools } from "./tools/transcript.js";
import { visionTools } from "./tools/vision.js";
import { uiTools, voiceoverTools } from "./tools/ui.js";
import { editingCacheTools } from "./tools/editingCache.js";
import { thumbnailTools } from "./tools/thumbnails.js";

export const VERSION = "0.1.0";

/** Every registered tool, in a stable order. */
export function allTools(): ToolDef[] {
  return [
    ...discoveryTools, ...projectTools, ...timelineTools, ...transformTools, ...colorTools, ...textTools, ...transcriptTools, ...visionTools, ...audioTools, ...analysisTools, ...exportTools, ...renderTools, ...uiTools, ...voiceoverTools,
    ...thumbnailTools,
    ...editingCacheTools,
  ] as unknown as ToolDef[];
}

const p = (name: string, phase: 3 | 4 | 5, category: string, summary: string): PlannedTool => ({ name, phase, category, summary });

/** Tools from the spec that land in later phases (not registered yet). */
export const PLANNED_TOOLS: PlannedTool[] = [
];
