import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  addMediaToTimeline,
  addText,
  deleteElements,
  duplicateElement,
  mainTrack,
  migrateProject,
  moveElement,
  reorderMain,
  setRippleTiers,
  setSpeed,
  splitAt,
  trimElement,
  validateProject,
  CAPTION_STYLES,
  TEXT_PRESETS,
  TOOL_PANELS,
  listCatalogKinds,
  listCatalog,
  EditError,
  type Session,
} from "../src/index.js";
import { makeSession } from "./fixtures.js";

describe("history", () => {
  it("undo/redo/replace and version tracking", () => {
    const s = makeSession();
    const initial = s.state;
    s.transact("add", "t", (ctx) => addMediaToTimeline(ctx, ctx.draft.media.med_a, {}));
    const afterAdd = s.state;
    expect(s.version).toBe(1);
    s.undo();
    expect(s.state).toBe(s.state);
    expect(s.state).toEqual(initial);
    s.redo();
    expect(s.state).toEqual(afterAdd);
    s.replace("revert", "t", initial);
    expect(s.state).toEqual(initial);
    s.undo();
    expect(s.state).toEqual(afterAdd);
    expect(s.version).toBe(5);
  });

  it("no-op transactions do not create undo steps", () => {
    const s = makeSession();
    const r = s.transact("nothing", "t", () => undefined);
    expect(r.noop).toBe(true);
    expect(s.canUndo).toBe(false);
  });

  it("failed transactions leave state untouched", () => {
    const s = makeSession();
    s.transact("add", "t", (ctx) => addMediaToTimeline(ctx, ctx.draft.media.med_a, {}));
    const before = s.state;
    expect(() =>
      s.transact("bad", "t", (ctx) => {
        addMediaToTimeline(ctx, ctx.draft.media.med_b, {});
        throw new EditError("INVALID_ARGUMENT", "boom");
      }),
    ).toThrow("boom");
    expect(s.state).toBe(before);
  });

  it("expectedVersion detects concurrent edits", () => {
    const s = makeSession();
    s.transact("add", "t", (ctx) => addMediaToTimeline(ctx, ctx.draft.media.med_a, {}));
    expect(() => s.transact("x", "t", () => undefined, { expectedVersion: 0 })).toThrow(/VERSION_CONFLICT|Project changed/);
    expect(() => s.transact("x", "t", () => undefined, { expectedVersion: 1 })).not.toThrow();
  });
});

type Op = (s: Session) => void;

function randomOps(): fc.Arbitrary<Op[]> {
  const pick = (s: Session, i: number) => {
    const ids = Object.keys(s.state.elements);
    return ids.length ? s.state.elements[ids[i % ids.length]] : undefined;
  };
  const safe = (s: Session, label: string, fn: Parameters<Session["transact"]>[2]) => {
    try {
      s.transact(label, "prop", fn);
    } catch (e) {
      if (!(e instanceof EditError) || e.code === "INTERNAL") throw e;
    }
  };
  const op = fc.oneof(
    fc.constantFrom("med_a", "med_b", "med_img", "med_music").map<Op>((m) => (s) => safe(s, "add", (ctx) => addMediaToTimeline(ctx, ctx.draft.media[m], {}))),
    fc.tuple(fc.double({ min: 0, max: 30, noNaN: true }), fc.double({ min: 0.2, max: 5, noNaN: true })).map<Op>(([start, d]) => (s) => safe(s, "text", (ctx) => addText(ctx, { text: "x", start, duration: d }))),
    fc.array(fc.double({ min: 0, max: 40, noNaN: true }), { minLength: 1, maxLength: 20 }).map<Op>((times) => (s) => safe(s, "splitAt", (ctx) => splitAt(ctx, { times, allTracks: true }))),
    fc.tuple(fc.nat(), fc.constantFrom<"left" | "right">("left", "right"), fc.double({ min: -3, max: 3, noNaN: true })).map<Op>(([i, side, d]) => (s) => {
      const el = pick(s, i);
      if (el) safe(s, "trim", (ctx) => trimElement(ctx, ctx.draft.elements[el.id], side, d));
    }),
    fc.nat().map<Op>((i) => (s) => {
      const el = pick(s, i);
      if (el) safe(s, "delete", (ctx) => deleteElements(ctx, [el.id]));
    }),
    fc.nat().map<Op>((i) => (s) => {
      const el = pick(s, i);
      if (el) safe(s, "dup", (ctx) => duplicateElement(ctx, ctx.draft.elements[el.id]));
    }),
    fc.tuple(fc.nat(), fc.double({ min: 0, max: 30, noNaN: true })).map<Op>(([i, t]) => (s) => {
      const el = pick(s, i);
      if (el) safe(s, "move", (ctx) => moveElement(ctx, ctx.draft.elements[el.id], { start: t }));
    }),
    fc.tuple(fc.nat(), fc.nat({ max: 10 })).map<Op>(([i, to]) => (s) => {
      const el = pick(s, i);
      if (el && el.trackId === mainTrack(s.state).id) safe(s, "reorder", (ctx) => reorderMain(ctx, ctx.draft.elements[el.id], to));
    }),
    fc.tuple(fc.nat(), fc.double({ min: 0.25, max: 4, noNaN: true })).map<Op>(([i, r]) => (s) => {
      const el = pick(s, i);
      if (el && (el.type === "video" || el.type === "audio")) safe(s, "speed", (ctx) => setSpeed(ctx, ctx.draft.elements[el.id], r));
    }),
    fc.tuple(fc.boolean(), fc.boolean(), fc.boolean()).map<Op>(([m, t1, t2]) => (s) => safe(s, "tiers", (ctx) => setRippleTiers(ctx, { magnetEnabled: m, tier1RippleEnabled: t1, tier2RippleEnabled: t2 }))),
  );
  return fc.array(op, { minLength: 1, maxLength: 25 });
}

describe("property: invariants under random edits", () => {
  it("every commit is valid and undoing everything restores the initial state", () => {
    fc.assert(
      fc.property(randomOps(), (ops) => {
        const s = makeSession();
        const initial = s.state;
        for (const op of ops) {
          op(s);
          expect(validateProject(s.state)).toEqual([]);
        }
        while (s.canUndo) s.undo();
        expect(s.state).toEqual(initial);
        while (s.canRedo) s.redo();
        expect(validateProject(s.state)).toEqual([]);
      }),
      { numRuns: Number(process.env.PROPERTY_RUNS ?? 150) },
    );
  });
});

describe("catalog and migrations", () => {
  it("has the required catalog sizes", () => {
    expect(TEXT_PRESETS.length).toBe(34);
    expect(CAPTION_STYLES.length).toBe(39);
    expect(TOOL_PANELS.length).toBe(42);
    expect(new Set(TEXT_PRESETS.map((p) => p.id)).size).toBe(34);
    expect(new Set(CAPTION_STYLES.map((p) => p.id)).size).toBe(39);
    expect(new Set(TOOL_PANELS.map((p) => p.id)).size).toBe(42);
    const kinds = listCatalogKinds();
    expect(kinds.find((k) => k.kind === "luts")!.count).toBe(17);
    expect(listCatalog("captionStyles", { query: "highlight box" }).total).toBe(3);
  });

  it("migrates v0 documents and rejects future versions", () => {
    const s = makeSession();
    const { schemaVersion, brief, teleprompter, ...v0 } = s.state;
    void schemaVersion;
    void brief;
    void teleprompter;
    const migrated = migrateProject(JSON.parse(JSON.stringify(v0)));
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.brief).toBe("");
    expect(() => migrateProject({ ...s.state, schemaVersion: 99 })).toThrow(/newer/);
    expect(migrateProject(JSON.parse(JSON.stringify(s.state)))).toEqual(s.state);
  });
});
