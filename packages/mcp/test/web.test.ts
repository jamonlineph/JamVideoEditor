import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import nodeHttp from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { EngineHost, ffmpegPath } from "@openedits/engine";
import { startHttpServer, type HttpServerHandle } from "../src/index.js";
import { allTools } from "../src/registry.js";
import { runTool } from "../src/server.js";
import { spawn as browserSpawn } from "../../../apps/desktop/src/web/child_process.js";

const tools = new Map(allTools().map((t) => [t.name, t]));
import { ROOT, tempWorkspace, testMedia } from "../../engine/test/media.js";

/** Browser mode (`openedits serve --web`): what the page in a browser relies on. */
describe("browser mode", () => {
  let host: EngineHost;
  let http: HttpServerHandle;
  let base: string;
  let cookie: string;
  const root = path.join(ROOT, "apps/desktop/dist/web");

  beforeAll(async () => {
    host = EngineHost.create({ workspaceRoot: tempWorkspace("web") });
    http = await startHttpServer(host, { port: 0, web: { root, ffmpeg: ffmpegPath() } });
    base = `http://localhost:${http.port}`;
    cookie = `openedits_token=${http.token}`;
  });
  afterAll(async () => {
    await http.close();
    host.dispose();
  });

  it("signs a browser in with the link, then serves the page to its cookie only", async () => {
    expect((await fetch(`${base}/`)).status).toBe(401);
    expect((await fetch(`${base}/?token=wrong`)).status).toBe(401);
    const signIn = await fetch(`${base}/?token=${http.token}`, { redirect: "manual" });
    expect(signIn.status).toBe(302);
    expect(signIn.headers.get("set-cookie")).toContain(`openedits_token=${http.token}`);
    const page = await fetch(`${base}/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("app.js");
    // The app's own files and the install manifest need no cookie.
    expect((await fetch(`${base}/manifest.webmanifest`)).headers.get("content-type")).toContain("manifest");
    expect((await fetch(`${base}/app.js`)).status).toBe(200);
    expect((await fetch(`${base}/../../package.json`)).status).toBe(404);
  });

  it("rejects other sites and other hosts even with the cookie", async () => {
    expect((await fetch(`${base}/web/config.js`)).status).toBe(401);
    expect((await fetch(`${base}/web/config.js`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/web/config.js`, { headers: { cookie, origin: "http://localhost:9999" } })).status).toBe(401);
    expect((await fetch(`${base}/web/config.js`, { headers: { cookie, "sec-fetch-site": "same-site" } })).status).toBe(401);
    // A page on another name that resolves here (DNS rebinding) arrives with that name as its Host.
    const foreign = await new Promise<number>((resolve, reject) => {
      nodeHttp.get({ host: "127.0.0.1", port: http.port, path: "/web/config.js", headers: { cookie, host: `evil.example:${http.port}` } }, (res) => resolve(res.statusCode ?? 0)).on("error", reject);
    });
    expect(foreign).toBe(404);
  });

  it("provides authenticated connection settings that an HTTP MCP client can use", async () => {
    const endpoint = `${base}/web/mcp-connection`;
    expect((await fetch(endpoint, { method: "POST" })).status).toBe(401);
    expect((await fetch(endpoint, { method: "POST", headers: { cookie, origin: "https://example.com" } })).status).toBe(401);
    const res = await fetch(endpoint, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { config: { mcpServers: { jamvideoeditor } } } = await res.json();
    const client = new Client({ name: "connection-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(jamvideoeditor.serverUrl), {
        requestInit: { headers: jamvideoeditor.headers },
      }));
      expect((await client.listTools()).tools.some((tool) => tool.name === "newProject")).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("takes uploads, serves files with ranges and keeps writes inside the workspace", async () => {
    const up = await fetch(`${base}/web/upload?name=${encodeURIComponent("../my clip.txt")}`, { method: "POST", headers: { cookie }, body: "0123456789" });
    const { path: file } = (await up.json()) as { path: string };
    expect(file).toBe(path.join(host.paths.root, "uploads", "my clip.txt"));
    const again = (await (await fetch(`${base}/web/upload?name=my%20clip.txt`, { method: "POST", headers: { cookie }, body: "x" })).json()) as { path: string };
    expect(path.basename(again.path)).toBe("my clip (2).txt");

    const ranged = await fetch(`${base}/web/file?path=${encodeURIComponent(file)}`, { headers: { cookie, range: "bytes=2-5" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await ranged.text()).toBe("2345");
    const dl = await fetch(`${base}/web/file?download=1&path=${encodeURIComponent(file)}`, { headers: { cookie } });
    expect(dl.headers.get("content-disposition")).toContain("attachment");

    const fsCall = (body: unknown) => fetch(`${base}/web/fs`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(await (await fsCall({ op: "exists", path: file })).json()).toEqual({ result: true });
    expect(((await (await fsCall({ op: "readdir", path: path.dirname(file) })).json()) as { result: string[] }).result).toContain("my clip.txt");
    expect((await fsCall({ op: "rm", path: path.join(ROOT, "package.json") })).status).toBe(403);
    expect((await fetch(`${base}/web/write?path=${encodeURIComponent(path.join(ROOT, "nope.txt"))}`, { method: "PUT", headers: { cookie }, body: "x" })).status).toBe(403);
    const inside = path.join(host.paths.root, "projects", "p", "take.bin");
    expect((await fetch(`${base}/web/write?path=${encodeURIComponent(inside)}`, { method: "PUT", headers: { cookie }, body: "abc" })).status).toBe(200);
    expect(fs.readFileSync(inside, "utf8")).toBe("abc");
  });

  it("streams ffmpeg output to the page (frame decoding for the preview)", async () => {
    const m = testMedia();
    const run = (headers: Record<string, string>) =>
      new Promise<{ bytes: number; code: number | null | undefined; opened: boolean }>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${http.port}/web/spawn`, { headers });
        let bytes = 0;
        let code: number | null | undefined;
        let opened = false;
        ws.on("open", () => {
          opened = true;
          ws.send(JSON.stringify({ args: ["-v", "error", "-nostdin", "-i", m.clipA, "-frames:v", "2", "-vf", "scale=64:36", "-pix_fmt", "rgba", "-f", "rawvideo", "-"] }));
        });
        ws.on("message", (data, isBinary) => {
          if (isBinary) bytes += (data as Buffer).length;
          else {
            const msg = JSON.parse(String(data)) as { close?: number | null };
            if ("close" in msg) code = msg.close;
          }
        });
        ws.on("error", () => {});
        ws.on("close", () => resolve({ bytes, code, opened }));
      });
    expect(await run({ cookie })).toEqual({ bytes: 2 * 64 * 36 * 4, code: 0, opened: true });
    expect((await run({})).opened).toBe(false);
  });

  it("lets the page open /live with its cookie", async () => {
    const hello = await new Promise<{ type: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${http.port}/live`, { headers: { cookie, origin: base } });
      ws.on("message", (d) => {
        resolve(JSON.parse(String(d)));
        ws.close();
      });
      ws.on("error", reject);
    });
    expect(hello.type).toBe("hello");
  });
});

describe("browser FFmpeg input", () => {
  let host: EngineHost;
  let http: HttpServerHandle;

  beforeAll(async () => {
    host = EngineHost.create({ workspaceRoot: tempWorkspace("web-stdin") });
    const root = path.join(ROOT, "apps/desktop/dist/web");
    http = await startHttpServer(host, { port: 0, web: { root, ffmpeg: process.execPath } });
    // Use the browser adapter with a real WebSocket and a child we can block on demand.
    class BrowserSocket extends WebSocket {
      constructor(url: string) {
        super(url, { headers: { cookie: `openedits_token=${http.token}` } });
      }
    }
    vi.stubGlobal("WebSocket", BrowserSocket);
    vi.stubGlobal("location", new URL(`http://localhost:${http.port}`));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await http.close();
    host.dispose();
  });

  const pipe = (gate: string) => {
    const script = `
      const fs = require("node:fs");
      process.stderr.write("waiting");
      const timer = setInterval(() => {
        if (!fs.existsSync(process.argv[1])) return;
        clearInterval(timer);
        let count = 0;
        process.stdin.on("data", (chunk) => count += chunk.length);
        process.stdin.on("end", () => process.stdout.write(String(count)));
      }, 10);
    `;
    const child = browserSpawn("ffmpeg", ["-e", script, gate]);
    const ready = new Promise<void>((resolve) => child.stderr.on("data", () => resolve()));
    let data = "";
    child.stdout.on("data", (chunk: Uint8Array) => (data += Buffer.from(chunk).toString()));
    const closed = new Promise<{ code: number | null; data: string }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, data }));
    });
    return { child, ready, closed };
  };

  it("acknowledges input only after the child drains chunks, including when stdin ends with data", async () => {
    const gate = path.join(host.paths.root, "drain");
    const { child, ready, closed } = pipe(gate);
    const buffer = new Uint8Array(9 * 1024 * 1024);
    let acknowledged = false;
    const written = new Promise<void>((resolve, reject) => {
      child.stdin.write(buffer, (error) => {
        acknowledged = true;
        if (error) reject(error);
        else resolve();
      });
    });
    // Observe the promise early so an unexpected remote exit cannot become an unhandled rejection.
    const finished = Promise.all([written, closed]);
    void finished.catch(() => {});
    try {
      await ready;
      await delay(50);
      expect(acknowledged).toBe(false);
      fs.writeFileSync(gate, "");
      await written;
      child.stdin.end(new Uint8Array([1, 2, 3]));
      expect((await finished)[1]).toEqual({ code: 0, data: String(buffer.byteLength + 3) });
    } finally {
      child.kill();
    }
  });

  it("releases a pending write on cancellation while the child is blocked", async () => {
    const { child, ready, closed } = pipe(path.join(host.paths.root, "never-drain"));
    const result = new Promise<Error | null | undefined>((resolve) => child.stdin.write(new Uint8Array(8 * 1024 * 1024), resolve));
    try {
      await ready;
      child.kill();
      expect(await result).toBeInstanceOf(Error);
      expect(await closed).toEqual({ code: null, data: "" });
    } finally {
      child.kill();
    }
  });
});

/**
 * OpenEdits Studio on Android: the compositor is a page in the app's WebView that connects to the
 * engine (OPENEDITS_RENDER_HOST=web), instead of an Electron window the engine starts. A stand-in
 * page answers here the way the real one does.
 */
describe("render page over a socket (OPENEDITS_RENDER_HOST=web)", () => {
  let host: EngineHost;
  let http: HttpServerHandle;
  const root = path.join(ROOT, "apps/desktop/dist/web");

  beforeAll(async () => {
    process.env.OPENEDITS_RENDER_HOST = "web";
    host = EngineHost.create({ workspaceRoot: tempWorkspace("render-page") });
    http = await startHttpServer(host, { port: 0, web: { root, ffmpeg: ffmpegPath() } });
  });
  afterAll(async () => {
    delete process.env.OPENEDITS_RENDER_HOST;
    await http.close();
    host.dispose();
  });

  const connectPage = (onRequest: (msg: { id: number; method: string; params: Record<string, unknown> }, ws: WebSocket) => void) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${http.port}/web/render-host`, { headers: { cookie: `openedits_token=${http.token}` } });
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "ready", versions: { chrome: "test" } }));
        resolve(ws);
      });
      ws.on("error", reject);
      ws.on("message", (data) => onRequest(JSON.parse(String(data)), ws));
    });

  it("refuses a page without the token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${http.port}/web/render-host`);
    const status = await new Promise<number>((resolve) => ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(401);
  });

  it("renders through the connected page, and through its replacement after it closes", async () => {
    await runTool(tools.get("newProject")!, {}, { host, source: "test" });
    await runTool(tools.get("addText")!, { text: "Android", start: 0, duration: 2 }, { host, source: "test" });
    const answer = (tag: string) => (msg: { id: number; method: string; params: Record<string, unknown> }, ws: WebSocket) => {
      if (msg.method !== "renderFrames") return;
      for (const out of msg.params.outputs as string[]) fs.writeFileSync(out, tag);
      ws.send(JSON.stringify({ id: msg.id, progress: { frame: 1 } }));
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: { width: msg.params.width, height: msg.params.height, warnings: [] } }));
    };
    const first = await connectPage(answer("first"));
    const r1 = (await runTool(tools.get("captureFrame")!, { timeSeconds: 0.5 }, { host, source: "test" })) as { ok: true; result: { path: string } };
    expect(r1.ok).toBe(true);
    expect(fs.readFileSync(r1.result.path, "utf8")).toBe("first");

    // The WebView reloads (or the app restarts it): the next request waits for the new page.
    first.close();
    await new Promise((r) => setTimeout(r, 100));
    const pending = runTool(tools.get("captureFrame")!, { timeSeconds: 0.5 }, { host, source: "test" }) as Promise<{ ok: true; result: { path: string } }>;
    await new Promise((r) => setTimeout(r, 200));
    const second = await connectPage(answer("second"));
    const r2 = await pending;
    expect(r2.ok).toBe(true);
    expect(fs.readFileSync(r2.result.path, "utf8")).toBe("second");
    second.close();
  });
});
