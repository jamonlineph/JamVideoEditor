// node:child_process for the browser build. The UI only ever runs ffmpeg (decoding frames for the
// live preview, converting a voiceover take); here that ffmpeg runs beside the engine and its
// output streams back over a WebSocket (/web/spawn).
type Listener = (...args: any[]) => void;
// Keep this in sync with the /web/spawn payload limit.
const INPUT_CHUNK_BYTES = 4 * 1024 * 1024;

class Emitter {
  private listeners = new Map<string, Listener[]>();
  on(event: string, fn: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }
}

class Readable extends Emitter {
  constructor(private flow?: (paused: boolean) => void) {
    super();
  }
  pause() {
    this.flow?.(true);
  }
  resume() {
    this.flow?.(false);
  }
}

class RemoteProcess extends Emitter {
  exitCode: number | null = null;
  private readonly ws: WebSocket;
  private pendingInput?: { data: Uint8Array<ArrayBuffer>; offset: number; done?: (err?: Error | null) => void };
  private ending = false;
  private ended = false;
  private done = false;
  private paused = false;
  readonly stdout = new Readable((paused) => {
    if (paused === this.paused) return;
    this.paused = paused;
    this.send(JSON.stringify({ pause: paused }));
  });
  readonly stderr = new Readable();
  readonly stdin = {
    // One frame in flight, split into chunks. Each chunk waits for FFmpeg's stdin write.
    write: (data: Uint8Array<ArrayBuffer>, done?: (err?: Error | null) => void) => this.writeInput(data, done),
    end: (data?: Uint8Array<ArrayBuffer>) => {
      if (data) this.writeInput(data);
      this.ending = true;
      if (!this.pendingInput) this.endInput();
    },
    on: () => this.stdin,
  };

  private writeInput(data: Uint8Array<ArrayBuffer>, done?: (err?: Error | null) => void) {
    if (this.pendingInput || this.ending || this.ws.readyState >= WebSocket.CLOSING) {
      const error = new Error("FFmpeg is not ready for a new input buffer");
      if (done) queueMicrotask(() => done(error));
      else this.finish("error", error);
      return false;
    }
    this.pendingInput = { data, offset: 0, done };
    this.pumpInput();
    return false;
  }

  private pumpInput() {
    const input = this.pendingInput;
    if (!input || this.ws.readyState !== WebSocket.OPEN) return;
    if (input.offset === input.data.byteLength) {
      this.pendingInput = undefined;
      input.done?.(null);
      if (this.ending) this.endInput();
      return;
    }
    const end = Math.min(input.offset + INPUT_CHUNK_BYTES, input.data.byteLength);
    this.ws.send(input.data.subarray(input.offset, end));
    input.offset = end;
  }

  private endInput() {
    if (this.ended || this.ws.readyState !== WebSocket.OPEN) return;
    this.ended = true;
    this.send(JSON.stringify({ endStdin: true }));
  }

  constructor(args: string[]) {
    super();
    const ws = (this.ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/web/spawn`));
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.send(JSON.stringify({ args }));
      if (this.paused) this.send(JSON.stringify({ pause: true }));
      if (this.pendingInput) this.pumpInput();
      else if (this.ending) this.endInput();
    };
    ws.onmessage = (ev) => {
      if (this.done) return;
      if (typeof ev.data !== "string") return this.stdout.emit("data", new Uint8Array(ev.data as ArrayBuffer));
      const msg = JSON.parse(ev.data) as { stderr?: string; close?: number | null; error?: string; stdinReady?: boolean };
      if (msg.stderr !== undefined) this.stderr.emit("data", msg.stderr);
      else if (msg.stdinReady) this.pumpInput();
      else if (msg.error !== undefined) this.finish("error", new Error(msg.error));
      else if ("close" in msg) {
        this.exitCode = msg.close ?? null;
        this.finish("close", msg.close ?? null);
      }
    };
    ws.onerror = () => this.finish("error", new Error("Could not reach the engine to run ffmpeg"));
    ws.onclose = () => this.finish("close", this.exitCode);
  }

  private send(data: string) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  private finish(event: "close" | "error", arg: unknown) {
    if (this.done) return;
    this.done = true;
    const input = this.pendingInput;
    this.pendingInput = undefined;
    input?.done?.(arg instanceof Error ? arg : new Error("FFmpeg stopped writing"));
    if (event === "error") this.ws.close();
    this.emit(event, arg);
  }

  /** The engine kills the process when its socket closes. */
  kill(_signal?: string) {
    this.ws.close();
    return true;
  }
}

export type ChildProcess = RemoteProcess;

export function spawn(_command: string, args: string[], _opts?: unknown): RemoteProcess {
  return new RemoteProcess(args);
}
