import { useState } from "react";
import { live, useLive } from "./live.js";
import { formatTime } from "./uiStore.js";

interface Suggestion { start: number; end: number; reasons: string[]; text: string }
interface CutPlan { projectId: string; version: number; suggestions: Suggestion[]; useWords: boolean }

export function RoughCut({ audition }: { audition: (start: number, end: number) => void }) {
  const { project, version } = useLive();
  const [plan, setPlan] = useState<CutPlan>();
  const [excluded, setExcluded] = useState<number[]>([]);
  const [busy, setBusy] = useState<"scan" | "apply" | null>(null);
  const stale = !!plan && plan.version !== version;
  const selected = plan?.suggestions.filter((_cut, index) => !excluded.includes(index)) ?? [];
  const seconds = selected.reduce((sum, cut) => sum + cut.end - cut.start, 0);
  const fps = project?.canvas.fps ?? 30;

  return <div className="captions-workflow">
    <button className="primary" disabled={!!busy} onClick={async () => {
      setBusy("scan");
      try {
        const result = await live.run<CutPlan>("planRoughCut");
        if (result) { setPlan(result); setExcluded([]); }
      } finally { setBusy(null); }
    }}>{busy === "scan" ? "Finding cuts…" : "Find cuts"}</button>
    {stale && <p role="status">The timeline changed. Find cuts again to review the current edit.</p>}
    {plan && !plan.useWords && <p className="muted small">These suggestions use audio. Set up automatic captions to find fillers and retakes.</p>}
    {plan?.suggestions.length === 0 && <p role="status">No cuts suggested.</p>}
    {plan?.suggestions.map((cut, index) => (
      <div className="cut-suggestion" key={index}>
        <label><input type="checkbox" disabled={stale || !!busy} checked={!excluded.includes(index)} onChange={(event) => {
          if (event.target.checked) setExcluded(excluded.filter((item) => item !== index));
          else setExcluded([...excluded, index]);
        }} /> {cut.reasons.join(", ")} · {formatTime(cut.start, fps)}</label>
        <button disabled={stale || !!busy} onClick={() => audition(cut.start, cut.end)}>Play excerpt</button>
        {cut.text && <p className="muted small">{cut.text}</p>}
      </div>
    ))}
    {plan && !!plan.suggestions.length && <button disabled={stale || !!busy || !selected.length} onClick={async () => {
      setBusy("apply");
      try {
        const result = await live.run<{ removedSeconds: number }>("applyRoughCut", {
          projectId: plan.projectId, version: plan.version, ranges: selected.map(({ start, end }) => ({ start, end })),
        });
        if (result) {
          setPlan(undefined);
          live.toast("info", `Removed ${result.removedSeconds.toFixed(1)} seconds. Undo restores the previous edit.`);
        }
      } finally { setBusy(null); }
    }}>{busy === "apply" ? "Applying…" : `Apply ${selected.length} cuts · ${seconds.toFixed(1)}s`}</button>}
  </div>;
}
