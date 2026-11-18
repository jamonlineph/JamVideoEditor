import { useSyncExternalStore } from "react";

/** View state that only this window cares about (not shared with agents). */
export interface UiState {
  playhead: number;
  playing: boolean;
  loop: boolean;
  pxPerSecond: number;
  dockTab: DockTab;
  /** Remembered properties tab (Basic, Animation, Speed, ...). */
  panel: string | null;
  /** Compact layout: the bottom sheet that is open, if any. */
  sheet: Sheet | null;
  /** Transition picker open on the cut after this main-track clip. */
  transitionCut: string | null;
  showGuides: boolean;
  previewQuality: "auto" | "draft" | "high";
  recorder: boolean;
  exportOpen: boolean;
}

export const DOCK_TABS = ["media", "audio", "text", "stickers", "effects", "transitions", "filters", "adjust", "captions"] as const;
export type DockTab = (typeof DOCK_TABS)[number];
export type Sheet = { kind: "dock"; tab: DockTab } | { kind: "inspector"; tab?: string };

let state: UiState = { playhead: 0, playing: false, loop: false, pxPerSecond: 60, dockTab: "media", panel: null, sheet: null, transitionCut: null, showGuides: false, previewQuality: "auto", recorder: false, exportOpen: false };
const listeners = new Set<() => void>();

export const ui = {
  get: () => state,
  set(patch: Partial<UiState>) {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};

/**
 * Move the playhead from anywhere in the UI: the viewport redraws and the engine (and agents) hear
 * about it. The editor routes this to the player.
 */
export function seek(seconds: number) {
  window.dispatchEvent(new CustomEvent("openedits-seek", { detail: seconds }));
}

export function useUi<K extends keyof UiState>(key: K): UiState[K] {
  return useSyncExternalStore(ui.subscribe, () => ui.get()[key]);
}

export function formatTime(t: number, fps = 30): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const f = Math.floor((s - Math.floor(s)) * fps + 1e-6);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}

/** Pointer capture for drags; tolerant of synthetic pointers (tests, accessibility tools). */
export function capturePointer(el: Element, pointerId: number) {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* not an active pointer */
  }
}
