import { useEffect, useState } from "react";
import { McpConnectionDialog } from "./McpConnectionDialog.js";
import { Home } from "./Home.js";
import { Editor } from "./Editor.js";
import { live, useLive } from "./live.js";
import { recorder } from "./recorder.js";
import { ipcRenderer } from "electron";

export function App() {
  const s = useLive();
  const [mcpOpen, setMcpOpen] = useState(false);
  const [navigation, setNavigation] = useState<{ projectId: string | null; home: boolean } | null>(null);
  const screen = s.appState?.screen;
  const projectId = s.appState?.openProjectId ?? null;
  useEffect(() => {
    if (!screen || screen === "loading") return;
    // Start in the project library even when the engine has restored a project for MCP clients.
    setNavigation((current) => current?.projectId === projectId ? current : { projectId, home: !current || !projectId });
  }, [screen, projectId]);
  useEffect(() => {
    const onMenu = (_e: unknown, action: string) => {
      if (action === "newProject") void live.run("newProject", {});
      if (action === "closeProject") void live.run("closeProject");
      if (action === "mcpSettings") setMcpOpen(true);
      window.dispatchEvent(new CustomEvent("menu", { detail: action }));
    };
    ipcRenderer.on("menu", onMenu);
    live.onUi(async (command, args) => {
      if (command === "startRecording") {
        const activeProject = live.state.project;
        if (!activeProject) throw new Error("Open a project before recording");
        setNavigation({ projectId: activeProject.id, home: false });
        return recorder.start(args as { start?: number; preRollSeconds?: number });
      }
      if (command === "stopRecording") return recorder.stop();
      throw new Error(`Unknown request ${command}`);
    });
    return () => {
      ipcRenderer.off("menu", onMenu);
    };
  }, []);
  const showEditor = screen === "editor" && s.project && s.project.id === projectId && navigation && !navigation.home;
  return (
    <>
      {!s.appState ? <Splash connected={s.connected} /> : showEditor ? (
        <Editor key={projectId} onHome={() => setNavigation({ projectId, home: true })} onOpenMcp={() => setMcpOpen(true)} />
      ) : (
        <Home onOpenProject={() => setNavigation({ projectId: live.state.appState?.openProjectId ?? null, home: false })}
          onOpenMcp={() => setMcpOpen(true)} />
      )}
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
