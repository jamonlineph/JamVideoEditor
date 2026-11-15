import fs from "node:fs";
import os from "node:os";
import { EditError } from "@openedits/core";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Acquire an exclusive project lock. Stale locks (dead pid) are taken over.
 * `token` identifies the holder so the same engine can re-acquire its own lock.
 */
export function acquireLock(file: string, token: string): () => void {
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), token, at: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, body, { flag: "wx" });
      return () => {
        try {
          const cur = JSON.parse(fs.readFileSync(file, "utf8"));
          if (cur.token === token) fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let holder: { pid: number; token: string } | undefined;
      try {
        holder = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        holder = undefined;
      }
      if (holder?.token === token) return () => fs.rmSync(file, { force: true });
      if (holder && alive(holder.pid)) {
        throw new EditError("PROJECT_LOCKED", `Project is open in another OpenEdits engine (pid ${holder.pid})`, { pid: holder.pid });
      }
      fs.rmSync(file, { force: true });
    }
  }
  throw new EditError("PROJECT_LOCKED", "Could not acquire project lock");
}
