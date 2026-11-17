// Injected into the browser build: the few Node globals the shared UI code touches.
export const process = { platform: "linux", env: { OPENEDITS_FFMPEG: "ffmpeg" } as Record<string, string | undefined> };

export const Buffer = {
  from(data: ArrayBuffer | ArrayBufferView | string): Uint8Array {
    if (typeof data === "string") return new TextEncoder().encode(data);
    return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  },
  concat(chunks: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  },
};
