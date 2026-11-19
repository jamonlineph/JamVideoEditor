const paths = {
  media: "M4 5h16v14H4z M4 16l5-5 4 4 2-2 5 5 M15 9h.01",
  audio: "M9 18V6l11-2v12 M9 17c0 2-4 3-5 1s2-4 5-3 M20 15c0 2-4 3-5 1s2-4 5-3",
  text: "M5 18l5-12 5 12 M7 14h6 M20 18v-7 M17 11h6",
  captions: "M3 6h18v12H3z M10 10H7v4h3 M17 10h-3v4h3",
  effects: "M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z",
  transitions: "M4 6l8 6-8 6z M20 6l-8 6 8 6z",
  filters: "M4 7h16 M4 12h16 M4 17h16 M9 5v4 M15 10v4 M10 15v4",
  stickers: "M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7l-7 7H6a2 2 0 0 1-2-2z M13 20v-5a2 2 0 0 1 2-2h5 M8 8h.01 M15 8h.01 M8 12c1.2 1 2.4 1.3 3 1",
  voice: "M9 6a3 3 0 1 1 6 0v5a3 3 0 1 1-6 0z M5 11a7 7 0 0 0 14 0 M12 18v3 M8 21h8",
  inspector: "M3 5h18v14H3z M14 5v14 M17 9h1 M17 12h1",
  library: "M3 5h18v14H3z M9 5v14 M6 9h.01 M6 12h.01",
  back: "M14 5l-7 7 7 7",
  close: "M6 6l12 12 M18 6L6 18",
  search: "M15 15l5 5 M10.5 16a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11Z",
  export: "M12 15V3 M8 7l4-4 4 4 M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7",
  timeline: "M4 5h16v14H4z M4 10h16 M8 13v3 M12 13v3 M16 13v3",
  undo: "M9 6l-4 4 4 4 M5 10h10a4 4 0 0 1 0 8",
  redo: "M15 6l4 4-4 4 M19 10H9a4 4 0 0 0 0 8",
  split: "M7.5 8.5l9 10 M16.5 5.5l-9 10 M8 6.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z M8 17.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z",
  delete: "M5 6h14 M9 6V3h6v3 M7 6l1 14h8l1-14 M10 10v6 M14 10v6",
  lock: "M6 10h12v10H6z M9 10V7a3 3 0 1 1 6 0v3 M12 14v2",
  unlock: "M6 10h12v10H6z M9 10V7a3 3 0 0 1 5.8-1 M12 14v2",
  eye: "M3 12s3-5 9-5 9 5 9 5-3 5-9 5-9-5-9-5z M12 12h.01",
  eyeOff: "M3 12s3-5 9-5c2 0 4 .7 5.5 1.6 M21 12s-3 5-9 5c-2 0-4-.7-5.5-1.6 M4 4l16 16",
  sound: "M4 10h3l4-4v12l-4-4H4z M15 9a5 5 0 0 1 0 6 M18 6a9 9 0 0 1 0 12",
  muted: "M4 10h3l4-4v12l-4-4H4z M15 10l5 5 M20 10l-5 5",
  storage: "M5 5h14l2 9v5H3v-5z M3 14h18 M7 17h.01 M11 17h.01",
} satisfies Record<string, string>;

export type EditorIconName = keyof typeof paths;

export function EditorIcon({ name }: { name: EditorIconName }) {
  return (
    <svg className="editor-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name]} />
    </svg>
  );
}
