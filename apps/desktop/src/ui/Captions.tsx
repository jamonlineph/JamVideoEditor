import { useEffect, useState } from "react";
import { ipcRenderer } from "electron";
import { CAPTION_STYLES, mainTrack, type CaptionElement } from "@openedits/core";
import { FILE_MANAGER, live, useLive, WEB } from "./live.js";
import { formatTime, seek, ui } from "./uiStore.js";

export function Captions() {
  const { project } = useLive();
  const [setup, setSetup] = useState<{ runtime: boolean; model: boolean; job?: { status: string; progress: number; error?: { message: string } } }>();
  const [style, setStyle] = useState(project?.preferredCaptionStyle ?? "clean");
  const [text, setText] = useState("");
  const [working, setWorking] = useState(false);
  const captions = Object.values(project?.elements ?? {}).filter((el): el is CaptionElement => el.type === "caption").sort((a, b) => a.start - b.start);
  const hasAudio = !!project && mainTrack(project).elementIds.some((id) => {
    const el = project.elements[id];
    return el && "mediaId" in el && project.media[el.mediaId]?.hasAudio;
  });

  async function modelSetup(download = false) {
    const result = await live.run<NonNullable<typeof setup>>("captionSetup", { download });
    if (result) setSetup(result);
  }

  useEffect(() => { void modelSetup(); }, []);
  const downloading = setup?.job?.status === "running";
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void modelSetup(), 700);
    return () => clearInterval(timer);
  }, [downloading]);

  function addManual() {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return;
    const start = ui.get().playhead;
    const end = start + 2;
    void live.run("addCaptions", {
      styleId: style, segments: [{ start, end, words: words.map((word, i) => ({
        text: word, start: start + 2 * i / words.length, end: start + 2 * (i + 1) / words.length,
      })) }],
    }).then((result) => { if (result) setText(""); });
  }

  const importSrt = async () => {
    const { project: current, version } = live.state;
    try {
      const [file] = await ipcRenderer.invoke("pick-files", { title: "Import subtitles", extensions: ["srt"], multi: false }) as string[];
      if (file) await live.run("importSubtitles", { path: file, styleId: style, projectId: current?.id, expectedVersion: version });
    } catch (error) { live.toast("error", (error as Error).message); }
  };

  const exportSrt = async () => {
    const result = await live.run<{ path: string }>("exportSubtitles");
    if (result) await ipcRenderer.invoke("reveal", result.path).catch((error: Error) => live.toast("error", error.message));
  };

  return <div className="captions-workflow">
    {setup?.runtime && setup.model ? <div className="row">
      <button className="primary" disabled={!hasAudio || working} onClick={async () => {
        setWorking(true);
        try { await live.run("generateCaptions", { style, expectedVersion: live.state.version }); }
        finally { setWorking(false); }
      }}>{working ? "Generating…" : "Generate captions"}</button>
      <small className="muted">{hasAudio ? "On device" : "Add a clip with speech first"}</small>
    </div> : setup && <div className="caption-setup">
      <strong>Set up automatic captions</strong>
      {setup.runtime ? <>
        <p className="muted small">Download the local speech model once, then generate captions offline.</p>
        <button disabled={downloading} onClick={() => void modelSetup(true)}>
          {downloading ? `Downloading ${Math.round((setup.job?.progress ?? 0) * 100)}%` : "Download caption model (148 MB)"}
        </button>
        {setup.job?.error && <p role="status">{setup.job.error.message}</p>}
      </> : <>
        <p className="muted small">Automatic captions need the Whisper runtime on this device. Add captions manually or import an SRT below.</p>
        <button onClick={() => void modelSetup()}>Check again</button>
      </>}
    </div>}
    <label className="field wide"><span>Style</span><select value={style} onChange={(event) => setStyle(event.target.value)}>
      {CAPTION_STYLES.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
    </select></label>
    {!!captions.length && <button onClick={() => void live.run("setCaptionStyle", { styleId: style, usePresetHighlight: true })}>Apply style to all</button>}
    <div className="row">
      <button onClick={() => void importSrt()}>Import SRT</button>
      <button disabled={!captions.length} title={WEB ? "Download SRT" : `Save SRT and show in ${FILE_MANAGER}`} onClick={() => void exportSrt()}>Export SRT</button>
    </div>
    <form onSubmit={(event) => { event.preventDefault(); addManual(); }}>
      <label className="field wide"><span>Manual caption</span><input value={text} onChange={(event) => setText(event.target.value)} placeholder="Caption at playhead" maxLength={500} /></label>
      <button disabled={!text.trim()}>Add caption</button>
    </form>
    {captions.map((el) => {
      const value = el.words.map((word) => word.text).join(" ");
      return <div className="caption-cue row" key={el.id}>
        <button aria-label={`Go to caption at ${formatTime(el.start)}`} onClick={() => seek(el.start)}>{formatTime(el.start)}</button>
        <input key={value} aria-label={`Edit caption at ${formatTime(el.start)}`} className="grow" defaultValue={value} onBlur={(event) => {
          const next = event.currentTarget.value.trim();
          if (!next) event.currentTarget.value = value;
          else if (next !== value) void live.run("editCaption", { elementId: el.id, text: next });
        }} />
      </div>;
    })}
  </div>;
}
