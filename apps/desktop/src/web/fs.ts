// node:fs for the browser build. The shared UI code makes a handful of small synchronous calls
// (does this media file exist, list the music folder, read a .cube LUT, save a voiceover take);
// they go to the engine over synchronous requests, which loopback answers in well under a millisecond.
function request(method: string, url: string, body: XMLHttpRequestBodyInit, type?: string): unknown {
  const x = new XMLHttpRequest();
  x.open(method, url, false);
  if (type) x.setRequestHeader("content-type", type);
  x.send(body);
  let r: { result?: unknown; error?: string; code?: string } = {};
  try {
    r = JSON.parse(x.responseText);
  } catch {
    /* not JSON: reported below */
  }
  if (x.status !== 200) throw Object.assign(new Error(r.error ?? `The engine answered ${x.status}`), { code: r.code });
  return r.result;
}
const rpc = (op: string, path: string) => request("POST", "/web/fs", JSON.stringify({ op, path }), "application/json");

// The preview asks whether each media file exists on every frame.
const seen = new Map<string, { value: boolean; at: number }>();

function existsSync(path: string): boolean {
  const hit = seen.get(path);
  const now = Date.now();
  if (hit && now - hit.at < (hit.value ? 30_000 : 1500)) return hit.value;
  let value = false;
  try {
    value = rpc("exists", path) === true;
  } catch {
    /* unreachable engine: treat as missing */
  }
  seen.set(path, { value, at: now });
  return value;
}

/** Bytes of a file (synchronous: a binary response type is not allowed, so read it as x-user-defined text). */
function readBinary(path: string): Uint8Array {
  const x = new XMLHttpRequest();
  x.open("GET", `/web/file?path=${encodeURIComponent(path)}`, false);
  x.overrideMimeType("text/plain; charset=x-user-defined");
  x.send();
  if (x.status !== 200) throw Object.assign(new Error(`Could not read ${path} (${x.status})`), { code: x.status === 404 ? "ENOENT" : "EIO" });
  const text = x.responseText;
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

const api = {
  existsSync,
  readdirSync: (path: string) => rpc("readdir", path) as string[],
  readFileSync: (path: string, encoding?: string) => (encoding ? (rpc("readText", path) as string) : readBinary(path)),
  mkdirSync: (path: string, _opts?: unknown) => void rpc("mkdir", path),
  rmSync: (path: string, _opts?: unknown) => {
    seen.delete(path);
    rpc("rm", path);
  },
  writeFileSync: (path: string, data: Uint8Array | string) => {
    seen.delete(path);
    request("PUT", `/web/write?path=${encodeURIComponent(path)}`, data as XMLHttpRequestBodyInit);
  },
};
export default api;
