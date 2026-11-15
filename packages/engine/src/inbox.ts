import fs from "node:fs";
import path from "node:path";
import { mediaKindFromExt, type Prober, type ProbeResult } from "./media/probe.js";

export interface InboxFile {
  name: string;
  path: string;
  kind: "video" | "audio" | "image";
  sizeBytes: number;
  modifiedAt: number;
  probe?: ProbeResult;
  probeError?: string;
}

/** List media files in a watch folder (non-recursive, hidden files skipped). */
export async function listMediaFolder(dir: string, opts: { probe?: Prober } = {}): Promise<InboxFile[]> {
  if (!fs.existsSync(dir)) return [];
  const out: InboxFile[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const kind = mediaKindFromExt(name);
    if (!kind) continue;
    const st = fs.statSync(full);
    if (!st.isFile()) continue;
    const file: InboxFile = { name, path: full, kind, sizeBytes: st.size, modifiedAt: st.mtimeMs };
    if (opts.probe) {
      try {
        file.probe = await opts.probe(full);
      } catch (e) {
        file.probeError = (e as Error).message;
      }
    }
    out.push(file);
  }
  return out;
}
