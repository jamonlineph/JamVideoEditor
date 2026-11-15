export interface CubeLut {
  size: number;
  /** size^3 RGB triples, red varying fastest. */
  data: Float32Array;
  title?: string;
}

/** Parse an Adobe/Resolve `.cube` 3D LUT. Input domain is normalized to 0..1. */
export function parseCube(text: string): CubeLut {
  let size = 0;
  let title: string | undefined;
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    if (key === "TITLE") title = line.slice(5).trim().replace(/^"|"$/g, "");
    else if (key === "LUT_3D_SIZE") size = Number(parts[1]);
    else if (key === "LUT_1D_SIZE") throw new Error("1D .cube LUTs are not supported; export a 3D LUT");
    else if (key === "DOMAIN_MIN") min = parts.slice(1, 4).map(Number);
    else if (key === "DOMAIN_MAX") max = parts.slice(1, 4).map(Number);
    else if (/^[-+.\d]/.test(key)) {
      if (parts.length < 3) throw new Error(`Malformed .cube row: "${line}"`);
      values.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
    }
  }
  if (!Number.isInteger(size) || size < 2 || size > 129) throw new Error("Missing or invalid LUT_3D_SIZE");
  if (values.length !== size ** 3 * 3) throw new Error(`Expected ${size ** 3} rows for a ${size}^3 LUT, found ${values.length / 3}`);
  if (values.some((v) => !Number.isFinite(v))) throw new Error("The .cube file contains non-numeric values");
  if (min.some((v) => v !== 0) || max.some((v) => v !== 1)) throw new Error("Only .cube LUTs with a 0..1 input domain are supported");
  return { size, data: Float32Array.from(values), ...(title ? { title } : {}) };
}
