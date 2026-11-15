export type Action =
  | "playPause"
  | "split"
  | "delete"
  | "undo"
  | "redo"
  | "stepBack"
  | "stepForward"
  | "prevEdit"
  | "nextEdit"
  | "duplicate"
  | "zoomIn"
  | "zoomOut"
  | "toggleSnapping"
  | "toggleMagnet"
  | "goToStart"
  | "goToEnd";

export type ShortcutMapId = "edits" | "capcut" | "premiere" | "finalcut" | "resolve";

/** Keys are written as modifiers + key, e.g. "Meta+Shift+z", "Space", "ArrowLeft". */
export const SHORTCUT_MAPS: Record<ShortcutMapId, { name: string; keys: Record<Action, string> }> = {
  edits: {
    name: "Edits (default)",
    keys: { playPause: "Space", split: "s", delete: "Backspace", undo: "Meta+z", redo: "Meta+Shift+z", stepBack: "ArrowLeft", stepForward: "ArrowRight", prevEdit: "ArrowUp", nextEdit: "ArrowDown", duplicate: "Meta+d", zoomIn: "Meta+=", zoomOut: "Meta+-", toggleSnapping: "n", toggleMagnet: "m", goToStart: "Home", goToEnd: "End" },
  },
  capcut: {
    name: "CapCut",
    keys: { playPause: "Space", split: "Meta+b", delete: "Backspace", undo: "Meta+z", redo: "Meta+Shift+z", stepBack: "ArrowLeft", stepForward: "ArrowRight", prevEdit: "ArrowUp", nextEdit: "ArrowDown", duplicate: "Meta+d", zoomIn: "Meta+=", zoomOut: "Meta+-", toggleSnapping: "n", toggleMagnet: "p", goToStart: "Home", goToEnd: "End" },
  },
  premiere: {
    name: "Premiere Pro",
    keys: { playPause: "Space", split: "Meta+k", delete: "Shift+Delete", undo: "Meta+z", redo: "Meta+Shift+z", stepBack: "ArrowLeft", stepForward: "ArrowRight", prevEdit: "ArrowUp", nextEdit: "ArrowDown", duplicate: "Meta+d", zoomIn: "=", zoomOut: "-", toggleSnapping: "s", toggleMagnet: "Meta+Shift+m", goToStart: "Home", goToEnd: "End" },
  },
  finalcut: {
    name: "Final Cut Pro",
    keys: { playPause: "Space", split: "Meta+b", delete: "Backspace", undo: "Meta+z", redo: "Meta+Shift+z", stepBack: "ArrowLeft", stepForward: "ArrowRight", prevEdit: "ArrowUp", nextEdit: "ArrowDown", duplicate: "Meta+d", zoomIn: "Meta+=", zoomOut: "Meta+-", toggleSnapping: "n", toggleMagnet: "p", goToStart: "Home", goToEnd: "End" },
  },
  resolve: {
    name: "DaVinci Resolve",
    keys: { playPause: "Space", split: "Meta+\\", delete: "Backspace", undo: "Meta+z", redo: "Meta+Shift+z", stepBack: "ArrowLeft", stepForward: "ArrowRight", prevEdit: "ArrowUp", nextEdit: "ArrowDown", duplicate: "Meta+d", zoomIn: "Meta+=", zoomOut: "Meta+-", toggleSnapping: "n", toggleMagnet: "Meta+Shift+m", goToStart: "Home", goToEnd: "End" },
  },
};

/** Normalize a keyboard event to the map's notation. */
export function keyOf(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): string {
  const mods = [e.metaKey || e.ctrlKey ? "Meta" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : ""].filter(Boolean);
  let key = e.key === " " ? "Space" : e.key;
  if (key.length === 1) key = key.toLowerCase();
  if (key === "+") key = "=";
  if (key === "_") key = "-";
  return [...mods, key].join("+");
}

/** Which action (if any) a key press triggers in the given map. */
export function actionFor(map: ShortcutMapId, e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): Action | null {
  const k = keyOf(e);
  const keys = SHORTCUT_MAPS[map].keys;
  for (const [action, key] of Object.entries(keys) as [Action, string][]) if (key === k) return action;
  // Delete and Backspace are interchangeable on Mac keyboards.
  if (k === "Delete" || k === "Backspace") for (const [action, key] of Object.entries(keys) as [Action, string][]) if (key === (k === "Delete" ? "Backspace" : "Delete")) return action;
  return null;
}
