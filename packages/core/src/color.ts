import { z } from "zod";

const HEX_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** `#RRGGBB` or `#RRGGBBAA` (no transform, so it converts cleanly to JSON Schema). */
export const HexColor = z.string().regex(HEX_RE, "Expected #RRGGBB or #RRGGBBAA");

export type HexColor = string;

export function isHexColor(value: string): boolean {
  return HEX_RE.test(value);
}

/** True when a stored hex color is present and has a nonzero alpha channel. */
export function isVisibleHexColor(value: HexColor | undefined): value is HexColor {
  return !!value && (value.length !== 9 || !value.endsWith("00"));
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

export function parseHex(hex: string): Rgba {
  if (!isHexColor(hex)) throw new Error(`Invalid hex color: ${hex}`);
  const h = hex.slice(1);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

export function toHex({ r, g, b, a }: Rgba, includeAlpha = a < 1): string {
  const p = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0").toUpperCase();
  return `#${p(r)}${p(g)}${p(b)}${includeAlpha ? p(a * 255) : ""}`;
}
