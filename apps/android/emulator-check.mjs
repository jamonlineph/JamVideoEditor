#!/usr/bin/env node
// Drives the editor running inside the Android app (through `adb forward`) the way its UI does:
// uploads a clip, builds a short edit over /live, renders a frame and a full export with the
// app's own engine, FFmpeg and WebView compositor, and checks the exported file.
//
//   node apps/android/emulator-check.mjs <port> <token> <clip.mp4> <out-dir>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const [port, token, clip, outDir] = process.argv.slice(2);
if (!port || !token || !clip || !outDir) throw new Error("usage: emulator-check.mjs <port> <token> <clip> <out-dir>");
const base = `http://127.0.0.1:${port}`;
const headers = { "x-openedits-token": token };
fs.mkdirSync(outDir, { recursive: true });

const step = (text) => console.log(`--- ${text}`);

step("upload a clip, as the UI's Import button does");
const up = await fetch(`${base}/web/upload?name=${encodeURIComponent(path.basename(clip))}`, { method: "POST", headers, body: fs.readFileSync(clip), signal: AbortSignal.timeout(60_000) });
const uploaded = await up.json();
if (!up.ok || !uploaded.path) throw new Error(`upload failed: ${JSON.stringify(uploaded)}`);
console.log(`uploaded to ${uploaded.path}`);

const ws = new WebSocket(`ws://127.0.0.1:${port}/live?token=${token}`);
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});
let seq = 0;
const waiting = new Map();
ws.on("message", (data) => {
  const msg = JSON.parse(String(data));
  if (msg.type !== "result") return;
  const w = waiting.get(msg.id);
  if (!w) return;
  waiting.delete(msg.id);
  if (msg.ok) w.resolve(msg.result);
  else w.reject(new Error(`${w.tool}: ${JSON.stringify(msg.error)}`));
});
// Every call has a deadline, so a stuck render fails the test (with the app's log) instead of hanging it.
const call = (tool, args = {}, seconds = 180) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`${tool} did not answer within ${seconds}s`));
    }, seconds * 1000);
    waiting.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)), tool });
    ws.send(JSON.stringify({ type: "call", id, tool, args }));
  });

step("new project with the clip, a title and a voiceover");
await call("newProject", { name: "Emulator check", canvas: { aspectRatio: "16:9" } });
const added = await call("addMedia", { path: uploaded.path });
console.log(`clip ${added.elementId}`);
const title = await call("addText", { text: "Made on Android", start: 0, duration: 3 });
console.log(`title ${title.elementId}`);
const voices = await call("ttsVoices", {});
console.log(`${voices.count} text-to-speech voices`);
if (!voices.count) throw new Error("eSpeak NG has no voices");
const tts = await call("applyTextToSpeech", { text: "Made on Android", start: 0.5 });
console.log(`voiceover ${tts.elementId} (${tts.durationSeconds}s)`);

step("render a frame with the WebView compositor");
const frame = await call("captureFrame", { timeSeconds: 1 });
console.log(`frame ${frame.path} ${frame.width}x${frame.height}`);
const got = await fetch(`${base}/web/file?path=${encodeURIComponent(frame.path)}`, { headers });
if (!got.ok) throw new Error(`could not fetch the frame (${got.status})`);
fs.writeFileSync(path.join(outDir, "android-frame.jpg"), Buffer.from(await got.arrayBuffer()));

step("export");
const job = await call("export", {});
console.log(`job ${job.jobId}`);
let status;
for (let i = 0; i < 450; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  status = await call("exportStatus", { jobId: job.jobId });
  if (i % 5 === 0) console.log(`  ${status.status} ${Math.round((status.progress ?? 0) * 100)}% ${status.message ?? ""}`);
  if (status.status !== "running" && status.status !== "queued") break;
}
if (status.status !== "done") throw new Error(`export ended ${status.status}: ${JSON.stringify(status)}`);
console.log(`exported ${status.output.path} (${status.output.frames} frames, ${status.output.sizeBytes} bytes, ${status.output.renderSeconds}s)`);
const video = await fetch(`${base}/web/file?path=${encodeURIComponent(status.output.path)}`, { headers });
const file = path.join(outDir, "android-export.mp4");
fs.writeFileSync(file, Buffer.from(await video.arrayBuffer()));
const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,nb_frames", "-of", "compact", file], { encoding: "utf8" });
console.log(probe.trim());
if (!/codec_type=video/.test(probe) || !/codec_type=audio/.test(probe)) throw new Error("the export is missing its video or audio");

ws.close();
console.log("android editor OK");
process.exit(0);
