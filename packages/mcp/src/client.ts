import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EngineHost, resolveWorkspace } from "@openedits/engine";
import { createMcpServer } from "./server.js";
import { findRunningEngine } from "./http.js";
import { VERSION } from "./registry.js";

export interface ConnectedClient {
  client: Client;
  mode: "remote" | "embedded";
  close(): Promise<void>;
}

/** Connect to the running engine if there is one, otherwise host an engine in-process. */
export async function connectClient(name = "openedits-cli"): Promise<ConnectedClient> {
  const client = new Client({ name, version: VERSION });
  const info = await findRunningEngine(resolveWorkspace().engineFile);
  if (info) {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${info.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${info.token}` } },
    });
    await client.connect(transport);
    return { client, mode: "remote", close: () => client.close() };
  }
  const host = EngineHost.create();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createMcpServer(host, { source: "cli" }).connect(serverT);
  await client.connect(clientT);
  return {
    client,
    mode: "embedded",
    close: async () => {
      await client.close();
      host.dispose();
    },
  };
}

export function unwrap(raw: unknown): { ok: boolean; value: unknown } {
  const result = raw as { content?: unknown; isError?: boolean; structuredContent?: unknown };
  if (result.structuredContent) return { ok: !result.isError, value: result.structuredContent };
  const content = result.content as { type: string; text?: string }[] | undefined;
  const text = content?.find((c) => c.type === "text")?.text ?? "";
  try {
    return { ok: !result.isError, value: JSON.parse(text) };
  } catch {
    return { ok: !result.isError, value: text };
  }
}
