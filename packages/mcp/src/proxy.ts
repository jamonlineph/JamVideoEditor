import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { EngineInfo } from "./http.js";

/** Relay MCP JSON-RPC between stdio (the agent) and a running engine's HTTP endpoint. */
export async function runStdioProxy(info: EngineInfo, log: (msg: string) => void): Promise<void> {
  const stdio = new StdioServerTransport();
  const remote = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${info.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${info.token}` } },
  });
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    await remote.close().catch(() => {});
    await stdio.close().catch(() => {});
  };
  stdio.onmessage = (msg: JSONRPCMessage) => {
    remote.send(msg).catch((e: Error) => {
      log(`proxy: send failed: ${e.message}`);
      if ("id" in msg && "method" in msg) {
        void stdio.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `OpenEdits engine unreachable: ${e.message}` } });
      }
    });
  };
  remote.onmessage = (msg: JSONRPCMessage) => {
    void stdio.send(msg);
  };
  remote.onerror = (e: Error) => log(`proxy: ${e.message}`);
  stdio.onclose = () => void shutdown();
  await remote.start();
  await stdio.start();
  await new Promise<void>((resolve) => {
    const prev = stdio.onclose;
    stdio.onclose = () => {
      prev?.();
      resolve();
    };
  });
}
