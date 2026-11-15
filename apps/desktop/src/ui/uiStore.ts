import { useSyncExternalStore } from "react";

/** View state that only this window cares about (not shared with agents). */
export interface UiState {
  playhead: number;
  playing: boolean;
  loop: boolean;
  pxPerSecond: number;
  dockTab: "media" | "audio" | "text" | "effects";
  panel: string | null;
  showGuides: boolean;
  recorder: boolean;
  exportOpen: boolean;
}

let state: UiState = { playhead: 0, playing: false, loop: false, pxPerSecond: 60, dockTab: "media", panel: null, showGuides: false, recorder: false, exportOpen: false };
const listeners = new Set<() => void>();

export const ui = {
  get: () => state,
  set(patch: Partial<UiState>) {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useUi(): UiState {
  return useSyncExternalStore(ui.subscribe, ui.get);
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
