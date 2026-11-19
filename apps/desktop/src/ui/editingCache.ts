import { useEffect, useSyncExternalStore } from "react";
import type { EditingProxy } from "@openedits/core";
import { live } from "./live.js";

export interface EditingCacheStatus {
  projectId: string | null;
  proxies: Record<string, EditingProxy>;
  eligibleVideos: number;
  proxyBytes: number;
  previewBytes: number;
  thumbnailBytes: number;
}

const empty: EditingCacheStatus = {
  projectId: null,
  proxies: {},
  eligibleVideos: 0,
  proxyBytes: 0,
  previewBytes: 0,
  thumbnailBytes: 0,
};
const preference = "openedits.editingProxies";
let enabled = true;
try {
  enabled = localStorage.getItem(preference) !== "off";
} catch {
  // The window can still use proxies while storage is unavailable.
}
let state = { ...empty, enabled };
let request = 0;
const listeners = new Set<() => void>();
function set(next: typeof state) {
  state = next;
  for (const listener of listeners) listener();
}

export const editingCache = {
  async refresh() {
    const projectId = live.state.project?.id;
    if (!projectId || !live.state.connected) return;
    const generation = ++request;
    try {
      const status = await live.call<EditingCacheStatus>("editingCacheStatus");
      if (generation === request && status.projectId === live.state.project?.id) {
        // Storage-only changes should not replace the map used by the active preview.
        const keys = Object.keys(status.proxies);
        const same = status.projectId === state.projectId && keys.length === Object.keys(state.proxies).length
          && keys.every((id) => status.proxies[id].path === state.proxies[id]?.path);
        set({ ...status, proxies: same ? state.proxies : status.proxies, enabled: state.enabled });
      }
    } catch {
      // Project changes and temporary engine disconnects are handled by the next refresh.
    }
  },
  setEnabled(value: boolean) {
    if (state.enabled === value) return;
    try {
      localStorage.setItem(preference, value ? "on" : "off");
    } catch {
      // Use the preference for the current session.
    }
    set({ ...state, enabled: value });
  },
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useEditingCache() {
  const projectId = useSyncExternalStore(live.subscribe, () => live.state.connected ? live.state.project?.id ?? null : null);
  const media = useSyncExternalStore(live.subscribe, () => live.state.project?.media);
  const current = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (projectId) void editingCache.refresh();
  }, [projectId, media]);
  return current.projectId === projectId ? current : { ...empty, enabled: current.enabled };
}
