import nodeHttp from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";
import { EngineHost } from "@openedits/engine";
import { startHttpServer, unwrap, type HttpServerHandle } from "../src/index.js";
import { ROOT, tempWorkspace, testMedia } from "../../engine/test/media.js";

const CLI = path.join(ROOT, "packages/mcp/dist/cli.js");

type Json = Record<string, any>;

async function callOk(client: Client, name: string, args: Json = {}): Promise<Json> {
  const r = unwrap(await client.callTool({ name, arguments: args }));
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.value)}`);
  return r.value as Json;
}

function httpClient(port: number, token: string, name: string) {
  const client = new Client({ name, version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  return { client, connect: () => client.connect(transport) };
}

describe("stdio transport (embedded engine)", () => {
  it("serves tools over stdio from the built CLI", async () => {
    const ws = tempWorkspace("stdio");
    const m = testMedia();
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--no-http"], env: { ...process.env, OPENEDITS_WORKSPACE: ws } as Record<string, string>, stderr: "pipe" });
    const client = new Client({ name: "stdio-test", version: "1" });
    await client.connect(transport);
    try {
      expect(client.getInstructions()).toMatch(/OpenEdits Studio/);
      const caps = await callOk(client, "getCapabilities");
      expect(caps.workspace.root).toBe(ws);
      await callOk(client, "newProject", { name: "Stdio" });
      const added = await callOk(client, "addMedia", { path: m.clipA });
      const state = await callOk(client, "appState");
      expect(state.project.elementCount).toBe(1);
      expect(state.project.version).toBe(added.version);
    } finally {
      await client.close();
    }
  });
});

describe("HTTP engine", () => {
  let host: EngineHost;
  let http: HttpServerHandle;

  beforeAll(async () => {
    host = EngineHost.create({ workspaceRoot: tempWorkspace("http"), validate: true });
    http = await startHttpServer(host, { port: 0 });
  });

  afterAll(async () => {
    await http.close();
    host.dispose();
  });

  it("rejects missing tokens, foreign hosts and foreign origins", async () => {
    const url = `http://127.0.0.1:${http.port}/mcp`;
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    expect((await fetch(url, { method: "POST", headers, body: JSON.stringify(init) })).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers: { ...headers, authorization: "Bearer nope" }, body: JSON.stringify(init) })).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers: { ...headers, authorization: `Bearer ${http.token}`, origin: "https://evil.example" }, body: JSON.stringify(init) })).status).toBe(401);
    // fetch() cannot override Host, so use node:http to simulate a DNS-rebinding request.
    const status = await new Promise<number>((resolve, reject) => {
      const req = nodeHttp.request({ host: "127.0.0.1", port: http.port, path: "/mcp", method: "POST", headers: { ...headers, authorization: `Bearer ${http.token}`, host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end(JSON.stringify(init));
    });
    expect(status).toBe(401);
    const ok = await fetch(url, { method: "POST", headers: { ...headers, authorization: `Bearer ${http.token}` }, body: JSON.stringify(init) });
    expect(ok.status).toBe(200);
    const health = await (await fetch(`http://127.0.0.1:${http.port}/health`)).json();
    expect(health).toMatchObject({ ok: true, name: "openedits", pid: process.pid });
  });

  it("two clients edit one live composition; stale versions are rejected", async () => {
    const m = testMedia();
    const a = httpClient(http.port, http.token, "agent-a");
    const b = httpClient(http.port, http.token, "agent-b");
    await a.connect();
    await b.connect();
    try {
      await callOk(a.client, "newProject", { name: "Shared" });
      const add = await callOk(a.client, "addMedia", { path: m.clipA });
      const seen = await callOk(b.client, "clips");
      expect(seen.items.map((c: Json) => c.id)).toEqual([add.elementId]);
      const v = (await callOk(b.client, "appState")).project.version;
      await callOk(b.client, "split", { elementId: add.elementId, time: 2, expectedVersion: v });
      const conflict = unwrap(await a.client.callTool({ name: "split", arguments: { elementId: add.elementId, time: 1, expectedVersion: v } }));
      expect(conflict.ok).toBe(false);
      expect((conflict.value as Json).error.code).toBe("VERSION_CONFLICT");
      // The undo history records which client made each edit, and either client can undo.
      expect(host.session.history().undo.at(-1)?.source).toBe("mcp:agent-b");
      await callOk(a.client, "undo");
      expect((await callOk(b.client, "clips")).total).toBe(1);
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });

  it("streams patches over /live and runs UI tool calls", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${http.port}/live?token=${http.token}`);
    const messages: Json[] = [];
    const waitFor = (pred: (m: Json) => boolean) =>
      new Promise<Json>((resolve, reject) => {
        const hit = messages.find(pred);
        if (hit) return resolve(hit);
        const timer = setTimeout(() => reject(new Error("timeout waiting for message")), 5000);
        ws.on("message", (d) => {
          const msg = JSON.parse(String(d));
          if (pred(msg)) {
            clearTimeout(timer);
            resolve(msg);
          }
        });
      });
    ws.on("message", (d) => messages.push(JSON.parse(String(d))));
    await waitFor((msg) => msg.type === "hello");
    ws.send(JSON.stringify({ type: "call", id: 7, tool: "addText", args: { text: "From UI", start: 0, duration: 1 } }));
    const result = await waitFor((msg) => msg.type === "result" && msg.id === 7);
    expect(result.ok).toBe(true);
    const change = await waitFor((msg) => msg.type === "change" && msg.kind === "commit" && msg.source === "ui");
    expect(change.patches.length).toBeGreaterThan(0);
    expect(host.session.history().undo.at(-1)?.source).toBe("ui");
    const bad = new WebSocket(`ws://127.0.0.1:${http.port}/live?token=wrong`);
    await new Promise<void>((resolve) => bad.on("error", () => resolve()));
    // The desktop app's page is a local file: its origin is allowed, a web origin is not.
    const app = new WebSocket(`ws://127.0.0.1:${http.port}/live?token=${http.token}`, { origin: "file://" });
    await new Promise<void>((resolve, reject) => (app.on("open", () => resolve()), app.on("error", reject)));
    app.close();
    const web = new WebSocket(`ws://127.0.0.1:${http.port}/live?token=${http.token}`, { origin: "https://evil.example" });
    await new Promise<void>((resolve) => web.on("error", () => resolve()));
    ws.close();
  });
});

describe("stdio proxy to a running engine", () => {
  it("an agent over stdio joins the engine a human is using", async () => {
    const root = tempWorkspace("proxy");
    const host = EngineHost.create({ workspaceRoot: root });
    const http = await startHttpServer(host, { port: 0 });
    host.newProject({ name: "Live in the app" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env: { ...process.env, OPENEDITS_WORKSPACE: root } as Record<string, string>, stderr: "pipe" });
    const client = new Client({ name: "proxied-agent", version: "1" });
    try {
      await client.connect(transport);
      const state = await callOk(client, "appState");
      expect(state.project.name).toBe("Live in the app");
      await callOk(client, "addText", { text: "Agent was here", start: 0, duration: 1 });
      expect(Object.values(host.project.elements).some((e) => e.type === "text" && e.text === "Agent was here")).toBe(true);
      expect(host.session.history().undo.at(-1)?.source).toBe("mcp:proxied-agent");
    } finally {
      await client.close();
      await http.close();
      host.dispose();
    }
  });
});
