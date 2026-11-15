import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, systemPreferences } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * OpenEdits desktop shell. The editing engine runs as its own Node process (`openedits serve`),
 * shared with any AI agent connected over MCP; this window is a client of that engine.
 */
const ROOT = path.resolve(__dirname, "../../..");
const CLI = path.join(ROOT, "packages/mcp/dist/cli.js");
const TEST = process.env.OPENEDITS_UI_TEST === "1";
const workspace = process.env.OPENEDITS_WORKSPACE ?? path.join(os.homedir(), "Movies", "OpenEdits");
const engineFile = path.join(workspace, ".engine.json");
const debug = (...a: unknown[]) => process.env.OPENEDITS_DEBUG && console.error("[desktop]", ...a);

interface EngineInfo {
  pid: number;
  port: number;
  token: string;
}

let engine: ChildProcess | null = null;
let win: BrowserWindow | null = null;

function nodeBinary(): string {
  const candidates = [process.env.OPENEDITS_NODE, "/opt/homebrew/bin/node", path.join(os.homedir(), ".local/bin/node"), "/usr/local/bin/node", "/usr/bin/node"];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return "node";
}

async function healthy(info: EngineInfo): Promise<boolean> {
  try {
    process.kill(info.pid, 0);
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { name?: string; pid?: number };
    return body.name === "openedits" && body.pid === info.pid;
  } catch {
    return false;
  }
}

function readInfo(): EngineInfo | null {
  try {
    return JSON.parse(fs.readFileSync(engineFile, "utf8")) as EngineInfo;
  } catch {
    return null;
  }
}

/** Join the running engine for this workspace, or start one. */
async function ensureEngine(): Promise<EngineInfo> {
  const existing = readInfo();
  if (existing && (await healthy(existing))) return existing;
  engine = spawn(nodeBinary(), [CLI, "serve", "--port", "0", ...(process.env.OPENEDITS_AUTOPILOT ? ["--autopilot"] : [])], {
    env: { ...process.env, OPENEDITS_WORKSPACE: workspace, ELECTRON_RUN_AS_NODE: undefined },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    await new Promise((r) => setTimeout(r, 200));
    if (engine.exitCode !== null) throw new Error(`The engine exited (${engine.exitCode}); run \`node ${CLI} doctor\``);
    const info = readInfo();
    if (info && info.pid === engine.pid && (await healthy(info))) return info;
  }
  throw new Error("The engine did not start within 30 s");
}

function buildMenu() {
  const send = (action: string) => () => win?.webContents.send("menu", action);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      {
        label: "File",
        submenu: [
          { label: "New Project", accelerator: "CmdOrCtrl+N", click: send("newProject") },
          { label: "Import Media…", accelerator: "CmdOrCtrl+I", click: send("import") },
          { type: "separator" },
          { label: "Export…", accelerator: "CmdOrCtrl+E", click: send("export") },
          { type: "separator" },
          { label: "Close Project", accelerator: "CmdOrCtrl+W", click: send("closeProject") },
        ],
      },
      // Undo/redo go to the engine (shared with agents), not to the text fields' native undo.
      { label: "Edit", submenu: [{ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
      { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "togglefullscreen" }] },
      { role: "windowMenu" },
    ]),
  );
}

async function createWindow(info: EngineInfo) {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    show: !TEST,
    backgroundColor: "#0d0e11",
    titleBarStyle: "hiddenInset",
    title: "OpenEdits Studio",
    webPreferences: {
      // The renderer decodes media with ffmpeg child processes for the live preview.
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });
  // Only the bundled page runs here: no navigation, no new windows.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (process.env.OPENEDITS_DEBUG) {
    win.on("close", () => debug("window close"));
    win.webContents.on("render-process-gone", (_e, d) => debug("renderer gone", d.reason, d.exitCode));
    app.on("before-quit", () => debug("before-quit"));
    process.on("exit", (c) => debug("main exit", c));
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => debug("signal", sig));
    win.webContents.on("before-input-event", (_e, i) => debug("key", i.type, i.key, i.meta));
  }
  if (process.env.OPENEDITS_DEBUG) win.webContents.on("console-message", (e) => debug(`renderer ${e.level}:`, e.message, `${e.sourceId}:${e.lineNumber}`));
  await win.loadFile(path.join(__dirname, "index.html"), { query: { port: String(info.port), token: info.token, workspace } });
}

ipcMain.handle("pick-files", async (_e, opts: { title?: string; extensions?: string[]; multi?: boolean }) => {
  const r = await dialog.showOpenDialog(win!, {
    title: opts?.title ?? "Import media",
    properties: ["openFile", ...(opts?.multi === false ? [] : (["multiSelections"] as const))],
    filters: [{ name: "Media", extensions: opts?.extensions ?? ["mp4", "mov", "m4v", "mkv", "webm", "mp3", "m4a", "wav", "aif", "aiff", "flac", "png", "jpg", "jpeg", "heic", "webp", "gif"] }],
  });
  return r.canceled ? [] : r.filePaths;
});
// macOS asks the creator once; Chromium alone would wait silently for the system prompt.
ipcMain.handle("mic-access", async () => {
  if (process.platform !== "darwin") return true;
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return true;
  if (status === "denied" || status === "restricted") return false;
  return systemPreferences.askForMediaAccess("microphone");
});
ipcMain.handle("reveal", (_e, file: string) => shell.showItemInFolder(file));

/** Test hook: the test runner drives the window over the Node IPC channel. */
function testHarness() {
  if (!process.send) return;
  process.on("message", async (msg: { id: number; op: string; code?: string; path?: string }) => {
    try {
      let result: unknown;
      if (msg.op === "eval") result = await win!.webContents.executeJavaScript(msg.code!, true);
      else if (msg.op === "capture") {
        const image = await win!.webContents.capturePage();
        fs.writeFileSync(msg.path!, image.toPNG());
        result = image.getSize();
      } else if (msg.op === "quit") {
        app.quit();
        result = true;
      }
      process.send!({ id: msg.id, ok: true, result });
    } catch (e) {
      process.send!({ id: msg.id, ok: false, error: (e as Error).message });
    }
  });
}

if (TEST) {
  // Fake microphone (a beep) so voiceover recording can be tested without hardware.
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}

app.whenReady().then(async () => {
  // Only the microphone (voiceover recording) is ever granted.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media"));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "media");
  buildMenu();
  try {
    const info = await ensureEngine();
    debug("engine", info.port);
    await createWindow(info);
    debug("window loaded");
    if (TEST) {
      testHarness();
      process.send?.({ ready: true, port: info.port });
    }
  } catch (e) {
    dialog.showErrorBox("OpenEdits could not start", (e as Error).message);
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  if (engine && engine.exitCode === null) engine.kill("SIGTERM");
});
