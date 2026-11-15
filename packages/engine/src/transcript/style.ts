import { CAPTION_STYLES } from "@openedits/core";

export interface AutoEditPlan {
  removeRetakes: boolean;
  removeFillers: boolean;
  removeSilences: boolean;
  minSilenceSeconds?: number;
  /** Alternating punch-in scale, or null for no zoom. */
  zoomScale: number | null;
  captions: { style: string; maxWords?: number } | null;
  /** Style rules that need judgment (hook, B-roll, music, ending, publishing) for the agent to apply. */
  notes: string[];
}

const JUDGMENT_SECTIONS = /^(hook|images|b-?roll|music|ending|publishing|about)/i;

function findCaptionStyle(text: string): string | undefined {
  const quoted = /style\s*[:=]?\s*["“'`]([^"”'`]+)["”'`]/i.exec(text)?.[1]?.trim().toLowerCase();
  if (!quoted) return undefined;
  return CAPTION_STYLES.find((s) => s.id === quoted || s.name.toLowerCase() === quoted || s.id === quoted.replace(/\s+/g, "_"))?.id;
}

/** Read the parts of STYLE.md that map onto automatic edit ops; everything else becomes notes. */
export function parseStyleGuide(markdown: string, defaults: { captionStyle: string; minSilenceSeconds: number }): AutoEditPlan {
  const sections = new Map<string, string>();
  let current = "";
  for (const line of markdown.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      current = h[1].trim();
      sections.set(current, "");
    } else sections.set(current, `${sections.get(current) ?? ""}${line}\n`);
  }
  const body = (name: RegExp) => [...sections.entries()].filter(([k]) => name.test(k)).map(([, v]) => v).join("\n");
  const pacing = body(/pacing|edit|cut/i) || markdown;
  const captionText = body(/caption/i);
  const zoomText = body(/zoom|punch/i);
  const no = (re: RegExp, text: string) => new RegExp(`(don't|do not|never|no)\\s+[^.\\n]*${re.source}`, "i").test(text);

  const captionsOff = /captions?\s*(are\s*)?(off|disabled)|no captions/i.test(captionText);
  const minSilence = /silences?\s+(?:longer than|over|above|>)\s*(\d+(?:\.\d+)?)\s*s/i.exec(markdown)?.[1];
  const zoom = /(\d(?:\.\d+)?)\s*x/i.exec(zoomText)?.[1];
  const notes: string[] = [];
  for (const [name, text] of sections) {
    if (!JUDGMENT_SECTIONS.test(name)) continue;
    const rules = text
      .split("\n")
      .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
      .filter((l) => l && !l.startsWith("<!--") && !/:\s*$/.test(l));
    if (rules.length) notes.push(`${name}: ${rules.join(" ")}`);
  }
  return {
    removeSilences: /silence/i.test(pacing) ? !no(/silence/, pacing) : true,
    removeFillers: /filler/i.test(pacing) ? !no(/filler/, pacing) : true,
    removeRetakes: /retake|repeated|false start|twice/i.test(pacing) ? !no(/retake/, pacing) : true,
    ...(minSilence ? { minSilenceSeconds: Number(minSilence) } : {}),
    zoomScale: zoomText.trim() && !no(/zoom|punch/, zoomText) ? Math.min(1.5, Math.max(1.02, Number(zoom ?? 1.1))) : null,
    captions: captionsOff ? null : { style: findCaptionStyle(captionText) ?? defaults.captionStyle, ...(/(\d+)\s+words?/i.test(captionText) ? { maxWords: Number(/(\d+)\s+words?/i.exec(captionText)![1]) } : {}) },
    notes,
  };
}
