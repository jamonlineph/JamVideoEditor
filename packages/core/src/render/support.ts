/** What the compositor draws today. Keep in sync with packages/renderer/src/shaders.ts. */
export const RENDER_SUPPORT = {
  effects: ["blur", "vignette", "sharpen", "film_grain", "chromatic_aberration", "pixelate", "posterize", "mirror", "motion_blur", "zoom_blur", "tilt_shift", "glow", "light_leak", "flash", "vhs", "glitch", "halftone", "kaleidoscope", "fisheye", "shake", "zoom_pulse", "denoise"],
  subjectEffects: "outline, subject_glow and background_blur render once their subject mask is computed (Apple Vision, macOS only).",
  transitions: ["dissolve", "fade_black", "fade_white", "slide_left", "slide_right", "slide_up", "slide_down", "push_left", "push_up", "zoom_in", "zoom_out", "wipe_left", "circle_reveal", "spin", "blur_dissolve", "glitch", "whip_pan", "flash"],
  transitionFallback: "Unknown transition types render as a dissolve.",
  luts: "Custom .cube LUTs render. Built-in camera LUTs are generated from the vendors' log curves and gamut matrices (Apple Log 2 and D-Log M use the Apple Log and D-Log curves).",
  hdr: "HLG/PQ sources are not tone-mapped yet.",
  notYet: ["text blur animations (rendered as fades)", "custom imported fonts"],
} as const;
