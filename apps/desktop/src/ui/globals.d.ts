/** Set by the build: true in the browser bundle, false in the desktop app's. */
declare const __OPENEDITS_WEB__: boolean;

interface Window {
  __openedits?: { workspace?: string; android?: boolean };
}
