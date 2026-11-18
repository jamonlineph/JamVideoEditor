// "electron" for the compositor page when it runs in a browser view instead of a hidden Electron
// window (OPENEDITS_RENDER_HOST=web; on Android the app keeps this page open in a WebView). The page's
// messages to and from the engine go over a WebSocket (/web/render-host) instead of Electron's IPC.
type Handler = (event: unknown, msg: unknown) => void;

const handlers: Handler[] = [];
const outbox: string[] = [];
let ws: WebSocket | null = null;

function connect() {
  const socket = (ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/web/render-host`));
  socket.onopen = () => {
    socket.send(JSON.stringify({ type: "ready", versions: { chrome: /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? "unknown", web: "1" } }));
    for (const m of outbox.splice(0)) socket.send(m);
    document.title = "OpenEdits render host (connected)";
  };
  socket.onmessage = (ev) => {
    let msg: unknown;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    for (const h of handlers) h(null, msg);
  };
  // The engine restarted or replaced this page: start over with a fresh page (and a fresh compositor).
  socket.onclose = () => {
    document.title = "OpenEdits render host (reconnecting)";
    setTimeout(() => location.reload(), 1500);
  };
}

export const ipcRenderer = {
  send(_channel: string, msg: unknown) {
    const text = JSON.stringify(msg);
    if (ws?.readyState === WebSocket.OPEN) ws.send(text);
    else outbox.push(text);
  },
  on(_channel: string, handler: Handler) {
    handlers.push(handler);
  },
};

connect();
