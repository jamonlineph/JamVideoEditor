import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Drives the real desktop app (hidden window) over the Node IPC test channel: evaluate script in
 * the page, capture the window, quit. The app spawns its own engine for the given workspace.
 */
export class AppHarness {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  port = 0;

  private constructor(private child: ChildProcess, readonly workspace: string) {
    child.on("message", (m: { id?: number; ok?: boolean; result?: unknown; error?: string }) => {
      const p = m.id !== undefined ? this.pending.get(m.id) : undefined;
      if (!p) return;
      this.pending.delete(m.id!);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error));
    });
  }

  static async launch(workspace: string): Promise<AppHarness> {
    // The real Electron binary (not the node wrapper in .bin) so the IPC channel reaches the app.
    const electron = createRequire(path.join(ROOT, "package.json"))("electron") as string;
    // Chromium refuses to start as root with its sandbox on (containers, CI).
    const flags = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];
    const child = spawn(electron, [path.join(ROOT, "apps/desktop"), ...flags], {
      env: { ...process.env, OPENEDITS_UI_TEST: "1", OPENEDITS_WORKSPACE: workspace, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const app = new AppHarness(child, workspace);
    app.port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The app did not start")), 45_000);
      child.on("message", (m: { ready?: boolean; port?: number }) => {
        if (m.ready) {
          clearTimeout(timer);
          resolve(m.port!);
        }
      });
      child.on("exit", (code) => reject(new Error(`The app exited (${code})`)));
    });
    return app;
  }

  private send<T>(op: string, extra: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.child.send({ id, op, ...extra });
    });
  }

  /** Evaluate an expression (or a promise) in the page. */
  eval<T = unknown>(code: string): Promise<T> {
    return this.send<T>("eval", { code });
  }

  /** Call a tool as the UI does (same handlers agents use, source "ui"). */
  call<T = Record<string, unknown>>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.eval<T>(`window.openedits.live.call(${JSON.stringify(tool)}, ${JSON.stringify(args)})`);
  }

  /** Resize the window's content area (phone and tablet layouts). */
  resize(width: number, height: number) {
    return this.send<[number, number]>("resize", { width, height });
  }

  capture(file: string) {
    return this.send<{ width: number; height: number }>("capture", { path: file });
  }

  /** Poll a page expression until it is truthy. */
  async waitFor<T = unknown>(code: string, timeoutMs = 10_000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const v = await this.eval<T>(code);
      if (v) return v;
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${code}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async quit() {
    const exited = new Promise<void>((r) => (this.child.exitCode !== null ? r() : this.child.once("exit", () => r())));
    await this.send("quit").catch(() => {});
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }
}

/** An MCP agent connected to the engine the app started (over Streamable HTTP, like Claude Code). */
export async function connectAgent(workspace: string, name = "test-agent") {
  const info = JSON.parse(fs.readFileSync(path.join(workspace, ".engine.json"), "utf8")) as { port: number; token: string };
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${info.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${info.token}` } } }));
  const call = async <T = Record<string, unknown>>(tool: string, args: Record<string, unknown> = {}): Promise<T> => {
    const r = (await client.callTool({ name: tool, arguments: args })) as { structuredContent?: T; content?: { text?: string }[]; isError?: boolean };
    if (r.isError) throw new Error(r.content?.[0]?.text ?? `${tool} failed`);
    return (r.structuredContent ?? JSON.parse(r.content?.[0]?.text ?? "{}")) as T;
  };
  return { call, close: () => client.close() };
}

/** Script that sets a React-controlled range input and releases it (one committed gesture). */
export function setSlider(label: string, value: number) {
  return `(() => {
    const field = [...document.querySelectorAll(".inspector .field")].find((f) => f.querySelector("label")?.textContent?.trim() === ${JSON.stringify(label)});
    const input = field?.querySelector('input[type="range"]');
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, String(${value}));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    return true;
  })()`;
}

/** Script that clicks the first button whose text matches. */
export function clickButton(text: string, scope = "body") {
  return `(() => {
    const b = [...document.querySelectorAll(${JSON.stringify(scope + " button")})].find((x) => x.textContent?.trim() === ${JSON.stringify(text)});
    b?.click();
    return !!b;
  })()`;
}
