import { describe, expect, it } from "vitest";
import { actionFor, keyOf, SHORTCUT_MAPS, type ShortcutMapId } from "../src/ui/shortcuts.js";

const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {}) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

describe("shortcut maps", () => {
  it("normalizes key events", () => {
    expect(keyOf(key(" "))).toBe("Space");
    expect(keyOf(key("Z", { metaKey: true, shiftKey: true }))).toBe("Meta+Shift+z");
    expect(keyOf(key("z", { ctrlKey: true }))).toBe("Meta+z");
    expect(keyOf(key("+", { metaKey: true }))).toBe("Meta+=");
  });

  it("has no conflicting bindings in any map", () => {
    for (const [id, map] of Object.entries(SHORTCUT_MAPS)) {
      const keys = Object.values(map.keys);
      expect(new Set(keys).size, id).toBe(keys.length);
    }
  });

  it("maps each editor's split key", () => {
    const split: Record<ShortcutMapId, ReturnType<typeof key>> = {
      edits: key("s"),
      capcut: key("b", { metaKey: true }),
      premiere: key("k", { metaKey: true }),
      finalcut: key("b", { metaKey: true }),
      resolve: key("\\", { metaKey: true }),
    };
    for (const [id, ev] of Object.entries(split)) expect(actionFor(id as ShortcutMapId, ev), id).toBe("split");
    expect(actionFor("edits", key("q"))).toBeNull();
  });

  it("treats Delete and Backspace alike", () => {
    expect(actionFor("edits", key("Delete"))).toBe("delete");
    expect(actionFor("edits", key("Backspace"))).toBe("delete");
  });
});
