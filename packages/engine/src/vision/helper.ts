import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { EditError } from "@openedits/core";

const execFileAsync = promisify(execFile);

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Detection {
  box: Box;
  confidence: number;
}

/** The compiled Apple Vision helper (built from packages/engine/native/vision.swift). */
export function visionHelperPath(): string {
  if (process.env.OPENEDITS_VISION) return process.env.OPENEDITS_VISION;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.resolve(here, "../../bin/openedits-vision"), path.resolve(here, "../bin/openedits-vision")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new EditError("NOT_IMPLEMENTED", "The Apple Vision helper is not built (run npm run build on macOS with Xcode command line tools)");
}

async function run<T>(command: string, file: string, options: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const args = [command, file, ...Object.entries(options).flatMap(([k, v]) => [`--${k}`, v])];
  try {
    const { stdout } = await execFileAsync(visionHelperPath(), args, { maxBuffer: 64 * 1024 * 1024, signal });
    return JSON.parse(stdout) as T;
  } catch (e) {
    if (signal?.aborted) throw new EditError("INTERNAL", "Cancelled");
    const stderr = (e as { stderr?: string }).stderr ?? "";
    const message = /"error":"([^"]+)"/.exec(stderr)?.[1] ?? (e as Error).message.split("\n")[0];
    throw new EditError("INTERNAL", `Vision: ${message}`);
  }
}

const times = (t: number[]) => t.map((x) => x.toFixed(4)).join(",");

export function visionSubjects(file: string, t: number[], signal?: AbortSignal) {
  return run<{ frames: { time: number; faces?: Detection[]; people?: Detection[]; error?: string }[] }>("subjects", file, { times: times(t) }, signal);
}

export function visionSaliency(file: string, t: number[], signal?: AbortSignal) {
  return run<{ frames: { time: number; objects?: Detection[]; error?: string }[] }>("saliency", file, { times: times(t) }, signal);
}

export function visionTrack(file: string, start: Box, t: number[], signal?: AbortSignal) {
  return run<{ frames: { time: number; box?: Box; confidence?: number; error?: string }[]; lost: boolean }>("track", file, { box: [start.x, start.y, start.w, start.h].join(","), times: times(t) }, signal);
}

export function visionCutout(file: string, time: number, out: string, opts: { kind?: "person" | "subject"; point?: [number, number] } = {}) {
  return run<{ path: string; width: number; height: number; box?: Box; instances: number }>("cutout", file, {
    time: time.toFixed(4),
    out,
    kind: opts.kind ?? "subject",
    ...(opts.point ? { point: opts.point.join(",") } : {}),
  });
}

/** Stream 8-bit subject masks (width*height bytes per time) into a sink. */
export function visionMasks(file: string, t: number[], width: number, height: number, kind: "person" | "subject", onMask: (mask: Buffer, index: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(visionHelperPath(), ["masks", file, "--times", times(t), "--width", String(width), "--height", String(height), "--kind", kind], { stdio: ["ignore", "pipe", "pipe"] });
    const size = width * height;
    let pending: Buffer = Buffer.alloc(0);
    let index = 0;
    let stderr = "";
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (d: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, d]) : Buffer.from(d);
      while (pending.length >= size) {
        onMask(pending.subarray(0, size), index++);
        pending = pending.subarray(size);
      }
    });
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(new EditError("INTERNAL", "Cancelled"));
      if (code !== 0) return reject(new EditError("INTERNAL", `Vision masks failed: ${/"error":"([^"]+)"/.exec(stderr)?.[1] ?? stderr.trim()}`));
      resolve();
    });
  });
}
