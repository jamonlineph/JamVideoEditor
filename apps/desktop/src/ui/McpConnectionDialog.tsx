import { useEffect, useRef, useState } from "react";
import { ipcRenderer } from "electron";
import { EditorIcon } from "./EditorIcon.js";
import { useLive, WEB } from "./live.js";

interface McpConnection {
  port: number;
  config: {
    mcpServers: {
      jamvideoeditor: { serverUrl: string; headers: { Authorization: string } };
    };
  };
}

async function loadConnection(signal: AbortSignal): Promise<McpConnection> {
  if (WEB) {
    const response = await fetch("/web/mcp-connection", { method: "POST", signal });
    if (!response.ok) throw new Error("Connection settings unavailable");
    return response.json();
  }
  const { port, token } = await ipcRenderer.invoke("ensure-engine") as { port: number; token: string };
  return {
    port,
    config: { mcpServers: { jamvideoeditor: {
      serverUrl: `http://127.0.0.1:${port}/mcp`,
      headers: { Authorization: `Bearer ${token}` },
    } } },
  };
}

export function McpConnectionDialog({ onClose }: { onClose: () => void }) {
  const { connected } = useLive();
  const dialog = useRef<HTMLDialogElement>(null);
  const configField = useRef<HTMLTextAreaElement>(null);
  const urlField = useRef<HTMLInputElement>(null);
  const adbField = useRef<HTMLInputElement>(null);
  const [connection, setConnection] = useState<McpConnection>();
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [status, setStatus] = useState("");
  const android = WEB && window.__openedits?.android === true;

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    setConnection(undefined);
    setShowToken(false);
    setStatus("");
    setFailed(false);
    if (!connected) return;
    const request = new AbortController();
    void loadConnection(request.signal).then((value) => {
      if (!request.signal.aborted) setConnection(value);
    }).catch(() => {
      if (!request.signal.aborted) setFailed(true);
    });
    return () => request.abort();
  }, [attempt, connected]);

  const server = connection?.config.mcpServers.jamvideoeditor;
  const config = connection ? JSON.stringify(connection.config, null, 2) : "";
  const displayed = !showToken && server ? config.replace(server.headers.Authorization, "Bearer ••••••••") : config;
  const adb = connection ? `adb forward tcp:${connection.port} tcp:${connection.port}` : "";

  async function copy(value: string, label: string, field: HTMLInputElement | HTMLTextAreaElement | null) {
    try {
      if (WEB) await navigator.clipboard.writeText(value);
      else await ipcRenderer.invoke("copy-text", value);
      setStatus(`${label} copied.`);
    } catch {
      // Some Android WebViews only support copying a selection in the active dialog.
      const source = document.activeElement as HTMLElement | null;
      const temp = document.createElement("textarea");
      temp.value = value;
      temp.readOnly = true;
      temp.style.cssText = "position:absolute;opacity:0;inset:0;width:1px;height:1px";
      dialog.current?.append(temp);
      temp.select();
      let copied = false;
      try { copied = document.execCommand("copy"); } catch { /* offer manual copy */ }
      temp.remove();
      if (copied) {
        source?.focus();
        setStatus(`${label} copied.`);
      } else {
        if (field === configField.current && field) {
          setShowToken(true);
          requestAnimationFrame(() => { field.focus(); field.select(); });
        } else {
          field?.focus();
          field?.select();
        }
        setStatus(`${label} selected. Use your device’s Copy command.`);
      }
    }
  }

  return (
    <dialog ref={dialog} className="dialog mcp-dialog" onClose={onClose} aria-labelledby="mcp-title">
      <div className="dialog-heading">
        <div className="mcp-symbol"><EditorIcon name="plug" /></div>
        <div>
          <h3 id="mcp-title">MCP settings</h3>
          <span className="muted small">Streamable HTTP · {connected ? "Engine online" : "Reconnecting"}</span>
        </div>
        <button className="icon ghost" autoFocus aria-label="Close MCP settings" onClick={() => dialog.current?.close()}><EditorIcon name="close" /></button>
      </div>

      {server && <>
        <label className="setup-field" htmlFor="mcp-url">Server URL</label>
        <div className="mcp-copy-row">
          <input id="mcp-url" ref={urlField} readOnly value={server.serverUrl} />
          <button onClick={() => void copy(server.serverUrl, "URL", urlField.current)}><EditorIcon name="copy" />Copy URL</button>
        </div>
        <div className="mcp-instructions">
          <h4>Antigravity configuration</h4>
          <p>Open <strong>MCP Servers → Manage MCP Servers → View raw config</strong>. Paste the <code>jamvideoeditor</code> entry under <code>mcpServers</code> and refresh the server list.</p>
        </div>
        <textarea className="mcp-config" ref={configField} aria-label="Antigravity MCP configuration" readOnly value={displayed} wrap="off" rows={9} />
        <div className="mcp-config-actions">
          <button className="primary" onClick={() => void copy(config, "Configuration", configField.current)}><EditorIcon name="copy" />Copy configuration</button>
          <button aria-pressed={showToken} onClick={() => { setShowToken((shown) => !shown); setStatus(""); }}><EditorIcon name={showToken ? "eyeOff" : "eye"} />{showToken ? "Hide token" : "Show token"}</button>
        </div>
        <p className="muted small">The copied configuration includes the private token. Other MCP clients can use the server URL and the same Authorization header. Keep OpenEdits Studio running while connected.</p>
        {android && <details className="mcp-forward">
          <summary>Antigravity in a separate Linux environment</summary>
          <p className="muted small">With ADB connected to Android, run this command in the Linux environment before connecting.</p>
          <div className="mcp-copy-row">
            <input ref={adbField} aria-label="ADB port forwarding command" readOnly value={adb} />
            <button onClick={() => void copy(adb, "ADB command", adbField.current)}>Copy command</button>
          </div>
        </details>}
      </>}

      {!server && <div className="mcp-unavailable" role="status">
        <span>{!connected ? "Waiting for the engine to reconnect…" : failed ? "Couldn’t load connection settings." : "Loading connection settings…"}</span>
        {connected && failed && <button onClick={() => setAttempt((value) => value + 1)}>Retry</button>}
      </div>}
      <div className="mcp-copy-status small" role="status">{status}</div>
    </dialog>
  );
}
