/** What the compositor draws today. Keep in sync with packages/renderer/src/shaders.ts. */
export const RENDER_SUPPORT = {
  effects: ["blur", "vignette", "sharpen", "film_grain", "chromatic_aberration", "pixelate", "posterize", "mirror"],
  transitions: ["dissolve", "fade_black", "fade_white", "slide_left", "slide_right", "slide_up", "slide_down", "push_left", "push_up", "zoom_in", "zoom_out", "wipe_left", "circle_reveal"],
  transitionFallback: "Other transition types render as a dissolve.",
  luts: "Custom .cube LUTs render. Built-in camera LUT ids are stored but not bundled yet.",
  hdr: "HLG/PQ sources are not tone-mapped yet.",
  notYet: ["cutout stickers", "subject effects", "text blur animations (rendered as fades)", "custom imported fonts"],
} as const;
