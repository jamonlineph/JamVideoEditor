# OpenEdits Studio

A local-first video editor with a built-in MCP server. Creators edit in the desktop UI, and AI agents inspect and edit the same live composition through MCP tools.

**Status: Phases 1–5.** The composition engine, persistence, a GPU compositor with frame capture, previews and export, audio analysis, word-ID transcript editing, on-device vision, a hands-free autopilot, an MCP server with 158 tools, and the Electron desktop app. Everything is covered by tests, including end-to-end tests that drive the real app window.

## Install the app

Installers are built by the **Build apps** GitHub Actions workflow on every push (download them from the run's *Artifacts*), and attached to a GitHub release when a `v*` tag is pushed. They bundle everything the editor needs, FFmpeg included: no Node.js or Homebrew required.

| Computer | File | How to install |
| --- | --- | --- |
| Mac with Apple Silicon (M1 and later) | `OpenEdits-Studio-<version>-mac-arm64.dmg` | Open the .dmg and drag **OpenEdits Studio** to Applications. |
| Mac with an Intel processor | `OpenEdits-Studio-<version>-mac-x64.dmg` | Same. |
| Chromebook or Linux PC (Intel/AMD) | `OpenEdits-Studio-<version>-linux-amd64.deb` (or `-x86_64.AppImage`) | See *Chromebook* below; on other Linux, `sudo apt install ./OpenEdits-Studio-…-amd64.deb`. |
| Googlebook | The same Linux `.deb`: `-amd64.deb` on Intel/AMD models, `-arm64.deb` on ARM models | See *Googlebook* below: install it in the Terminal, run `openedits-web`, and edit in Chrome. |
| Chromebook or Linux on ARM | `OpenEdits-Studio-<version>-linux-arm64.deb` (or `-arm64.AppImage`) | Same. |
| Windows | `OpenEdits-Studio-<version>-win-x64.exe` | Run the installer. |

**First launch on a Mac.** The app is ad-hoc signed, not signed with an Apple Developer ID, so macOS asks before opening it the first time. Double-click it once, then go to **System Settings → Privacy & Security** and click **Open Anyway** (on older macOS, right-click the app and choose **Open**). To ship without this step, sign and notarize with a Developer ID: set `mac.identity` in `electron-builder.yml` and add the certificate to the workflow's secrets.

**Chromebook.** Turn on Linux (**Settings → About ChromeOS → Developers → Linux development environment**), download the `.deb` for your Chromebook's processor (most are Intel/AMD → `amd64`; ARM Chromebooks such as MediaTek models → `arm64`), then double-click it in the Files app and choose **Install**. OpenEdits Studio then appears in the launcher under *Linux apps*. Video preview and export run on the processor, so expect them to be slower than on a Mac.

**Googlebook.** A Googlebook runs Android apps and has a Linux Terminal (a Debian virtual machine). That Terminal does not open Linux app windows on the Googlebook's desktop yet, but it does pass `localhost` through to the Googlebook's browser. So on a Googlebook the editor runs in the Terminal and you use it in Chrome: the same editor, the same engine, the same exports.

1. Open the **Terminal** app (turn on the Linux Terminal in the Googlebook's settings first if you have not used it yet).
2. Find out which file you need: `dpkg --print-architecture` prints `amd64` or `arm64`. Download the matching `OpenEdits-Studio-<version>-linux-<amd64|arm64>.deb` and put it where the Terminal can see it (the Terminal's own files, or a folder you have shared with it).
3. Install it from the folder the file is in: `sudo apt update && sudo apt install ./OpenEdits-Studio-*.deb`
4. Start the editor: `openedits-web`. It prints a link like `http://localhost:4417/?token=…`. Open that link in Chrome on the Googlebook. If the Googlebook asks whether to allow the port, allow it.
5. Optional: in Chrome's menu choose **Cast, save and share → Install page as app** to get an OpenEdits Studio icon in the launcher and its own window. The Terminal has to be running `openedits-web` whenever you use it; the link is only needed the first time in each browser.

In Chrome, **Import** uploads files from the Googlebook into the editor's workspace (`~/Videos/OpenEdits/uploads` inside Linux), and a finished export has a **Download** button that saves it to the Googlebook's Downloads. Voiceover recording uses the Googlebook's microphone through Chrome. Preview and export run on the processor inside the Linux virtual machine, so give the Terminal as much memory as you can in its settings and expect long exports to take a while. `OPENEDITS_PORT=5000 openedits-web` uses another port. There is no `.apk`: the engine, FFmpeg and the compositor are desktop programs that an Android app cannot run.

The same command works on any Linux machine without a desktop, for example a server reached with `ssh -L 4417:localhost:4417 …`.

**Build an installer yourself:** `npm run dist -- --mac --arm64` (on a Mac; the .dmg needs macOS), `npm run dist -- --linux --x64`, or `npm run dist -- --win --x64`. Output goes to `release/dist`. Run `node scripts/fetch-tools.mjs --platform <darwin|linux|win32> --arch <arm64|x64>` first to bundle FFmpeg; without it the app uses the FFmpeg on the computer's PATH.

## Quick start

```bash
npm install
node node_modules/electron/install.js   # only if the Electron binary did not download during install
npm test                      # builds (including the Swift Vision helper), then runs all tests
node packages/mcp/dist/cli.js doctor
node packages/mcp/dist/cli.js mcp-config   # prints the `claude mcp add ...` line
npm run app                   # builds, then opens the desktop app
```

The app joins the engine already running for the workspace, or starts one. An agent connected over MCP edits the same project you see, and its edits show up live with a note saying who made them. If the engine ever stops, the window restarts it and reconnects on its own, with the project as it was.

### Windows and Linux

The editor runs on macOS, Windows and Linux. You need Node.js 22+ and FFmpeg on the `PATH` (Windows: `winget install Gyan.FFmpeg`; Ubuntu/Debian: `sudo apt install ffmpeg`). Run `node packages/mcp/dist/cli.js doctor` to see what is installed. Some features depend on optional software:

| Feature | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Editing, effects, transitions, color, LUTs, text, audio, export | yes | yes | yes |
| Export encoders | VideoToolbox | libx264 / libx265 (software) | libx264 / libx265 (software) |
| Remove silences | yes | yes | yes (from the audio when there is no transcript) |
| Transcripts, captions, filler and retake removal, auto edit | whisper.cpp | whisper.cpp | whisper.cpp |
| Text to speech | system voices | Windows voices | eSpeak NG (`sudo apt install espeak-ng`) |
| Auto reframe, cutouts, tracking, subject effects | Apple Vision | not available | not available |

The app greys out what this computer cannot do and says what to install. For transcripts, put `whisper-cli` from the [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) on the `PATH` (or set `OPENEDITS_WHISPER` to its path) and download `ggml-large-v3-turbo-q5_0.bin` to the path `doctor` prints. Without a GPU (virtual machines, remote desktops) the preview and exports render in software, which is slower but looks the same.

### Keep generated files out of iCloud

If `~/Documents` syncs to iCloud with "Optimize Mac Storage", macOS can evict files in `node_modules` and the build output. Code that reads an evicted file then waits for it to download, which looks like a hang. This checkout keeps generated folders in `*.nosync` directories, which iCloud skips, behind symlinks: `node_modules -> node_modules.nosync`, `packages/*/dist -> dist.nosync`, `apps/desktop/dist`, `packages/engine/bin`, `.test-media` and `.test-workspaces`. `npm ci` replaces the `node_modules` symlink with a real folder. After running it, move the folder back:

```bash
rm -rf node_modules.nosync && mv node_modules node_modules.nosync && ln -s node_modules.nosync node_modules
```

Connect Claude Code:

```bash
claude mcp add openedits -- node "$PWD/packages/mcp/dist/cli.js" mcp   # run from the repo root
```

## CLI

| Command | What it does |
| --- | --- |
| `openedits serve [--port N] [--web]` | Runs the engine. MCP over Streamable HTTP is at `/mcp`, live patches and UI calls go over the WebSocket at `/live`, and `/health` reports status. With `--web` it also serves the editor to a browser on the same machine and prints its link (this is what `openedits-web` runs). |
| `openedits mcp` | Starts a stdio MCP server. It joins a running engine if there is one; otherwise it hosts one, which other clients can join over HTTP. |
| `openedits call <tool> '<json>'` | Calls a single tool and prints the JSON result. |
| `openedits repl` | Interactive prompt; each line is `<tool> <json>`. |
| `openedits tools [--json]` | Lists implemented and planned tools. |
| `openedits doctor` | Checks ffmpeg, ffprobe, whisper.cpp and the Whisper model. |

`--workspace DIR` (or `$OPENEDITS_WORKSPACE`) points the CLI at a different workspace. The default is `~/Movies/OpenEdits` on macOS and `~/Videos/OpenEdits` on Windows and Linux (an existing `~/Movies/OpenEdits` is kept).

## Conventions (enforced everywhere)

- **Time:**
  - Timeline positions and durations are float seconds.
  - Source timestamps are suffixed `*SourceSeconds`.
  - Keyframe times are `offsetSeconds` measured from the element start, so they move with the clip.
- **Canvas:**
  - Coordinates are normalized to 0..1, with the origin at the top left and +y pointing down.
  - An element's `(x, y)` is its **center**.
  - A media element's size is `baseline fit (cover|contain) × scale`, so changing the aspect ratio or resolution keeps relative placement.
- **Rotation:** degrees, clockwise.
- **Colors:** `#RRGGBB` or `#RRGGBBAA`.
- **Volume:** linear gain from 0 to 10, where 1 is 0 dB and 10 is +20 dB. `setSound` also accepts `volumeDb`.
- **Undo:** every mutating tool call is exactly one undo step. That includes `splitAt` with 1,000 timestamps. `saveRevision` and `revert` give numbered snapshots, and a revert can itself be undone.
- **Concurrency:** mutations accept `expectedVersion` and fail with `VERSION_CONFLICT` if it is stale. Each history entry records who made the edit: `ui`, `cli` or `mcp:<client>`.

## Architecture

```
packages/core     Pure TypeScript with no I/O:
                  - zod schema and migrations
                  - canvas math and timeline solver
                  - ops, keyframes and speed curves
                  - immer-patch history and the catalog
packages/engine   Node runtime:
                  - workspace and Library (Project.db)
                  - per-project SQLite (state, revisions, undo history)
                  - locks, ffprobe and the EngineHost
                  - audio mixdown and DSP, frame server and exporter, job manager
packages/renderer WebGL2 compositor: layers, masks, color pipeline, LUTs, effects,
                  blend modes, transitions, text and caption rasterizing
packages/render-host  Hidden Electron window that runs the compositor for the engine
packages/mcp      Tool registry (defineTool), MCP server, HTTP/WebSocket server,
                  stdio-to-engine proxy, CLI
```

### Rendering

- `evaluateScene` (core) turns the project at a time into an ordered list of layers. The same compositor will draw the desktop UI's preview, so previews, captures and exports match.
- The engine starts a hidden Electron window on first use and stops it after two idle minutes.
- Frames are decoded by FFmpeg (VideoToolbox) and read one-to-one, so frames are exact: tests check that every captured and exported frame is the right source frame, through speed changes, trims, reverse and transitions. Any format FFmpeg reads works without proxies.
- Exports read the composited pixels back and encode with FFmpeg's VideoToolbox H.264/HEVC encoders (or ProRes). Audio comes from the engine's own mixdown (per-clip time-stretch, volume, fades, voice enhance, ducking, limiter).
- Images for agents: `captureFrame`, `frameSheet`, `captureSourceFrames`, `view_media`, `previewVideoFrames` and `view_render` return MCP image content as well as file paths.
- Every effect and transition in the catalog is drawn. Subject effects need their subject mask, which Apple Vision computes (macOS only).
- Built-in camera LUTs are generated from each vendor's published log curve and gamut matrix, with a filmic highlight roll-off. They are a good starting point rather than the vendors' own technical LUTs: Apple Log 2 uses the Apple Log curve, D-Log M the D-Log curve, and Canon and DJI gamuts are approximated by Rec.2020. Custom `.cube` files work too.
- HDR (HLG/PQ) sources are not tone-mapped yet.

### Audio analysis

`loudness` (FFmpeg EBU R128), `audioLevels`, `findPauses`, `quietPoint`, `audioOnsets` (with beat markers), `audioChords`, `audioSpectrum` (hum and whine detection) and `processAudio` (EQ, hum notch, denoise, speech-band voice isolation, LUFS normalization). Each tool can analyze an element (times in timeline seconds), a media file (source seconds) or the whole timeline mix.

### Timeline

- The **main track** is magnetic. It stays gapless while the magnet is on, so inserts, deletes, trims, speed changes and reorders ripple downstream.
- **Free tracks** are typed lanes: overlay, adjustment, shape, text, sticker, caption, music, sfx, voiceover and audio. When a new element would overlap one already on a lane, it moves to a new lane.
- **Ripple tiers:**
  - **Tier 1:** a free element is anchored to the main clip under its start and follows it.
  - **Tier 2:** unanchored free elements downstream of a main-track edit shift by the same amount.

### Persistence

Each project lives at `<workspace>/projects/<id>/project.db`. The document autosaves on every commit, and the undo/redo stacks are persisted too, so undo still works after a restart.

### Live sharing

- One engine owns the workspace and writes `.engine.json` with its port and bearer token (mode 0600).
- `openedits mcp` proxies to that engine, so every agent and the UI see one composition.
- The HTTP server binds to loopback only. It requires the token and rejects foreign Host and Origin headers. The one exception is `/live`, which also accepts `file://`, the origin of the desktop app's page; it still needs the token.

### Browser mode

`openedits serve --web` serves the desktop app's UI as a web page from the engine, for machines where no window can be opened (a Googlebook's Linux Terminal, a headless server).

- The page is the same React UI, built a second time for browsers (`apps/desktop/dist/web`). What the Electron window did with Node is swapped at build time for small stand-ins in `apps/desktop/src/web`: ffmpeg processes for the live preview run beside the engine and stream their frames over a WebSocket (`/web/spawn`), file dialogs become uploads to `<workspace>/uploads`, local files are read through `/web/file` (with range requests), and "Show in file manager" becomes a download.
- The link carries a token that is kept in `<workspace>/.web-token`. Opening it once stores the token in an HttpOnly, SameSite cookie, so the installed web app keeps working across restarts. Requests must come from the page's own origin and name this machine's loopback as their host; the server still listens on loopback only.
- The engine's compositor window is never shown, so without a display server it runs with Chromium's headless platform.

## Desktop app (`apps/desktop`)

- **Process model.** The Electron main process starts or joins `openedits serve` and opens one window. The window is a pure `/live` client: every button, slider and drag calls the same tool handlers agents use. The engine runs in its own process on the Node.js built into Electron and stores projects with Node's built-in SQLite (`node:sqlite`), so the app has no native modules and needs no separate Node install. In the packaged app the same binary also serves as the hidden compositor window (`--openedits-render-host`).
- **Home.** A project grid with search, pinned and favorite filters, rename, delete, and a new project at any aspect. Also the inbox (one click makes a project), autopilot jobs, and the shortcut map picker.
- **Editor.** Four panes:
  - **Media dock:** import, drag and drop, filters, and audio from `brand/music` and `brand/sfx`; text presets and caption styles; filters, effects, transitions, LUTs and stickers. Every filter, effect, transition, adjust preset and LUT tile shows a preview drawn by the real compositor on built-in sample pictures; hovering a tile animates it (effects sweep in, transitions play, LUTs slide a log/Rec.709 divider).
  - **Viewport:** the WebGL compositor, the same one export uses. It has on-canvas move, scale and rotate handles, which preview live and commit one undo step on release, plus a 10% grid and the transport.
  - **Inspector:** the 42 tool panels filtered to the selected clip, with sliders that commit on release, keyframe diamonds at the playhead, curves, HSL, wheels, effects, captions and text-to-speech. With nothing selected it shows canvas, ripple, brief and transcript actions.
  - **Timeline:** ruler and beat markers, scrubbing, lock, mute and hide per track, move, reorder and trim with snapping, moves between the main track and overlays, waveforms, keyframes and transitions, and zoom with Ctrl or Cmd and the wheel.
- **Playback.** Video frames come from the compositor. Audio is the engine's own mixdown (`previewAudio`, cached per project version), which keeps preview and export sounding the same.
- **Recording and shortcuts.** A teleprompter, and a voiceover recorder with a dB meter and countdown. Agents can start and stop a take with `startVoiceoverRecording` and `stopVoiceoverRecording`. Five shortcut maps: Edits, CapCut, Premiere Pro, Final Cut Pro and DaVinci Resolve.
- **Tests.** `apps/desktop/test/ui.test.ts` launches the real app with a hidden window and an MCP agent on the same engine. It checks:
  - the home screen and creating a project
  - agent edits appearing live
  - pixels in the viewport
  - an inspector slider as a single undo step
  - a trim drag on the timeline
  - keyboard split and undo
  - an agent-triggered voiceover take
  
  In tests a generated tone stands in for the microphone, because macOS microphone permission can't be granted headlessly.

### Transcripts and word-ID editing (OpenCut-style)

- `transcribeClip` runs whisper.cpp locally (reusing the model in `~/Movies/OpenCut/models`), in parallel chunks split at quiet points for long media. Every word gets a stable `#id` that never changes or gets reused, so edits stay valid after other cuts.
- Word timing combines Whisper's DTW token alignment with the audio energy, so pauses are where the audio is actually silent.
- `get_transcript` shows the words currently on the timeline with `[pause]` and `[cut]` markers and filler tags.
- `edit` applies `remove_silences`, `remove_fillers`, `remove_retakes`, `cut {from,to}`, `move_to_start`, `auto_zoom`, `captions`, `title` and `brief` as one undo step, saving a revision first. Cuts land inside pauses with padding; generated captions carry the word ids and re-sync after cuts.
- `auto_edit` applies the first pass that STYLE.md describes and returns the rules that need judgment (hook, B-roll, music) as notes. `generateCaptions` captions from the transcript.

### Vision, speech and autopilot

- `detectShots` and `detectCuts` find hard cuts and dissolves frame-accurately (twin-comparison on tiny frame signatures) and group shots by camera angle.
- An Apple Vision helper (`packages/engine/native/vision.swift`, compiled by the build) runs on-device: `detectSubjects` (faces, people, salient regions), `autoReframe` (static or follow framing, or a stacked split screen when two speakers can't share a vertical frame), `trackObject`, `addStickerFromCutout`, and `applySubjectEffect` (background blur, subject glow, outline from per-frame masks).
- `applyTextToSpeech` uses the system's voices (`ttsVoices`): macOS voices, Windows voices, or eSpeak NG on Linux.
- Autopilot: videos dropped in `<workspace>/auto-edit` become projects with the STYLE.md first pass and a final render in the outbox (`openedits autopilot`, `openedits serve --autopilot`, or once with `openedits auto-edit FILE`). Each job runs in its own engine, so it never touches the project you have open. `list_autopilot_jobs` reports them.

### Optional Claude features

`describeClip`, Claude-chosen retakes (`remove_retakes` falls back to a local heuristic otherwise) and free-text `trackObject` prompts call the Claude API, but only when you opt in: set `ANTHROPIC_API_KEY`, or `claude.enabled: true` in `settings.json` after `ant auth login`. Requests use `claude-opus-5-5` with structured outputs and server-side refusal fallback (`fallbacks: "default"`). They send frames or transcript text to Anthropic. Tests use a fake client.

## Catalog

All presets are original to OpenEdits; no assets are copied from other apps. The catalog includes:

- 34 text presets and 39 caption styles
- 22 text animations
- 24 filters and 12 adjust presets
- 16 camera log → Rec.709 LUT entries, plus custom `.cube` files
- 25 effects and 18 transitions
- 20 vector stickers and 4 shapes
- 8 speed-ramp presets
- 42 inspector tool panels

## Roadmap

- **Phase 3: rendering and audio analysis.** Done (see above). Left for later: bundled camera LUTs generated from the vendors' log curves, HDR tone mapping, and media-bin thumbnails.
- **Phase 4: transcripts and AI.** Done (see above). Not done: speaker diarization, and a learned (rather than speech-band) voice isolation model.
- **Phase 5: Electron and React desktop UI.** Done (see above). Not done: thumbnails on video clips and in the media bin, a crop handle on the canvas (crop is in the inspector), app packaging and signing, and a check of real microphone capture (the tests use a generated tone).
