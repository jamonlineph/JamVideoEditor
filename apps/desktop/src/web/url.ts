// node:url for the browser build: "file URLs" are served by the engine (GET /web/file).
export function pathToFileURL(file: string): { href: string } {
  return { href: `/web/file?path=${encodeURIComponent(file)}` };
}
