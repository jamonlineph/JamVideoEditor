// node:child_process for the browser build. The UI only ever runs ffmpeg (decoding frames for the
// live preview, converting a voiceover take); here that ffmpeg runs beside the engine and its
// output streams back over a WebSocket (/web/spawn).
type Listener = (...args: any[]) => void;

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
  private ws: WebSocket;
  private queue: (string | Uint8Array)[] = [];
  private done = false;
  private paused = false;
  readonly stdout = new Readable((paused) => {
    if (paused === this.paused) return;
    this.paused = paused;
    this.send(JSON.stringify({ pause: paused }));
  });
  readonly stderr = new Readable();
  readonly stdin = {
    write: (data: Uint8Array) => this.send(data),
    end: (data?: Uint8Array) => {
      if (data) this.send(data);
      this.send(JSON.stringify({ endStdin: true }));
    },
    on: () => this.stdin,
  };

  constructor(args: string[]) {
    super();
    const ws = (this.ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/web/spawn`));
    ws.binaryType = "arraybuffer";
    this.queue.push(JSON.stringify({ args }));
    ws.onopen = () => {
      for (const m of this.queue.splice(0)) ws.send(m as string);
    };
    ws.onmessage = (ev) => {
      if (this.done) return;
      if (typeof ev.data !== "string") return this.stdout.emit("data", new Uint8Array(ev.data as ArrayBuffer));
      const msg = JSON.parse(ev.data) as { stderr?: string; close?: number | null; error?: string };
      if (msg.stderr !== undefined) this.stderr.emit("data", msg.stderr);
      else if (msg.error !== undefined) this.finish("error", new Error(msg.error));
      else if ("close" in msg) {
        this.exitCode = msg.close ?? null;
        this.finish("close", msg.close ?? null);
      }
    };
    ws.onerror = () => this.finish("error", new Error("Could not reach the engine to run ffmpeg"));
    ws.onclose = () => this.finish("close", this.exitCode);
  }

  private send(data: string | Uint8Array) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data as string);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(data);
  }

  private finish(event: "close" | "error", arg: unknown) {
    if (this.done) return;
    this.done = true;
    this.emit(event, arg);
  }

  /** The engine kills the process when its socket closes. */
  kill(_signal?: string) {
    this.queue = [];
    this.ws.close();
    return true;
  }
}

export type ChildProcess = RemoteProcess;

export function spawn(_command: string, args: string[], _opts?: unknown): RemoteProcess {
  return new RemoteProcess(args);
}
