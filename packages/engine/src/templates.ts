import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EditError, migrateProject, type Project } from "@openedits/core";

export const CREATOR_TEMPLATES = [
  { id: "talking-head", name: "Talking head", title: "Start with your hook", titleStyle: "headline", caption: "bold" },
  { id: "product-review", name: "Product review", title: "Product name", titleStyle: "didot", caption: "clean" },
  { id: "interview-excerpt", name: "Interview excerpt", title: "Guest name", titleStyle: "label_black", caption: "interview" },
];

const validId = /^template-[a-f\d-]{36}$/;

export function listCreatorTemplates(directory: string) {
  const defaults = CREATOR_TEMPLATES.map(({ id, name }) => ({ id, name, builtin: true }));
  if (!fs.existsSync(directory)) return defaults;
  const saved = fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const id = entry.name.replace(/\.json$/, "");
    if (!entry.isFile() || !validId.test(id) || entry.name !== `${id}.json`) return [];
    try {
      return [{ id, name: readCreatorTemplate(directory, id).name, builtin: false }];
    } catch {
      return [];
    }
  });
  return [...defaults, ...saved];
}

export function readCreatorTemplate(directory: string, id: string) {
  if (!validId.test(id)) throw new EditError("INVALID_ARGUMENT", "Unknown project template.");
  const file = path.join(directory, `${id}.json`);
  if (!fs.existsSync(file)) throw new EditError("FILE_NOT_FOUND", "Project template is unavailable.");
  return migrateProject(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** Reusable layouts keep branding and music, and omit the original clips and their captions. */
export function saveCreatorTemplate(directory: string, name: string, source: Project) {
  const project = structuredClone(source);
  const media = new Set<string>();
  const captions = Object.values(project.elements).filter((element) => element.type === "caption");
  project.preferredCaptionStyle = captions[0]?.styleId ?? project.preferredCaptionStyle;
  for (const [id, el] of Object.entries(project.elements)) {
    const onMain = el.trackId === project.tracks[0].id;
    const keep = !onMain && (el.type === "text" || el.type === "image" || el.type === "shape" ||
      el.type === "sticker" && !el.cutoutMaskId || el.type === "audio" && (el.role === "music" || el.role === "sfx"));
    if (!keep) {
      delete project.elements[id];
      continue;
    }
    delete el.anchor;
    if ("mediaId" in el) media.add(el.mediaId);
    if ("effects" in el) el.effects = el.effects.filter((effect) => !effect.subjectMaskId);
  }
  for (const track of project.tracks) {
    track.elementIds = track.elementIds.filter((id) => !!project.elements[id]);
    track.locked = false;
  }
  project.tracks = project.tracks.filter((track, index) => index === 0 || track.elementIds.length);
  project.media = Object.fromEntries(Object.entries(project.media).filter(([id]) => media.has(id)));
  project.transitions = [];
  project.beatMarkers = [];
  project.brief = "";
  project.teleprompter.text = "";
  delete project.exportSettings.outputDir;
  delete project.exportSettings.fileName;
  project.name = name;
  fs.mkdirSync(directory, { recursive: true });
  const id = `template-${randomUUID()}`;
  fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify(project), { flag: "wx" });
  return { id, name, builtin: false };
}
