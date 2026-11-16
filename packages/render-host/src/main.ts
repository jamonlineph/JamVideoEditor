import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";

/**
 * Headless render host. The engine spawns this Electron process with a Node IPC channel
 * and exchanges JSON messages with a hidden window that runs the WebGL2 compositor.
 */
if (process.platform === "darwin") app.setActivationPolicy("accessory");
// Its own profile folder, so it never competes with the desktop window for Chromium's profile lock.
app.setPath("userData", path.join(app.getPath("appData"), "OpenEdits Render Host"));
// Machines without a supported GPU (VMs, remote desktops, old drivers) still get WebGL2, in software.
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096");
app.on("window-all-closed", () => app.quit());
process.on("disconnect", () => app.exit(0));

const send = (msg: unknown) => {
  try {
    process.send?.(msg);
  } catch {
    app.exit(0);
  }
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  // This window only ever runs the bundled page: no navigation, no popups.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("render-process-gone", (_e, details) => {
    send({ type: "fatal", message: `render process ${details.reason}` });
    app.exit(1);
  });
  win.webContents.on("console-message", (e) => {
    if (e.level === "error" || e.level === "warning") send({ type: "log", level: e.level, message: e.message });
  });
  ipcMain.on("to-engine", (_e, msg) => send(msg));
  process.on("message", (msg) => win.webContents.send("from-engine", msg));
  await win.loadFile(path.join(__dirname, "page.html"));
  send({ type: "ready", versions: { electron: process.versions.electron, chrome: process.versions.chrome } });
});
