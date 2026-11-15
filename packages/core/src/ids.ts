import { customAlphabet } from "nanoid";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const nano = customAlphabet(alphabet, 10);

export type IdPrefix = "prj" | "el" | "trk" | "med" | "fld" | "tr" | "bm" | "fx" | "rev";

export type IdGenerator = (prefix: IdPrefix) => string;

export const randomIds: IdGenerator = (prefix) => `${prefix}_${nano()}`;

/** Deterministic id generator for tests: prefix_1, prefix_2, ... per prefix. */
export function sequentialIds(): IdGenerator {
  const counters = new Map<string, number>();
  return (prefix) => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}_${n}`;
  };
}
