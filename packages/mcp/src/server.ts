import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { EditError } from "@openedits/core";
import type { EngineHost } from "@openedits/engine";
import { IMAGES_KEY, type ToolContext, type ToolDef, type ToolImage } from "./defineTool.js";
import { allTools, VERSION } from "./registry.js";

export const SERVER_INSTRUCTIONS = `OpenEdits Studio edits video projects that a human may be editing live in the desktop app at the same time.

Conventions: timeline times are seconds; source times end in *SourceSeconds; canvas positions are normalized 0..1 (origin top-left, +y down) and refer to element centers; rotation is degrees clockwise; colors are #RRGGBB[AA]; volume is linear gain 0..10 (1 = 0 dB).

Workflow:
1. getCapabilities, then get_style_guide (the creator's rules - follow them).
2. list_inbox -> create_project (or projects/openProject).
3. Inspect with appState, clips, elements, getElement, tracks.
4. Edit. Every mutating call is one undo step; pass expectedVersion to avoid clobbering concurrent UI edits. Use saveRevision before big passes; revert to roll back.
5. Elements default to the current selection when elementId is omitted.`;

/** Execute a tool with uniform result/error shaping (shared by MCP, CLI and the UI bridge). */
export async function runTool(tool: ToolDef, args: unknown, ctx: ToolContext): Promise<{ ok: true; result: unknown } | { ok: false; error: Record<string, unknown> }> {
  try {
    const parsed = tool.input.parse(args ?? {});
    const result = await tool.handler(parsed, ctx);
    return { ok: true, result };
  } catch (e) {
    if (e instanceof EditError) return { ok: false, error: e.toJSON() };
    if (e && typeof e === "object" && "issues" in e) {
      const issues = (e as { issues: { path: PropertyKey[]; message: string }[] }).issues;
      return { ok: false, error: { code: "INVALID_ARGUMENT", message: issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ") } };
    }
    return { ok: false, error: { code: "INTERNAL", message: (e as Error)?.message ?? String(e) } };
  }
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function toCallResult(r: Awaited<ReturnType<typeof runTool>>): CallToolResult {
  if (!r.ok) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: r.error }) }] };
  const value = r.result ?? { ok: true };
  const { [IMAGES_KEY]: images, ...structured } = (typeof value === "object" && !Array.isArray(value) ? value : { result: value }) as Record<string, unknown>;
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(structured) }];
  for (const img of (images as ToolImage[] | undefined) ?? []) {
    try {
      if (fs.statSync(img.path).size <= MAX_IMAGE_BYTES) content.push({ type: "image", data: fs.readFileSync(img.path).toString("base64"), mimeType: img.mimeType });
    } catch {
      /* the path is still in the JSON result */
    }
  }
  return { content, structuredContent: structured };
}

/** Build an MCP server bound to an engine. One server per client connection; all share the engine. */
export function createMcpServer(host: EngineHost, opts: { source?: string } = {}): McpServer {
  const server = new McpServer({ name: "openedits", title: "OpenEdits Studio", version: VERSION }, { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } });
  const sourceFor = () => opts.source ?? `mcp:${server.server.getClientVersion()?.name ?? "client"}`;
  for (const tool of allTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: !!tool.readOnly,
          destructiveHint: !!tool.destructive,
          idempotentHint: !!tool.readOnly || !!tool.idempotent,
          openWorldHint: false,
        },
      },
      async (args: unknown) => toCallResult(await runTool(tool, args, { host, source: sourceFor() })),
    );
  }
  return server;
}
