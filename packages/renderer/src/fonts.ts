import { FONTS, type Scene } from "@openedits/core";

const bundled = new Set(FONTS.filter(({ data }) => data.builtIn).map(({ data }) => data.family));

/** Canvas text metrics are fixed at draw time, so wait for the same local faces in preview and export. */
export async function loadSceneFonts(scene: Scene): Promise<void> {
  const pending = new Set<string>();
  for (const layer of scene.layers) {
    if (layer.kind !== "text" && layer.kind !== "caption") continue;
    const { fontFamily, fontWeight, italic } = layer.style;
    if (!bundled.has(fontFamily)) continue;
    const weights = new Set([fontWeight]);
    if (layer.kind === "text") {
      for (const range of layer.emphasis) {
        if (range.fontWeight !== undefined) weights.add(range.fontWeight);
      }
    }
    for (const weight of weights) {
      const font = `${italic ? "italic" : "normal"} ${weight} 16px "${fontFamily}"`;
      if (!document.fonts.check(font)) pending.add(font);
    }
  }
  await Promise.all([...pending].map((font) => document.fonts.load(font).catch(() => [])));
}
