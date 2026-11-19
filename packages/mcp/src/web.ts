import { spawn } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * Browser mode (`openedits serve --web`): the editor's UI is served over loopback HTTP instead of
 * running in an Electron window. Used where there is no desktop to open a window on but a browser
 * can reach the machine's localhost: a Googlebook's Linux Terminal, a headless box behind an SSH
 * tunnel. The page is the same UI; the things it did with Node (running ffmpeg to decode frames,
 * reading and writing files) go through the endpoints here instead.
 */
export interface WebOptions {
  /** Folder with the built browser UI (index.html, app.js, …). */
  root: string;
  workspace: string;
  ffmpeg: string;
  token: string;
  /** Checks Host, Origin and the token (header, query or cookie). */
  authorized: (req: http.IncomingMessage, url: URL) => boolean;
}

export const WEB_COOKIE = "openedits_token";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const SIGN_IN_PAGE = `<!doctype html><meta charset="utf-8"><title>OpenEdits Studio</title>
<body style="font:16px system-ui;background:#0d0e11;color:#e9ebef;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:520px;padding:24px;line-height:1.5"><h2>OpenEdits Studio</h2>
<p>This browser is not signed in to the editor yet. Open the full link that the Terminal printed when you started
<code>openedits-web</code> (it ends in <code>?token=…</code>). You only need to do that once per browser.</p></div>`;

export function createWeb(opts: WebOptions) {
  const uploads = path.join(opts.workspace, "uploads");
  const inWorkspace = (p: string) => {
    const rel = path.relative(opts.workspace, path.resolve(p));
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, extra: Record<string, string> = {}) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
      if (!stat.isFile()) throw new Error("not a file");
    } catch {
      return json(res, 404, { error: "not found" });
    }
    const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const headers: Record<string, string | number> = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-cache", ...extra };
    // Range requests: <audio> and <video> seek with them.
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    let start = 0;
    let end = stat.size - 1;
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1]);
        if (m[2]) end = Math.min(end, Number(m[2]));
      } else start = Math.max(0, stat.size - Number(m[2]));
      if (start > end || start >= stat.size) {
        res.writeHead(416, { "content-range": `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${stat.size}`, "content-length": end - start + 1 });
    } else res.writeHead(200, { ...headers, "content-length": stat.size });
    if (req.method === "HEAD" || stat.size === 0) return res.end();
    fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
  }

  const readJson = async (req: http.IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
  };

  /** Returns false when the request is not for browser mode (the caller answers it). */
  async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (p === "/" || p === "/index.html") {
      if (url.searchParams.has("token")) {
        if (!opts.authorized(req, url)) {
          res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
          res.end(SIGN_IN_PAGE);
          return true;
        }
        // Keep the token out of the address bar and history: remember it in a cookie instead.
        res.writeHead(302, { location: "/", "set-cookie": `${WEB_COOKIE}=${opts.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` });
        res.end();
        return true;
      }
      if (!opts.authorized(req, url)) {
        res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
        res.end(SIGN_IN_PAGE);
        return true;
      }
      sendFile(req, res, path.join(opts.root, "index.html"));
      return true;
    }
    if (!p.startsWith("/web/")) {
      // The UI's own files (no secrets in them, and the install prompt fetches some without cookies).
      const file = path.join(opts.root, path.normalize(p).replace(/^[/\\]+/, ""));
      if (req.method !== "GET" || !file.startsWith(opts.root + path.sep) || !fs.existsSync(file)) return false;
      sendFile(req, res, file);
      return true;
    }
    if (!opts.authorized(req, url)) {
      json(res, 401, { error: "unauthorized" });
      return true;
    }
    if (p === "/web/mcp-connection" && req.method === "POST") {
      const port = req.socket.localPort;
      json(res, 200, {
        port,
        config: { mcpServers: { jamvideoeditor: {
          serverUrl: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: `Bearer ${opts.token}` },
        } } },
      });
      return true;
    }
    if (p === "/web/config.js" && req.method === "GET") {
      res.writeHead(200, { "content-type": TYPES[".js"], "cache-control": "no-store" });
      res.end(`window.__openedits = ${JSON.stringify({ workspace: opts.workspace, home: os.homedir(), android: process.env.OPENEDITS_ANDROID === "1" })};\n`);
      return true;
    }
    if (p === "/web/file" && (req.method === "GET" || req.method === "HEAD")) {
      const file = url.searchParams.get("path") ?? "";
      if (!path.isAbsolute(file)) json(res, 400, { error: "path must be absolute" });
      else sendFile(req, res, file, url.searchParams.has("download") ? { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` } : {});
      return true;
    }
    if (p === "/web/fs" && req.method === "POST") {
      const body = await readJson(req);
      const file = String(body.path ?? "");
      if (!path.isAbsolute(file)) return json(res, 400, { error: "path must be absolute" }), true;
      try {
        if (body.op === "exists") json(res, 200, { result: fs.existsSync(file) });
        else if (body.op === "readdir") json(res, 200, { result: fs.readdirSync(file) });
        else if (body.op === "readText") json(res, 200, { result: fs.readFileSync(file, "utf8") });
        else if (!inWorkspace(file)) json(res, 403, { error: "The browser can only change files inside the workspace" });
        else if (body.op === "mkdir") json(res, 200, { result: fs.mkdirSync(file, { recursive: true }) ?? null });
        else if (body.op === "rm") json(res, 200, { result: (fs.rmSync(file, { force: true }), null) });
        else json(res, 400, { error: "unknown op" });
      } catch (e) {
        json(res, 500, { error: (e as Error).message, code: (e as NodeJS.ErrnoException).code });
      }
      return true;
    }
    if (p === "/web/write" && req.method === "PUT") {
      const file = url.searchParams.get("path") ?? "";
      if (!path.isAbsolute(file) || !inWorkspace(file)) return json(res, 403, { error: "The browser can only write files inside the workspace" }), true;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await pipeline(req, fs.createWriteStream(file));
        json(res, 200, { result: null });
      } catch (e) {
        json(res, 500, { error: (e as Error).message });
      }
      return true;
    }
    if (p === "/web/upload" && req.method === "POST") {
      // Files picked or dropped in the browser land in <workspace>/uploads; the editor imports them from there.
      const wanted = path.basename(url.searchParams.get("name") ?? "upload").replace(/[\0/\\]/g, "_") || "upload";
      fs.mkdirSync(uploads, { recursive: true });
      const ext = path.extname(wanted);
      let file = path.join(uploads, wanted);
      for (let n = 2; fs.existsSync(file); n++) file = path.join(uploads, `${path.basename(wanted, ext)} (${n})${ext}`);
      try {
        await pipeline(req, fs.createWriteStream(file));
        json(res, 200, { path: file });
      } catch (e) {
        fs.rmSync(file, { force: true });
        if (!res.headersSent) json(res, 500, { error: (e as Error).message });
      }
      return true;
    }
    json(res, 404, { error: "not found" });
    return true;
  }

  // ---- /web/spawn: the page's ffmpeg processes (frame decoding for the live preview, converting a
  // voiceover take). Output is streamed back as binary messages; the page can pause and resume it.
  // Keep this in sync with the browser's stdin chunk size.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 4 * 1024 * 1024 });
  wss.on("connection", (ws: WebSocket) => {
    let proc: ReturnType<typeof spawn> | null = null;
    let pausedByClient = false;
    let pausedBySocket = false;
    let stdinBusy = false;
    let stdinEnded = false;
    const text = (msg: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    const fail = (error: string) => {
      if (ws.readyState !== ws.OPEN) return;
      text({ error });
      proc?.kill("SIGKILL");
      ws.close();
    };
    const flow = () => {
      if (!proc?.stdout) return;
      if (pausedByClient || pausedBySocket) proc.stdout.pause();
      else proc.stdout.resume();
    };
    ws.on("error", () => ws.terminate());
    ws.on("close", () => {
      if (proc && proc.exitCode === null) proc.kill("SIGKILL");
    });
    ws.on("message", (data, isBinary) => {
      if (ws.readyState !== ws.OPEN) return;
      if (isBinary) {
        if (!proc?.stdin || stdinBusy || stdinEnded) return fail("FFmpeg input arrived before it was ready");
        stdinBusy = true;
        proc.stdin.write(data as Buffer, (error) => {
          stdinBusy = false;
          if (error) fail(error.message);
          else text({ stdinReady: true });
        });
        return;
      }
      let msg: { args?: unknown; pause?: boolean; endStdin?: boolean };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.pause !== undefined) {
        pausedByClient = msg.pause;
        return flow();
      }
      if (msg.endStdin) {
        if (!proc?.stdin || stdinBusy || stdinEnded) return fail("FFmpeg input was closed before the last write completed");
        stdinEnded = true;
        return void proc.stdin.end();
      }
      if (proc || !Array.isArray(msg.args) || !msg.args.every((a) => typeof a === "string")) return;
      // Only ever ffmpeg, whatever the page asked to run.
      const child = spawn(opts.ffmpeg, msg.args as string[], { stdio: ["pipe", "pipe", "pipe"] });
      proc = child;
      child.stdin!.on("error", () => {});
      child.stdout!.on("data", (d: Buffer) => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(d, { binary: true }, () => {
          if (pausedBySocket && ws.bufferedAmount < 1024 * 1024) {
            pausedBySocket = false;
            flow();
          }
        });
        if (ws.bufferedAmount > 4 * 1024 * 1024) {
          pausedBySocket = true;
          flow();
        }
      });
      child.stderr!.on("data", (d: Buffer) => text({ stderr: d.toString() }));
      child.on("error", (e) => {
        text({ error: e.message });
        ws.close();
      });
      child.on("close", (code) => {
        // Everything queued goes out before the close frame.
        text({ close: code });
        ws.close();
      });
    });
  });

  function upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean {
    if (url.pathname !== "/web/spawn") return false;
    if (!opts.authorized(req, url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    return true;
  }

  return {
    handle,
    upgrade,
    close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
    },
  };
}
