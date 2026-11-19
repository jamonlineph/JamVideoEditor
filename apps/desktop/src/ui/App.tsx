import { useEffect, useState } from "react";
import { McpConnectionDialog } from "./McpConnectionDialog.js";
import { Home } from "./Home.js";
import { Editor } from "./Editor.js";
import { live, useLive, WEB } from "./live.js";
import { ipcRenderer } from "electron";

export function App() {
  const s = useLive();
  const [mcpOpen, setMcpOpen] = useState(false);
  useEffect(() => {
    if (!WEB) return;
    const open = () => setMcpOpen(true);
    window.addEventListener("openedits-mcp", open);
    return () => window.removeEventListener("openedits-mcp", open);
  }, []);
  useEffect(() => {
    const onMenu = (_e: unknown, action: string) => {
      if (action === "newProject") void live.run("newProject", {});
      if (action === "closeProject") void live.run("closeProject");
      window.dispatchEvent(new CustomEvent("menu", { detail: action }));
    };
    ipcRenderer.on("menu", onMenu);
    return () => {
      ipcRenderer.off("menu", onMenu);
    };
  }, []);
  const screen = s.appState?.screen;
  return (
    <>
      {!s.appState ? <Splash connected={s.connected} /> : screen === "editor" && s.project ? <Editor key={s.project.id} /> : <Home />}
      {mcpOpen && <McpConnectionDialog onClose={() => setMcpOpen(false)} />}
      <div className="toasts">
        {s.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}

function Splash({ connected }: { connected: boolean }) {
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
      <div style={{ textAlign: "center" }}>
        <div className="brand" style={{ fontSize: 28 }}>
          Open<b>Edits</b> Studio
        </div>
        <div className="muted" style={{ marginTop: 8 }}>
          {connected ? "Loading…" : "Connecting to the engine…"}
        </div>
      </div>
    </div>
  );
}
