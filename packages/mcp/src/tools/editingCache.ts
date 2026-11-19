import { z } from "zod";
import { EditError } from "@openedits/core";
import { clearEditingCache, editingCacheStatus, generateEditingProxies, PROXY_JOB_KIND, type JobInfo } from "@openedits/engine";
import { defineTool, type ToolContext } from "../defineTool.js";

function jobView(job: JobInfo) {
  const { id, projectId, status, progress, message, error, result } = job;
  return { jobId: id, projectId, status, progress, message, error, result };
}

function proxyJob(ctx: ToolContext, id: string) {
  const job = ctx.host.jobs.get(id);
  if (job.kind !== PROXY_JOB_KIND) throw new EditError("INVALID_ARGUMENT", `Not an editing proxy job: ${id}`);
  return job;
}

export const editingCacheTools = [
  defineTool({
    name: "editingCacheStatus",
    title: "Editing cache status",
    category: "project",
    description: "Get editing proxy availability and storage used by generated proxies, preview renders, and timeline thumbnails for the open project.",
    input: z.object({}),
    readOnly: true,
    handler: (_a, ctx) => editingCacheStatus(ctx.host),
  }),
  defineTool({
    name: "generateEditingProxies",
    title: "Generate editing proxies",
    category: "project",
    description: "Create low-resolution, short-GOP H.264 proxies for the open project's supported video sources. Returns a jobId. Originals remain the source for exports.",
    input: z.object({ mediaIds: z.array(z.string()).min(1).optional() }),
    handler: (a, ctx) => jobView(generateEditingProxies(ctx.host, a.mediaIds)),
  }),
  defineTool({
    name: "editingProxyStatus",
    title: "Check editing proxies",
    category: "project",
    description: "Get the status of an editing proxy job.",
    input: z.object({ jobId: z.string(), waitSeconds: z.number().min(0).max(30).optional() }),
    readOnly: true,
    handler: async (a, ctx) => {
      const job = proxyJob(ctx, a.jobId);
      return jobView(a.waitSeconds ? await ctx.host.jobs.wait(job.id, a.waitSeconds * 1000) : job);
    },
  }),
  defineTool({
    name: "cancelEditingProxies",
    title: "Cancel editing proxies",
    category: "project",
    description: "Cancel an editing proxy job. Finished proxies remain available.",
    input: z.object({ jobId: z.string() }),
    handler: async (a, ctx) => {
      const job = proxyJob(ctx, a.jobId);
      ctx.host.jobs.cancel(job.id);
      return jobView(await ctx.host.jobs.wait(job.id, 5000));
    },
  }),
  defineTool({
    name: "clearEditingCache",
    title: "Clear editing cache",
    category: "project",
    description: "Remove generated proxies or generated preview renders and timeline thumbnails in the open project. This preserves original media, projects, and exports.",
    input: z.object({ scope: z.enum(["proxies", "previews", "all"]) }),
    handler: (a, ctx) => clearEditingCache(ctx.host, a.scope),
  }),
];
