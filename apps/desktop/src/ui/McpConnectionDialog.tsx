import { useEffect, useRef, useState } from "react";

export function McpConnectionDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const configField = useRef<HTMLTextAreaElement>(null);
  const [config, setConfig] = useState("");
  const [port, setPort] = useState<number>();
  const [status, setStatus] = useState("Loading connection settings…");

  useEffect(() => {
    dialog.current?.showModal();
    const request = new AbortController();
    void fetch("/web/mcp-connection", { method: "POST", signal: request.signal }).then(async (res) => {
      if (!res.ok) throw new Error("Connection settings unavailable");
      const value = await res.json();
      setPort(value.port);
      setConfig(JSON.stringify(value.config, null, 2));
      setStatus("");
    }).catch(() => {
      if (!request.signal.aborted) setStatus("Could not load settings. Reopen Connect AI after the editor reconnects.");
    });
    return () => request.abort();
  }, []);

  async function copyConfig() {
    try {
      await navigator.clipboard.writeText(config);
      setStatus("Configuration copied");
    } catch {
      configField.current?.focus();
      configField.current?.select();
      setStatus("Configuration selected. Press Ctrl+C to copy it.");
    }
  }

  return (
    <dialog ref={dialog} className="dialog" onClose={onClose} aria-labelledby="mcp-title">
      <h3 id="mcp-title">Connect Antigravity</h3>
      <p>In Antigravity, open MCP Servers → Manage MCP Servers → View raw config. Add the jamvideoeditor entry under mcpServers, then refresh the server list.</p>
      {config && <>
        <p>Keep JamVideoEditor open. If Antigravity runs in a separate Linux environment, run <code>adb forward tcp:{port} tcp:{port}</code> from that environment with ADB connected to Android.</p>
        <p>This configuration contains your private access token.</p>
        <textarea ref={configField} aria-label="Antigravity MCP configuration" readOnly value={config} rows={10} style={{ width: "100%", fontFamily: "monospace" }} />
      </>}
      <p role="status">{status}</p>
      <div className="row">
        <button className="primary" disabled={!config} onClick={() => void copyConfig()}>Copy configuration</button>
        <button onClick={() => dialog.current?.close()}>Close</button>
      </div>
    </dialog>
  );
}
