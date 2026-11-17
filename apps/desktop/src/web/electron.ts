// "electron" for the browser build: what the desktop shell did for the page (file dialogs, showing
// an exported file, the engine's address), done with what a browser has.
const MEDIA = ["mp4", "mov", "m4v", "mkv", "webm", "mp3", "m4a", "wav", "aif", "aiff", "flac", "png", "jpg", "jpeg", "heic", "webp", "gif"];

let banner: HTMLDivElement | null = null;
function progress(text: string | null) {
  if (!text) {
    banner?.remove();
    banner = null;
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.className = "upload-progress";
    document.body.appendChild(banner);
  }
  banner.textContent = text;
}

function upload(file: File, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", `/web/upload?name=${encodeURIComponent(file.name)}`);
    x.upload.onprogress = (e) => e.lengthComputable && progress(`${label} ${Math.round((e.loaded / e.total) * 100)}%`);
    x.onload = () => {
      try {
        const r = JSON.parse(x.responseText) as { path?: string; error?: string };
        if (x.status === 200 && r.path) resolve(r.path);
        else reject(new Error(r.error ?? `Upload failed (${x.status})`));
      } catch {
        reject(new Error(`Upload failed (${x.status})`));
      }
    };
    x.onerror = () => reject(new Error("Upload failed: lost the connection to the engine"));
    x.send(file);
  });
}

/** Copy files from this device to the engine's workspace; returns where they landed. */
async function uploadFiles(files: File[]): Promise<string[]> {
  const paths: string[] = [];
  try {
    for (const [i, f] of files.entries()) paths.push(await upload(f, `Uploading ${f.name}${files.length > 1 ? ` (${i + 1} of ${files.length})` : ""}…`));
  } catch (e) {
    progress((e as Error).message);
    setTimeout(() => progress(null), 5000);
    return paths;
  }
  progress(null);
  return paths;
}

function pickFiles(opts: { extensions?: string[]; multi?: boolean } = {}): Promise<string[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = opts.multi !== false;
    input.accept = (opts.extensions ?? MEDIA).map((e) => `.${e}`).join(",");
    input.style.display = "none";
    document.body.appendChild(input);
    const finish = (files: File[]) => {
      input.remove();
      resolve(files.length ? uploadFiles(files) : []);
    };
    input.addEventListener("change", () => finish([...(input.files ?? [])]));
    input.addEventListener("cancel", () => finish([]));
    input.click();
  });
}

function download(file: string) {
  const a = document.createElement("a");
  a.href = `/web/file?download=1&path=${encodeURIComponent(file)}`;
  a.download = file.split("/").pop() ?? "export";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export const ipcRenderer = {
  async invoke(channel: string, arg?: unknown): Promise<unknown> {
    if (channel === "pick-files") return pickFiles(arg as { extensions?: string[]; multi?: boolean });
    if (channel === "upload-files") return uploadFiles(arg as File[]);
    if (channel === "mic-access") return true;
    if (channel === "reveal") return download(String(arg));
    // "ensure-engine": the page was served by the engine, so its address never changes.
    throw new Error(`Not available in the browser: ${channel}`);
  },
  on() {},
  off() {},
  send() {},
};

export const webUtils = {
  getPathForFile(_file: File): string {
    throw new Error("Files dropped in the browser are uploaded instead");
  },
};
