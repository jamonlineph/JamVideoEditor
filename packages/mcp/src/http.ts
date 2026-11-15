import http from "node:http";
import fs from "node:fs";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer, type WebSocket } from "ws";
import type { AppState, ChangeEvent, EngineHost } from "@openedits/engine";
import { createMcpServer, runTool } from "./server.js";
import { allTools, VERSION } from "./registry.js";

export interface EngineInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
  version: string;
}

export interface HttpServerHandle {
  port: number;
  token: string;
  close(): Promise<void>;
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function readEngineInfo(file: string): EngineInfo | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Loopback HTTP server: Streamable HTTP MCP at /mcp, live patch stream + UI command bridge at /live (WebSocket),
 * unauthenticated /health. Requires a bearer token and rejects foreign Host/Origin headers (DNS rebinding).
 */
export async function startHttpServer(host: EngineHost, opts: { port?: number; token?: string; writeEngineFile?: boolean } = {}): Promise<HttpServerHandle> {
  const token = opts.token ?? randomBytes(24).toString("hex");
  const transports = new Map<string, StreamableHTTPServerTransport>();
  let port = opts.port ?? 0;

  const allowedHosts = () => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  const allowedOrigins = () => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];

  // The desktop app's page is a local file (Origin "file://"); it may open /live, still with the token.
  const authorized = (req: http.IncomingMessage, url: URL, opts: { allowFileOrigin?: boolean } = {}): boolean => {
    const hostHeader = req.headers.host ?? "";
    if (!allowedHosts().includes(hostHeader)) return false;
    const origin = req.headers.origin;
    if (origin && !allowedOrigins().includes(origin) && !(opts.allowFileOrigin && origin === "file://")) return false;
    const auth = req.headers.authorization;
    const supplied = auth?.startsWith("Bearer ") ? auth.slice(7) : (req.headers["x-openedits-token"] as string | undefined) ?? url.searchParams.get("token") ?? "";
    return safeEqual(supplied, token);
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<unknown>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 32 * 1024 * 1024) {
          reject(new Error("Request body too large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        if (!chunks.length) return resolve(undefined);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });

  const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (url.pathname === "/health" && req.method === "GET") {
        if (!allowedHosts().includes(req.headers.host ?? "")) return sendJson(res, 403, { error: "forbidden host" });
        return sendJson(res, 200, { ok: true, name: "openedits", version: VERSION, pid: process.pid });
      }
      if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "not found" });
      if (!authorized(req, url)) return sendJson(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });

      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (req.method === "POST") {
        const body = await readBody(req);
        let transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          if (sessionId || !isInitializeRequest(body)) return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: unknown or missing session" }, id: null });
          const t = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              transports.set(id, t);
            },
            enableDnsRebindingProtection: true,
            allowedHosts: allowedHosts(),
            allowedOrigins: allowedOrigins(),
          });
          t.onclose = () => {
            if (t.sessionId) transports.delete(t.sessionId);
          };
          await createMcpServer(host).connect(t);
          transport = t;
        }
        await transport.handleRequest(req, res, body);
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        const transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) return sendJson(res, 400, { error: "unknown session" });
        await transport.handleRequest(req, res);
        return;
      }
      sendJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message }, id: null });
    }
  });

  // ---- /live: state patches out, tool calls in (the desktop UI uses the same tool handlers as agents).
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/live" || !authorized(req, url, { allowFileOrigin: true })) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  const tools = new Map(allTools().map((t) => [t.name, t]));
  wss.on("connection", (ws: WebSocket) => {
    const send = (msg: unknown) => {
      if (ws.readyState !== ws.OPEN) return;
      let text: string;
      try {
        text = JSON.stringify(msg);
      } catch (e) {
        // A result that cannot be serialized fails that one call, not the engine.
        const id = (msg as { id?: unknown })?.id;
        text = JSON.stringify({ type: "result", id, ok: false, error: { code: "INTERNAL", message: `Could not serialize the result: ${(e as Error).message}` } });
      }
      ws.send(text);
    };
    ws.on("error", () => ws.terminate());
    send({ type: "hello", version: VERSION, appState: host.appState, project: host.isOpen ? { id: host.projectId, version: host.session.version, state: host.project } : null });
    const onChange = (e: ChangeEvent) => send({ type: "change", ...e, ...(e.kind === "open" && host.isOpen ? { state: host.project } : {}) });
    const onApp = (s: AppState) => send({ type: "appState", appState: s });
    host.on("change", onChange);
    host.on("appState", onApp);
    let detachUi: (() => void) | null = null;
    ws.on("close", () => {
      host.off("change", onChange);
      host.off("appState", onApp);
      detachUi?.();
    });
    ws.on("message", async (data) => {
      let msg: { type?: string; id?: unknown; tool?: string; args?: unknown; role?: string; ok?: boolean; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return send({ type: "error", message: "invalid JSON" });
      }
      if (msg.type === "register" && msg.role === "ui") {
        detachUi ??= host.attachUi((req) => send({ type: "uiRequest", ...req }));
        return;
      }
      if (msg.type === "uiResponse") {
        host.resolveUi(Number(msg.id), !!msg.ok, msg.ok ? msg.result : msg.error);
        return;
      }
      if (msg.type !== "call" || !msg.tool) return send({ type: "error", id: msg.id, message: "expected {type:'call', id, tool, args}" });
      const tool = tools.get(msg.tool);
      if (!tool) return send({ type: "result", id: msg.id, ok: false, error: { code: "INVALID_ARGUMENT", message: `Unknown tool ${msg.tool}` } });
      try {
        const r = await runTool(tool, msg.args, { host, source: "ui" });
        send({ type: "result", id: msg.id, ...r });
      } catch (e) {
        send({ type: "result", id: msg.id, ok: false, error: { code: "INTERNAL", message: (e as Error)?.message ?? String(e) } });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as { port: number }).port;

  if (opts.writeEngineFile ?? true) {
    const info: EngineInfo = { pid: process.pid, port, token, startedAt: Date.now(), version: VERSION };
    fs.writeFileSync(host.paths.engineFile, JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
  }

  return {
    port,
    token,
    close: async () => {
      for (const t of transports.values()) await t.close().catch(() => {});
      transports.clear();
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      const cur = readEngineInfo(host.paths.engineFile);
      if (cur && cur.pid === process.pid && cur.port === port) fs.rmSync(host.paths.engineFile, { force: true });
    },
  };
}

/** Find a live engine for this workspace (lockfile + /health). */
export async function findRunningEngine(engineFile: string): Promise<EngineInfo | undefined> {
  const info = readEngineInfo(engineFile);
  if (!info) return undefined;
  if (info.pid === process.pid) return undefined;
  try {
    process.kill(info.pid, 0);
  } catch {
    return undefined;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { name?: string; pid?: number };
    if (body.name === "openedits" && body.pid === info.pid) return info;
  } catch {
    /* not reachable */
  }
  return undefined;
}
