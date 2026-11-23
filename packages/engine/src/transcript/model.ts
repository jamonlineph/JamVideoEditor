import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { EditError } from "@openedits/core";
import type { EngineHost } from "../host.js";
import { whisperAvailable } from "./service.js";

const NAME = "ggml-base.bin";
const BYTES = 147_951_465;
const SHA256 = "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe";
const URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";

export async function captionSetup(host: EngineHost, install: boolean) {
  const runtime = await whisperAvailable();
  const model = fs.statSync(host.settings.whisperModelPath, { throwIfNoEntry: false })?.isFile() ?? false;
  let job = host.jobs.latest("captionModel");
  if (install && !model && runtime && job?.status !== "running") {
    job = host.jobs.start("captionModel", async ({ progress, signal }) => {
      const dest = path.join(host.paths.models, NAME);
      const temporary = `${dest}.${randomUUID()}.part`;
      fs.mkdirSync(host.paths.models, { recursive: true });
      try {
        progress(0, "Downloading the local caption model…");
        const transferSignal = AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]);
        const response = await fetch(URL, { signal: transferSignal });
        if (!response.ok || !response.body) throw new EditError("INTERNAL", `Caption model download failed (HTTP ${response.status}).`);
        const hash = createHash("sha256");
        let received = 0;
        let lastUpdate = 0;
        const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > BYTES) return callback(new EditError("INTERNAL", "The caption model download is larger than expected."));
          hash.update(chunk);
          if (Date.now() - lastUpdate >= 250) {
            lastUpdate = Date.now();
            progress(received / BYTES);
          }
          callback(null, chunk);
        } });
        await pipeline(response.body, verify, fs.createWriteStream(temporary, { flags: "wx" }), { signal: transferSignal });
        if (received !== BYTES || hash.digest("hex") !== SHA256) throw new EditError("INTERNAL", "Caption model verification failed.");
        signal.throwIfAborted();
        fs.renameSync(temporary, dest);
        host.updateSettings({ whisperModelPath: dest });
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    });
  }
  return { runtime, model, downloadBytes: BYTES, job };
}
