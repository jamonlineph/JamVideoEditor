#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AutopilotWatcher, EngineHost, autoEditFiles, loadSettings, resolveWorkspace } from "@openedits/engine";
import { createMcpServer } from "./server.js";
import { findRunningEngine, startHttpServer, type HttpServerHandle } from "./http.js";
import { runStdioProxy } from "./proxy.js";
import { connectClient, unwrap } from "./client.js";
import { allTools, PLANNED_TOOLS, VERSION } from "./registry.js";

const log = (msg: string) => process.stderr.write(`[openedits] ${msg}\n`);

const USAGE = `OpenEdits Studio ${VERSION}

  openedits serve [--port N] [--autopilot]   run the engine (HTTP MCP at /mcp, live WebSocket at /live)
  openedits mcp [--no-http]        stdio MCP server for AI clients (joins a running engine, or hosts one)
  openedits call <tool> [json]     call one tool and print the result
  openedits repl                   interactive: <tool> <json>
  openedits tools [--json]         list tools (and tools planned for later phases)
  openedits auto-edit FILE... [--render final|preview|none] [--name NAME]
                                   hands-free: new project, STYLE.md first pass, render to the outbox
  openedits autopilot [--render final|preview|none]
                                   watch ~/Movies/OpenEdits/auto-edit and auto-edit every dropped video
  openedits doctor                 check ffmpeg, ffprobe, whisper.cpp and the model
  openedits mcp-config             print setup snippets for Claude Code and other clients

  --workspace DIR                  use another workspace (default ~/Movies/OpenEdits, or $OPENEDITS_WORKSPACE)`;

function takeFlag(args: string[], flag: string): boolean {
  const i = args.indexOf(flag);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function takeOption(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

async function startHttpWithFallback(host: EngineHost, preferred: number): Promise<HttpServerHandle> {
  try {
    return await startHttpServer(host, { port: preferred });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    log(`port ${preferred} is busy; using a random port`);
    return startHttpServer(host, { port: 0 });
  }
}

async function cmdServe(args: string[]) {
  const existing = await findRunningEngine(resolveWorkspace().engineFile);
  if (existing) {
    log(`an engine is already running for this workspace (pid ${existing.pid}, port ${existing.port})`);
    process.exit(1);
  }
  const host = EngineHost.create();
  const port = Number(takeOption(args, "--port") ?? host.settings.httpPort);
  const withAutopilot = takeFlag(args, "--autopilot");
  const http = await startHttpWithFallback(host, port);
  log(`engine ready: http://127.0.0.1:${http.port}/mcp  (workspace ${host.paths.root})`);
  log(`token in ${host.paths.engineFile}`);
  const watcher = withAutopilot ? new AutopilotWatcher({ workspaceRoot: host.paths.root, log }) : null;
  if (watcher) {
    watcher.start();
    log(`autopilot watching ${watcher.paths.autoEdit}`);
  }
  const stop = async () => {
    watcher?.stop();
    await http.close();
    host.dispose();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function cmdMcp(args: string[]) {
  const noHttp = takeFlag(args, "--no-http");
  const running = await findRunningEngine(resolveWorkspace().engineFile);
  if (running) {
    log(`joining running engine (pid ${running.pid}, port ${running.port})`);
    await runStdioProxy(running, log);
    process.exit(0);
  }
  const host = EngineHost.create();
  const server = createMcpServer(host);
  let http: HttpServerHandle | undefined;
  if (!noHttp) {
    try {
      http = await startHttpWithFallback(host, host.settings.httpPort);
      log(`hosting engine; other clients can join at http://127.0.0.1:${http.port}/mcp`);
    } catch (e) {
      log(`HTTP disabled: ${(e as Error).message}`);
    }
  }
  const transport = new StdioServerTransport();
  let done = false;
  const shutdown = async () => {
    if (done) return;
    done = true;
    await http?.close().catch(() => {});
    host.dispose();
    process.exit(0);
  };
  transport.onclose = () => void shutdown();
  process.stdin.on("end", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await server.connect(transport);
}

async function cmdCall(args: string[]) {
  const [tool, json] = args;
  if (!tool) throw new Error("usage: openedits call <tool> [json]");
  const input = json ? JSON.parse(json) : {};
  const c = await connectClient();
  try {
    const r = unwrap(await c.client.callTool({ name: tool, arguments: input }));
    process.stdout.write(JSON.stringify(r.value, null, 2) + "\n");
    process.exitCode = r.ok ? 0 : 1;
  } finally {
    await c.close();
  }
}

async function cmdRepl() {
  const c = await connectClient("openedits-repl");
  log(`connected (${c.mode}). Type: <tool> <json>   e.g. appState {}   ("exit" to quit)`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "openedits> " });
  rl.prompt();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "exit" || trimmed === "quit") break;
    if (trimmed) {
      const sp = trimmed.indexOf(" ");
      const name = sp < 0 ? trimmed : trimmed.slice(0, sp);
      const rest = sp < 0 ? "" : trimmed.slice(sp + 1).trim();
      try {
        const r = unwrap(await c.client.callTool({ name, arguments: rest ? JSON.parse(rest) : {} }));
        console.log(JSON.stringify(r.value, null, 2));
      } catch (e) {
        console.log(`error: ${(e as Error).message}`);
      }
    }
    rl.prompt();
  }
  rl.close();
  await c.close();
}

function cmdTools(args: string[]) {
  const asJson = takeFlag(args, "--json");
  const tools = allTools();
  if (asJson) {
    process.stdout.write(JSON.stringify({ tools: tools.map((t) => ({ name: t.name, category: t.category, description: t.description, readOnly: !!t.readOnly })), planned: PLANNED_TOOLS }, null, 2) + "\n");
    return;
  }
  const byCat = new Map<string, string[]>();
  for (const t of tools) byCat.set(t.category, [...(byCat.get(t.category) ?? []), t.name]);
  console.log(`${tools.length} tools`);
  for (const [cat, names] of byCat) console.log(`  ${cat.padEnd(10)} ${names.join(", ")}`);
  console.log(`\nPlanned (${PLANNED_TOOLS.length}):`);
  for (const ph of [3, 4, 5]) {
    const names = PLANNED_TOOLS.filter((p) => p.phase === ph).map((p) => p.name);
    if (names.length) console.log(`  phase ${ph}   ${names.join(", ")}`);
  }
}

function renderOption(args: string[]): "final" | "preview" | "none" {
  const r = takeOption(args, "--render") ?? "final";
  if (r !== "final" && r !== "preview" && r !== "none") throw new Error("--render must be final, preview or none");
  return r;
}

async function cmdAutoEdit(args: string[]) {
  const render = renderOption(args);
  const name = takeOption(args, "--name");
  if (!args.length) throw new Error("usage: openedits auto-edit FILE... [--render final|preview|none] [--name NAME]");
  const job = await autoEditFiles(args, { render, name, onStep: (s) => log(s) });
  process.stdout.write(JSON.stringify(job, null, 2) + "\n");
  process.exitCode = job.status === "done" ? 0 : 1;
}

async function cmdAutopilot(args: string[]) {
  const watcher = new AutopilotWatcher({ render: renderOption(args), log });
  watcher.start();
  log(`watching ${watcher.paths.autoEdit} (drop videos there; Ctrl+C to stop)`);
  await new Promise<void>((resolve) => {
    process.on("SIGINT", resolve);
    process.on("SIGTERM", resolve);
  });
  watcher.stop();
}

function version(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\n")[0].trim();
  } catch (e) {
    const out = (e as { stdout?: string; stderr?: string }).stdout || (e as { stderr?: string }).stderr;
    return out ? String(out).split("\n")[0].trim() || "installed" : null;
  }
}

async function cmdDoctor() {
  const paths = resolveWorkspace();
  const settings = loadSettings(paths);
  const checks: [string, string | null, string][] = [
    ["node", process.version, "Node 22+"],
    ["ffmpeg", version("ffmpeg", ["-version"]), "brew install ffmpeg"],
    ["ffprobe", version("ffprobe", ["-version"]), "brew install ffmpeg"],
    ["whisper-cli", fs.existsSync("/opt/homebrew/bin/whisper-cli") || version("which", ["whisper-cli"]) ? "installed" : null, "brew install whisper-cpp (Phase 4)"],
    ["whisper model", fs.existsSync(settings.whisperModelPath) ? settings.whisperModelPath : null, `expected at ${settings.whisperModelPath}`],
  ];
  for (const [name, value, fix] of checks) console.log(`${value ? "ok  " : "MISS"} ${name.padEnd(14)} ${value ?? fix}`);
  console.log(`     workspace      ${paths.root}${fs.existsSync(paths.root) ? "" : " (created on first run)"}`);
  const running = await findRunningEngine(paths.engineFile);
  console.log(`     engine         ${running ? `running (pid ${running.pid}, port ${running.port})` : "not running"}`);
}

function cmdMcpConfig() {
  const cli = fileURLToPath(import.meta.url);
  const node = process.execPath;
  console.log("Claude Code:");
  console.log(`  claude mcp add openedits -- ${node} ${cli} mcp\n`);
  console.log("JSON (Claude Desktop / other clients):");
  console.log(JSON.stringify({ mcpServers: { openedits: { command: node, args: [cli, "mcp"] } } }, null, 2));
  console.log(`\nWith a running engine (openedits serve), clients can also connect over HTTP at http://127.0.0.1:<port>/mcp`);
  console.log(`using the bearer token in ${resolveWorkspace().engineFile}.`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const ws = takeOption(args, "--workspace");
  if (ws) process.env.OPENEDITS_WORKSPACE = path.resolve(ws);
  const cmd = args.shift();
  switch (cmd) {
    case "serve":
      return cmdServe(args);
    case "mcp":
      return cmdMcp(args);
    case "call":
      return cmdCall(args);
    case "repl":
      return cmdRepl();
    case "tools":
      return cmdTools(args);
    case "auto-edit":
      return cmdAutoEdit(args);
    case "autopilot":
      return cmdAutopilot(args);
    case "doctor":
      return cmdDoctor();
    case "mcp-config":
      return cmdMcpConfig();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

const invokedDirectly = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? "") === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((e) => {
    log((e as Error).message);
    process.exit(1);
  });
}
