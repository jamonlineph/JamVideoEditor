import type { Project } from "./schema.js";
import { ProjectSchema, SCHEMA_VERSION } from "./schema.js";
import { DEFAULT_EXPORT, DEFAULT_RIPPLE } from "./defaults.js";
import { EditError } from "./errors.js";

type Raw = Record<string, unknown>;

/** Each migration upgrades a document from version N to N + 1. */
const MIGRATIONS: Record<number, (doc: Raw) => Raw> = {
  // v0: pre-release documents without schemaVersion and without the later optional groups.
  0: (doc) => ({
    ...doc,
    schemaVersion: 1,
    mediaFolders: doc.mediaFolders ?? [],
    transitions: doc.transitions ?? [],
    beatMarkers: doc.beatMarkers ?? [],
    beatDensity: doc.beatDensity ?? "off",
    rippleSettings: { ...DEFAULT_RIPPLE, ...((doc.rippleSettings as object) ?? {}) },
    teleprompter: doc.teleprompter ?? { text: "", fontSize: 48, scrollSpeed: 140 },
    exportSettings: { ...DEFAULT_EXPORT, ...((doc.exportSettings as object) ?? {}) },
    brief: doc.brief ?? "",
  }),
};

/** Upgrade any stored document to the current schema and validate it. */
export function migrateProject(raw: unknown): Project {
  if (!raw || typeof raw !== "object") throw new EditError("INVALID_ARGUMENT", "Project document must be an object");
  let doc = raw as Raw;
  let version = typeof doc.schemaVersion === "number" ? doc.schemaVersion : 0;
  if (version > SCHEMA_VERSION) {
    throw new EditError("INVALID_ARGUMENT", `Project schema v${version} is newer than this app supports (v${SCHEMA_VERSION})`);
  }
  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new EditError("INTERNAL", `No migration from schema v${version}`);
    doc = step(doc);
    version++;
  }
  const parsed = ProjectSchema.safeParse(doc);
  if (!parsed.success) {
    throw new EditError("INVALID_ARGUMENT", "Project document failed validation", {
      issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  return parsed.data;
}
