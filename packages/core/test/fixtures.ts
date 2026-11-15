import { Session, createProject, sequentialIds, type MediaAsset, type Project } from "../src/index.js";

export const MEDIA: Record<string, MediaAsset> = {
  med_a: {
    id: "med_a",
    kind: "video",
    name: "a.mp4",
    path: "/tmp/a.mp4",
    durationSourceSeconds: 10,
    width: 1080,
    height: 1920,
    fps: 30,
    hasVideo: true,
    hasAudio: true,
    sizeBytes: 1000,
    importedAt: 0,
  },
  med_b: {
    id: "med_b",
    kind: "video",
    name: "b.mp4",
    path: "/tmp/b.mp4",
    durationSourceSeconds: 8,
    width: 1920,
    height: 1080,
    fps: 30,
    hasVideo: true,
    hasAudio: true,
    sizeBytes: 1000,
    importedAt: 0,
  },
  med_img: {
    id: "med_img",
    kind: "image",
    name: "photo.png",
    path: "/tmp/photo.png",
    width: 1000,
    height: 1000,
    hasVideo: true,
    hasAudio: false,
    sizeBytes: 1000,
    importedAt: 0,
  },
  med_music: {
    id: "med_music",
    kind: "audio",
    name: "music.m4a",
    path: "/tmp/music.m4a",
    durationSourceSeconds: 30,
    hasVideo: false,
    hasAudio: true,
    sizeBytes: 1000,
    importedAt: 0,
  },
};

export function makeSession(overrides: (p: Project) => void = () => {}): Session {
  const ids = sequentialIds();
  const project = createProject({ id: "prj_test", name: "Test", ids, now: 0 });
  const withMedia = { ...project, media: { ...MEDIA } };
  overrides(withMedia);
  return new Session(withMedia, { ids, now: () => 0, validate: true });
}
