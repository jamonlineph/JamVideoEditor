import type { AudioElement, Keyframe, Project, Speed, VideoElement } from "../schema.js";
import { evaluateKeyframes } from "../keyframes.js";
import { isAudioKind } from "../timeline/query.js";
import { speedSegments, type SpeedSegment } from "./timeMap.js";

export interface AudioClipPlan {
  elementId: string;
  mediaId: string;
  path: string;
  /** Channel count of the source audio stream (when known). */
  sourceChannels?: number;
  role: string;
  /** Speech-like sources drive ducking of other clips. */
  isVoice: boolean;
  startSeconds: number;
  durationSeconds: number;
  sourceInSourceSeconds: number;
  sourceDurationSourceSeconds: number;
  speed: Speed;
  segments: SpeedSegment[];
  reversed: boolean;
  volume: number;
  volumeKeyframes: Keyframe[];
  fadeInSeconds: number;
  fadeOutSeconds: number;
  voiceEnhance: { enabled: boolean; reduceNoise: number; enhanceVoice: number };
  ducking: { enabled: boolean; amountDb: number; attackSeconds: number; releaseSeconds: number };
}

/** Every audible clip on the timeline, honoring element/track mutes and detached audio. */
export function buildAudioPlan(project: Project): AudioClipPlan[] {
  const out: AudioClipPlan[] = [];
  for (const track of project.tracks) {
    if (track.muted) continue;
    for (const id of track.elementIds) {
      const el = project.elements[id];
      if (!el || (el.type !== "video" && el.type !== "audio")) continue;
      if (el.muted || el.volume <= 0 && !el.keyframes.volume?.length) continue;
      const media = project.media[el.mediaId];
      if (!media?.hasAudio) continue;
      if (el.type === "video" && el.audioDetached) continue;
      const role = el.type === "audio" ? el.role : "video";
      const src = el as VideoElement | AudioElement;
      out.push({
        elementId: el.id,
        mediaId: el.mediaId,
        path: media.path,
        ...(media.audioChannels ? { sourceChannels: media.audioChannels } : {}),
        role,
        isVoice: role === "video" || role === "voiceover" || role === "extracted" || role === "tts",
        startSeconds: el.start,
        durationSeconds: el.duration,
        sourceInSourceSeconds: src.sourceInSourceSeconds,
        sourceDurationSourceSeconds: src.sourceDurationSourceSeconds,
        speed: src.speed,
        segments: speedSegments(src),
        reversed: src.reversed,
        volume: el.volume,
        volumeKeyframes: el.keyframes.volume ?? [],
        fadeInSeconds: el.fadeInSeconds,
        fadeOutSeconds: el.fadeOutSeconds,
        voiceEnhance: el.voiceEnhance,
        ducking: isAudioKind(track.kind) || el.type === "audio" ? el.ducking : { ...el.ducking, enabled: false },
      });
    }
  }
  return out;
}

/** Linear gain of a clip at an element-local time: volume (or its keyframes) times fades. */
export function clipGainAt(clip: Pick<AudioClipPlan, "volume" | "volumeKeyframes" | "fadeInSeconds" | "fadeOutSeconds" | "durationSeconds">, localSeconds: number): number {
  let g = evaluateKeyframes(clip.volumeKeyframes, localSeconds, clip.volume);
  if (clip.fadeInSeconds > 0 && localSeconds < clip.fadeInSeconds) g *= Math.max(0, localSeconds / clip.fadeInSeconds);
  const remaining = clip.durationSeconds - localSeconds;
  if (clip.fadeOutSeconds > 0 && remaining < clip.fadeOutSeconds) g *= Math.max(0, remaining / clip.fadeOutSeconds);
  return g;
}
