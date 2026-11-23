import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { EditError, migrateProject, validateProject, type Project } from "@openedits/core";

const FORMAT = "openedits.project";

/** A versioned snapshot of the edit with optional files collected beside it. */
export async function writePortableProject(source: Project, destination: string, collectMedia: boolean) {
  const project = structuredClone(source);
  const name = project.name.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 60) || "OpenEdits";
  const folder = await fsp.mkdtemp(path.join(path.resolve(destination), `${name} backup-`));
  try {
    const collected = new Map<string, string>();
    if (collectMedia) await fsp.mkdir(path.join(folder, "media"));
    const collect = async (file: string) => {
      if (!collectMedia) return file;
      const existing = collected.get(file);
      if (existing) return existing;
      const extension = path.extname(file).replace(/[^.a-z0-9]/gi, "").slice(0, 12);
      const relative = `media/${collected.size + 1}${extension}`;
      try {
        await fsp.copyFile(file, path.join(folder, relative), fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new EditError("FILE_NOT_FOUND", `Locate ${path.basename(file)} before collecting this project's media.`);
        }
        throw error;
      }
      collected.set(file, relative);
      return relative;
    };
    for (const asset of Object.values(project.media)) {
      delete asset.proxyPath;
      asset.path = await collect(asset.path);
    }
    for (const element of Object.values(project.elements)) if ("color" in element && element.color.lut?.cubePath) {
      element.color.lut.cubePath = await collect(element.color.lut.cubePath);
    }
    delete project.exportSettings.outputDir;
    const file = path.join(folder, "project.openedits.json");
    await fsp.writeFile(file, JSON.stringify({ format: FORMAT, version: 1, collectMedia, project }, null, 2) + "\n", { flag: "wx" });
    return file;
  } catch (error) {
    await fsp.rm(folder, { recursive: true, force: true });
    throw error;
  }
}

export function readPortableProject(file: string): Project {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new EditError("FILE_NOT_FOUND", "Project backup not found.");
  if (stat.size > 64 * 1024 * 1024) throw new EditError("INVALID_ARGUMENT", "Project backup manifest is too large.");
  let data: { format?: string; version?: number; collectMedia?: boolean; project?: unknown };
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new EditError("INVALID_ARGUMENT", "Project backup is not valid JSON.");
  }
  if (data?.format !== FORMAT || data.version !== 1 || typeof data.collectMedia !== "boolean") {
    throw new EditError("INVALID_ARGUMENT", "This is not a supported OpenEdits project backup.");
  }
  const project = migrateProject(data.project);
  const relocate = (media: string) => {
    if (!data.collectMedia && path.isAbsolute(media)) return media;
    if (data.collectMedia && /^media\/\d+(?:\.[0-9a-z]+)?$/i.test(media)) return path.resolve(path.dirname(file), media);
    throw new EditError("INVALID_ARGUMENT", "A media path in the backup does not match its format.");
  };
  for (const asset of Object.values(project.media)) {
    delete asset.proxyPath;
    asset.path = relocate(asset.path);
  }
  for (const element of Object.values(project.elements)) if ("color" in element && element.color.lut?.cubePath) {
    element.color.lut.cubePath = relocate(element.color.lut.cubePath);
  }
  delete project.exportSettings.outputDir;
  const issues = validateProject(project);
  if (issues.length) throw new EditError("INVALID_ARGUMENT", "The project backup contains invalid edits.", { issues: issues.slice(0, 10) });
  return project;
}
