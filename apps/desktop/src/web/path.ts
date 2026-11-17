// node:path for the browser build (the engine's machine is POSIX in browser mode).
function normalize(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else if (part !== ".." || !abs) out.push(part);
  }
  return (abs ? "/" : "") + out.join("/") || (abs ? "/" : ".");
}
const join = (...parts: string[]) => normalize(parts.filter(Boolean).join("/"));
const dirname = (p: string) => {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i < 0 ? "." : i === 0 ? "/" : p.slice(0, i);
};
const basename = (p: string, ext?: string) => {
  const b = p.replace(/\/+$/, "").split("/").pop() ?? "";
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
};
const extname = (p: string) => /[^/.](\.[^/.]*)$/.exec(basename(p))?.[1] ?? "";
const api = { join, normalize, dirname, basename, extname, resolve: join, isAbsolute: (p: string) => p.startsWith("/"), sep: "/" };
export { join, normalize, dirname, basename, extname };
export default api;
