/**
 * GLSL ES 3.00 sources. Convention: texture row 0 is the TOP of the image everywhere
 * (uploads, framebuffers and readPixels), so pixel y maps straight to clip y without flipping.
 * All layer textures are premultiplied alpha.
 */

export const FULLSCREEN_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
uniform float uFlipY;
out vec2 vUv;
void main() {
  vUv = aPos;
  vec2 clip = aPos * 2.0 - 1.0;
  gl_Position = vec4(clip.x, mix(clip.y, -clip.y, uFlipY), 0.0, 1.0);
}`;

export const COPY_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uOpacity;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = texture(uTex, vUv) * uOpacity; }`;

/** Draws one layer quad with crop, flip, opacity, anti-aliased edges and a parametric mask. */
export const LAYER_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
uniform vec2 uCanvas;
uniform vec2 uCenter;
uniform vec2 uSize;
uniform float uRotation;
out vec2 vPx;
void main() {
  vec2 local = (aPos - 0.5) * (uSize + 2.0);
  vPx = local;
  float c = cos(uRotation);
  float s = sin(uRotation);
  vec2 p = uCenter + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  gl_Position = vec4(p / uCanvas * 2.0 - 1.0, 0.0, 1.0);
}`;

export const LAYER_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uSize;
uniform vec4 uUvRect;      // u0, v0, u1, v1 (crop and flip already applied)
uniform float uOpacity;
uniform int uMaskType;     // 0 none, 1 rectangle, 2 ellipse, 3 line, 4 shutter
uniform vec2 uMaskCenter;  // px from the element center
uniform vec2 uMaskHalf;    // px
uniform float uMaskRadius; // px
uniform float uMaskFeather;// px
uniform float uMaskRotation;
uniform float uMaskInvert;
in vec2 vPx;
out vec4 outColor;

void main() {
  vec2 halfSize = uSize * 0.5;
  float edge = min(halfSize.x - abs(vPx.x), halfSize.y - abs(vPx.y));
  float alpha = clamp(edge + 0.5, 0.0, 1.0);
  vec2 local = clamp(vPx / uSize + 0.5, 0.0, 1.0);
  vec4 color = texture(uTex, mix(uUvRect.xy, uUvRect.zw, local));
  if (uMaskType != 0) {
    vec2 p = vPx - uMaskCenter;
    float c = cos(-uMaskRotation);
    float s = sin(-uMaskRotation);
    p = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
    float sd;
    if (uMaskType == 1) {
      vec2 q = abs(p) - uMaskHalf + uMaskRadius;
      sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uMaskRadius;
    } else if (uMaskType == 2) {
      sd = (length(p / max(uMaskHalf, vec2(0.001))) - 1.0) * min(uMaskHalf.x, uMaskHalf.y);
    } else if (uMaskType == 3) {
      sd = p.y;
    } else {
      sd = abs(p.y) - uMaskHalf.y;
    }
    float f = max(uMaskFeather, 0.75);
    float m = smoothstep(f, -f, sd);
    alpha *= mix(m, 1.0 - m, uMaskInvert);
  }
  outColor = color * (alpha * uOpacity);
}`;

/** Color pipeline: 13-slider grade, 4 wheels, 8-band HSL, curves and a 3D LUT. */
export const COLOR_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D uTex;
uniform sampler2D uCurves;   // 256x1: rgb = per-channel curves, a = master curve
uniform sampler3D uLut;
uniform float uGrade[13];    // normalized to -1..1 (fade 0..1)
uniform vec3 uWheels[4];     // rgb offsets: shadows, midtones, highlights, global
uniform vec3 uHsl[8];        // hue, saturation, luminance per band (-1..1)
uniform float uHasHsl;
uniform float uHasCurves;
uniform float uLutIntensity; // 0 disables
uniform float uLutSize;
in vec2 vUv;
out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  if (d < 1e-5) return vec3(0.0, 0.0, l);
  float s = d / (1.0 - abs(2.0 * l - 1.0) + 1e-5);
  float h;
  if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h * 60.0, clamp(s, 0.0, 1.0), l);
}

vec3 hsl2rgb(vec3 hsl) {
  float c = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
  float hp = mod(hsl.x, 360.0) / 60.0;
  float x = c * (1.0 - abs(mod(hp, 2.0) - 1.0));
  vec3 rgb;
  if (hp < 1.0) rgb = vec3(c, x, 0.0);
  else if (hp < 2.0) rgb = vec3(x, c, 0.0);
  else if (hp < 3.0) rgb = vec3(0.0, c, x);
  else if (hp < 4.0) rgb = vec3(0.0, x, c);
  else if (hp < 5.0) rgb = vec3(x, 0.0, c);
  else rgb = vec3(c, 0.0, x);
  return rgb + (hsl.z - c * 0.5);
}

void main() {
  vec4 src = texture(uTex, vUv);
  if (src.a < 1e-4) { outColor = vec4(0.0); return; }
  vec3 c = src.rgb / src.a;

  c *= exp2(uGrade[0] * 2.0);                       // exposure (+-2 stops)
  c += uGrade[1] * 0.25;                            // brightness
  c = (c - 0.5) * (1.0 + uGrade[2]) + 0.5;          // contrast
  float l = dot(c, LUMA);
  c += uGrade[3] * 0.35 * smoothstep(0.5, 1.0, l);  // highlights
  c += uGrade[4] * 0.35 * (1.0 - smoothstep(0.0, 0.5, l)); // shadows
  float wp = 1.0 - uGrade[5] * 0.25;                // whites
  float bp = -uGrade[6] * 0.25;                     // blacks
  c = (c - bp) / max(wp - bp, 0.05);
  c.r += uGrade[7] * 0.12;                          // temperature
  c.b -= uGrade[7] * 0.12;
  c.g -= uGrade[8] * 0.08;                          // tint (+ = magenta)
  c.rb += uGrade[8] * 0.04;
  l = dot(c, LUMA);
  float chroma = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c = mix(vec3(l), c, 1.0 + uGrade[9] * (1.0 - clamp(chroma, 0.0, 1.0))); // vibrance
  c = mix(vec3(l), c, 1.0 + uGrade[10]);            // saturation
  l = dot(c, LUMA);
  c += uGrade[11] * 0.3 * (1.0 - abs(2.0 * l - 1.0)) * (l - 0.5); // clarity (midtone contrast)
  c = mix(c, c * 0.8 + 0.12, uGrade[12]);           // fade

  l = clamp(dot(c, LUMA), 0.0, 1.0);
  float ws = (1.0 - l) * (1.0 - l);
  float wh = l * l;
  float wm = 1.0 - ws - wh;
  c += uWheels[0] * ws + uWheels[1] * wm + uWheels[2] * wh + uWheels[3];

  if (uHasHsl > 0.5) {
    vec3 hsl = rgb2hsl(clamp(c, 0.0, 1.0));
    float centers[8] = float[8](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 280.0, 320.0);
    float widths[8] = float[8](30.0, 25.0, 30.0, 50.0, 45.0, 45.0, 35.0, 35.0);
    float dh = 0.0; float ds = 0.0; float dl = 0.0;
    for (int i = 0; i < 8; i++) {
      float d = abs(mod(hsl.x - centers[i] + 180.0, 360.0) - 180.0);
      float w = max(0.0, 1.0 - d / widths[i]) * smoothstep(0.02, 0.2, hsl.y);
      dh += uHsl[i].x * 30.0 * w;
      ds += uHsl[i].y * w;
      dl += uHsl[i].z * 0.25 * w;
    }
    hsl.x += dh;
    hsl.y = clamp(hsl.y * (1.0 + ds), 0.0, 1.0);
    hsl.z = clamp(hsl.z + dl, 0.0, 1.0);
    c = hsl2rgb(hsl);
  }

  c = clamp(c, 0.0, 1.0);
  if (uHasCurves > 0.5) {
    vec3 m = vec3(texture(uCurves, vec2(c.r * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).a,
                  texture(uCurves, vec2(c.g * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).a,
                  texture(uCurves, vec2(c.b * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).a);
    c = vec3(texture(uCurves, vec2(m.r * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).r,
             texture(uCurves, vec2(m.g * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).g,
             texture(uCurves, vec2(m.b * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).b);
  }
  if (uLutIntensity > 0.0) {
    vec3 graded = texture(uLut, c * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize).rgb;
    c = mix(c, graded, uLutIntensity);
  }
  outColor = vec4(clamp(c, 0.0, 1.0) * src.a, src.a);
}`;

/** Separable Gaussian blur; run once per axis. */
export const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uStep; // texel step * radius / 8
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = -8; i <= 8; i++) {
    float w = exp(-float(i * i) / 18.0);
    sum += texture(uTex, vUv + uStep * float(i)) * w;
    total += w;
  }
  outColor = sum / total;
}`;

/**
 * Layer effects (one pass each; blur and glow add separable blur passes in the compositor).
 * Texture row 0 is the top; colors are premultiplied. uParams carries each effect's parameters.
 */
export const EFFECT_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform sampler2D uAux;   // second input (glow: the blurred bright pass)
uniform int uType;
uniform float uAmount;    // effect intensity 0..1
uniform vec4 uParams;
uniform vec2 uTexel;
uniform float uTime;      // frame counter (grain)
uniform float uSeconds;   // timeline seconds (animated effects)
in vec2 vUv;
out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const float TAU = 6.2831853;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float noise1(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(hash(vec2(i, 0.37)), hash(vec2(i + 1.0, 0.37)), f * f * (3.0 - 2.0 * f));
}
vec3 hueColor(float deg) {
  vec3 k = mod(vec3(5.0, 3.0, 1.0) + deg / 60.0, 6.0);
  return 1.0 - clamp(min(k, 4.0 - k), 0.0, 1.0);
}
vec3 unpremul(vec4 c) { return c.a > 1e-4 ? c.rgb / c.a : vec3(0.0); }
// Width over height of the layer texture, and one "short side" in uv units on each axis.
float aspect() { return uTexel.y / uTexel.x; }
vec2 shortUv() { return uTexel / max(uTexel.x, uTexel.y); }
vec4 sampleOr(vec2 uv, vec4 outside) {
  return (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? outside : texture(uTex, uv);
}

void main() {
  vec4 c = texture(uTex, vUv);
  if (uType == 1) {                                   // vignette: amount (pre-scaled), softness
    float d = distance(vUv, vec2(0.5)) * 1.41421;
    float soft = mix(0.2, 0.9, uParams.x);
    c.rgb *= 1.0 - uAmount * smoothstep(1.0 - soft, 1.0, d);
  } else if (uType == 2) {                            // sharpen
    vec4 blur = (texture(uTex, vUv + vec2(uTexel.x, 0.0)) + texture(uTex, vUv - vec2(uTexel.x, 0.0)) +
                 texture(uTex, vUv + vec2(0.0, uTexel.y)) + texture(uTex, vUv - vec2(0.0, uTexel.y))) * 0.25;
    c.rgb = clamp(c.rgb + (c.rgb - blur.rgb) * uAmount * 2.0, 0.0, c.a);
  } else if (uType == 3) {                            // film grain: size px
    float n = hash(floor(vUv / (uTexel * max(uParams.x, 1.0))) + uTime) - 0.5;
    c.rgb = clamp(c.rgb + n * uAmount * 0.35 * c.a, 0.0, c.a);
  } else if (uType == 4) {                            // chromatic aberration: angle rad
    vec2 dir = vec2(cos(uParams.x), sin(uParams.x)) * uAmount * 0.02;
    c.r = texture(uTex, vUv + dir).r;
    c.b = texture(uTex, vUv - dir).b;
  } else if (uType == 5) {                            // pixelate: cell px
    vec2 cell = uTexel * max(uParams.x, 1.0);
    c = texture(uTex, (floor(vUv / cell) + 0.5) * cell);
  } else if (uType == 6) {                            // posterize: levels
    float levels = max(uParams.x, 2.0);
    if (c.a > 1e-4) c.rgb = floor(c.rgb / c.a * levels + 0.5) / levels * c.a;
  } else if (uType == 7) {                            // mirror: axis (0 vertical seam, 1 horizontal)
    vec2 uv = uParams.x < 0.5 ? vec2(vUv.x > 0.5 ? 1.0 - vUv.x : vUv.x, vUv.y) : vec2(vUv.x, vUv.y > 0.5 ? 1.0 - vUv.y : vUv.y);
    c = texture(uTex, uv);
  } else if (uType == 8) {                            // motion blur: angle rad, length 0..1
    vec2 d = vec2(cos(uParams.x), sin(uParams.x)) * uParams.y * 0.06 * shortUv();
    vec4 s = vec4(0.0);
    for (int i = -8; i <= 8; i++) s += texture(uTex, vUv + d * float(i) / 8.0);
    c = mix(c, s / 17.0, uAmount);
  } else if (uType == 9) {                            // zoom blur: strength 0..1
    vec2 d = (vUv - 0.5) * uParams.x * 0.3;
    vec4 s = vec4(0.0);
    for (int i = 0; i < 16; i++) s += texture(uTex, vUv - d * float(i) / 15.0);
    c = mix(c, s / 16.0, uAmount);
  } else if (uType == 10) {                           // tilt shift: focus line y, sharp band width
    float f = smoothstep(uParams.y * 0.5, uParams.y * 0.5 + 0.25, abs(vUv.y - uParams.x));
    vec2 r = f * 0.025 * shortUv();
    vec4 s = c;
    for (int i = 0; i < 24; i++) {
      float a = float(i) * 2.39996;
      float rr = sqrt((float(i) + 0.5) / 24.0);
      s += texture(uTex, vUv + vec2(cos(a), sin(a)) * rr * r);
    }
    c = mix(c, s / 25.0, uAmount);
  } else if (uType == 11) {                           // glow, step 1: keep what is brighter than the threshold
    float l = dot(unpremul(c), LUMA);
    c *= smoothstep(uParams.x, min(1.0, uParams.x + 0.25), l);
  } else if (uType == 12) {                           // glow, step 2: add the blurred highlights
    vec4 g = texture(uAux, vUv) * uAmount * 1.6;
    float a = max(c.a, min(1.0, g.a));
    c = vec4(min(c.rgb + g.rgb, vec3(a)), a);
  } else if (uType == 13) {                           // light leak: hue deg, speed
    float t = uSeconds * max(uParams.y, 0.05) * 0.35;
    vec2 center = vec2(0.1 + 0.8 * noise1(t), 0.05 + 0.35 * noise1(t + 17.0));
    float d = distance(vUv * vec2(aspect(), 1.0), center * vec2(aspect(), 1.0));
    float leak = smoothstep(0.95, 0.0, d) * (0.55 + 0.45 * noise1(t * 1.7 + 5.0)) * uAmount;
    vec3 tint = mix(hueColor(uParams.x), vec3(1.0, 0.9, 0.7), 0.25) * leak * c.a;
    c.rgb = 1.0 - (1.0 - c.rgb) * (1.0 - tint);       // screen
    c.rgb = min(c.rgb, vec3(c.a));
  } else if (uType == 14) {                           // flash: Hz
    float pulse = uParams.x > 0.0 ? pow(0.5 + 0.5 * cos(TAU * uParams.x * uSeconds), 12.0) : 0.0;
    c.rgb = mix(c.rgb, vec3(c.a), pulse * uAmount);
  } else if (uType == 15) {                           // VHS: tracking 0..1, noise 0..1
    float frame = floor(uSeconds * 30.0);
    float line = floor(vUv.y / uTexel.y);
    float band = exp(-pow((fract(vUv.y + uSeconds * 0.18) - 0.5) * 18.0, 2.0));
    float jitter = (hash(vec2(line * 0.013, frame)) - 0.5) * uParams.x * 0.006 + band * uParams.x * 0.03;
    vec2 uv = vUv + vec2(jitter, 0.0);
    vec4 base = texture(uTex, uv);
    float ca = 0.003 + 0.004 * uParams.x;
    vec3 col = vec3(texture(uTex, uv + vec2(ca, 0.0)).r, base.g, texture(uTex, uv - vec2(ca, 0.0)).b);
    col *= 0.88 + 0.12 * sin(line * 3.14159 * 0.5);
    col = mix(col, vec3(dot(col, LUMA)), 0.25);
    col += (hash(vUv * 731.0 + frame) - 0.5) * uParams.y * 0.35 * base.a;
    c = mix(c, vec4(clamp(col, 0.0, base.a), base.a), uAmount);
  } else if (uType == 16) {                           // glitch: strength 0..1, speed
    float t = floor(uSeconds * max(uParams.y, 0.1) * 4.0);
    float burst = step(0.5, hash(vec2(t, 3.1)));
    float rows = floor(vUv.y * (6.0 + 26.0 * hash(vec2(t, 7.0))));
    float shift = (hash(vec2(rows, t)) - 0.5) * 0.25 * uParams.x * burst * step(0.55, hash(vec2(rows * 1.7, t + 1.0)));
    vec2 uv = vec2(vUv.x + shift, vUv.y);
    float ca = 0.02 * uParams.x * burst;
    vec4 g = texture(uTex, uv);
    g.r = texture(uTex, uv + vec2(ca, 0.0)).r;
    g.b = texture(uTex, uv - vec2(ca, 0.0)).b;
    c = mix(c, g, uAmount);
  } else if (uType == 17) {                           // halftone: dot pitch px
    float cell = max(uParams.x, 2.0);
    mat2 rot = mat2(0.70711, 0.70711, -0.70711, 0.70711);
    vec2 px = rot * (vUv / uTexel);
    vec2 centerPx = (floor(px / cell) + 0.5) * cell;
    vec4 s = texture(uTex, (transpose(rot) * centerPx) * uTexel);
    float r = sqrt(clamp(1.0 - dot(unpremul(s), LUMA), 0.0, 1.0)) * cell * 0.7071;
    float ink = 1.0 - smoothstep(r - 0.75, r + 0.75, distance(px, centerPx));
    vec3 paper = vec3(0.97, 0.96, 0.93);
    c = mix(c, vec4(mix(paper, vec3(0.05), ink) * c.a, c.a), uAmount);
  } else if (uType == 18) {                           // kaleidoscope: segments
    vec2 p = (vUv - 0.5) * vec2(aspect(), 1.0);
    float seg = TAU / max(uParams.x, 2.0);
    float a = mod(atan(p.y, p.x), seg);
    a = abs(a - seg * 0.5);
    vec2 q = vec2(cos(a), sin(a)) * length(p) / vec2(aspect(), 1.0);
    c = mix(c, texture(uTex, q + 0.5), uAmount);
  } else if (uType == 19) {                           // fisheye: strength 0..1 (edges stay put, the middle bulges)
    vec2 p = (vUv * 2.0 - 1.0) * vec2(aspect(), 1.0) / max(aspect(), 1.0);
    float r2 = dot(p, p);
    float k = uParams.x * 0.65;
    vec2 q = p * (1.0 - k + k * r2) * max(aspect(), 1.0) / vec2(aspect(), 1.0);
    c = mix(c, sampleOr(q * 0.5 + 0.5, vec4(0.0)), uAmount);
  } else if (uType == 20) {                           // camera shake: strength 0..1, Hz
    float t = uSeconds * max(uParams.y, 0.1);
    float s = uParams.x * uAmount;
    vec2 off = vec2(noise1(t) - 0.5, noise1(t + 31.7) - 0.5) * s * 0.08;
    float zoom = 1.0 + s * 0.09;
    c = texture(uTex, (vUv - 0.5) / zoom + 0.5 + off / zoom);
  } else if (uType == 21) {                           // zoom pulse: strength 0..1, Hz
    float pulse = uParams.y > 0.0 ? pow(0.5 + 0.5 * cos(TAU * uParams.y * uSeconds), 4.0) : 0.0;
    c = texture(uTex, (vUv - 0.5) / (1.0 + uParams.x * 0.3 * pulse * uAmount) + 0.5);
  } else if (uType == 22) {                           // denoise: strength 0..1 (edge-preserving)
    vec4 sum = vec4(0.0);
    float wsum = 0.0;
    float range = 0.01 + 0.09 * uParams.x;
    for (int y = -2; y <= 2; y++) {
      for (int x = -2; x <= 2; x++) {
        vec4 s = texture(uTex, vUv + vec2(float(x), float(y)) * uTexel * 1.5);
        vec3 d = s.rgb - c.rgb;
        float w = exp(-float(x * x + y * y) / 4.5) * exp(-dot(d, d) / range);
        sum += s * w;
        wsum += w;
      }
    }
    c = mix(c, sum / wsum, uAmount);
  }
  outColor = c;
}`;

/** Effects limited to a subject mask: 1 background_blur, 2 subject_glow, 3 outline. */
export const SUBJECT_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform sampler2D uBlurTex;
uniform sampler2D uMask;
uniform sampler2D uMaskBlur;
uniform int uType;
uniform vec3 uColor;
uniform float uAmount;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUv);
  float m = clamp(texture(uMask, vUv).r, 0.0, 1.0);
  if (uType == 1) {
    vec4 b = texture(uBlurTex, vUv);
    outColor = mix(c, mix(b, c, m), uAmount);
  } else if (uType == 2) {
    float g = texture(uMaskBlur, vUv).r;
    float halo = clamp(g * 1.8, 0.0, 1.0) * (1.0 - m) * uAmount;
    outColor = vec4(min(c.rgb + uColor * halo, vec3(1.0)), max(c.a, halo));
  } else {
    float g = texture(uMaskBlur, vUv).r;
    float ring = smoothstep(0.02, 0.12, g) * (1.0 - smoothstep(0.35, 0.6, m)) * uAmount;
    outColor = mix(c, vec4(uColor, 1.0), ring);
  }
}`;

export const SUBJECT_TYPES: Record<string, number> = { background_blur: 1, subject_glow: 2, outline: 3 };

/** Composites a premultiplied layer over the opaque backdrop with a blend mode. */
export const BLEND_FS = `#version 300 es
precision highp float;
uniform sampler2D uBase;
uniform sampler2D uLayer;
uniform int uMode;
in vec2 vUv;
out vec4 outColor;

float softLight(float b, float s) {
  return s < 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b) : b + (2.0 * s - 1.0) * ((b < 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b)) - b);
}

void main() {
  vec3 b = texture(uBase, vUv).rgb;
  vec4 layer = texture(uLayer, vUv);
  if (layer.a < 1e-4) { outColor = vec4(b, 1.0); return; }
  vec3 s = layer.rgb / layer.a;
  vec3 r;
  if (uMode == 1) r = b * s;                                   // multiply
  else if (uMode == 2) r = 1.0 - (1.0 - b) * (1.0 - s);        // screen
  else if (uMode == 3) r = mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b)); // overlay
  else if (uMode == 4) r = min(b, s);                          // darken
  else if (uMode == 5) r = max(b, s);                          // lighten
  else if (uMode == 6) r = min(vec3(1.0), b / max(1.0 - s, vec3(1e-4))); // colorDodge
  else if (uMode == 7) r = 1.0 - min(vec3(1.0), (1.0 - b) / max(s, vec3(1e-4))); // colorBurn
  else if (uMode == 8) r = vec3(softLight(b.r, s.r), softLight(b.g, s.g), softLight(b.b, s.b));
  else if (uMode == 9) r = mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, s)); // hardLight
  else if (uMode == 10) r = abs(b - s);                        // difference
  else if (uMode == 11) r = min(vec3(1.0), b + s);             // add
  else r = s;
  outColor = vec4(mix(b, r, layer.a), 1.0);
}`;

export const TRANSITION_FS = `#version 300 es
precision highp float;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform int uType;
uniform float uProgress;
uniform float uAspect;
in vec2 vUv;
out vec4 outColor;

void main() {
  float p = uProgress;
  float e = p * p * (3.0 - 2.0 * p);
  vec2 uv = vUv;
  vec4 a = texture(uFrom, uv);
  vec4 b = texture(uTo, uv);
  vec4 c;
  if (uType == 1) c = p < 0.5 ? mix(a, vec4(0.0, 0.0, 0.0, 1.0), p * 2.0) : mix(vec4(0.0, 0.0, 0.0, 1.0), b, p * 2.0 - 1.0);
  else if (uType == 2) c = p < 0.5 ? mix(a, vec4(1.0), p * 2.0) : mix(vec4(1.0), b, p * 2.0 - 1.0);
  else if (uType == 3) c = uv.x >= 1.0 - e ? texture(uTo, uv - vec2(1.0 - e, 0.0)) : a;                  // slide_left
  else if (uType == 4) c = uv.x < e ? texture(uTo, uv + vec2(1.0 - e, 0.0)) : a;                          // slide_right
  else if (uType == 5) c = uv.y >= 1.0 - e ? texture(uTo, uv - vec2(0.0, 1.0 - e)) : a;                  // slide_up
  else if (uType == 6) c = uv.y < e ? texture(uTo, uv + vec2(0.0, 1.0 - e)) : a;                          // slide_down
  else if (uType == 7) c = uv.x < 1.0 - e ? texture(uFrom, uv + vec2(e, 0.0)) : texture(uTo, uv - vec2(1.0 - e, 0.0)); // push_left
  else if (uType == 8) c = uv.y < 1.0 - e ? texture(uFrom, uv + vec2(0.0, e)) : texture(uTo, uv - vec2(0.0, 1.0 - e)); // push_up
  else if (uType == 9) c = mix(texture(uFrom, (uv - 0.5) / (1.0 + e) + 0.5), b, smoothstep(0.2, 0.8, p));             // zoom_in
  else if (uType == 10) c = mix(a, texture(uTo, (uv - 0.5) / (2.0 - e) + 0.5), smoothstep(0.2, 0.8, p));              // zoom_out
  else if (uType == 11) c = mix(a, b, smoothstep(-0.02, 0.02, uv.x - (1.0 - e)));                                      // wipe_left
  else if (uType == 12) {                                                                                              // circle_reveal
    float d = length((uv - 0.5) * vec2(uAspect, 1.0));
    float r = e * length(vec2(uAspect, 1.0)) * 0.5;
    c = mix(b, a, smoothstep(-0.005, 0.005, d - r));
  }
  else if (uType == 13) {                                                                                              // spin: turn and zoom out, then in
    float ang = e * 6.2831853;
    float zoom = 1.0 + sin(3.14159 * p) * 1.4;
    vec2 q = (uv - 0.5) * vec2(uAspect, 1.0) * zoom;
    q = vec2(q.x * cos(ang) - q.y * sin(ang), q.x * sin(ang) + q.y * cos(ang)) / vec2(uAspect, 1.0) + 0.5;
    bool inside = q.x >= 0.0 && q.y >= 0.0 && q.x <= 1.0 && q.y <= 1.0;
    vec4 from = inside ? texture(uFrom, q) : vec4(0.0, 0.0, 0.0, 1.0);
    vec4 to = inside ? texture(uTo, q) : vec4(0.0, 0.0, 0.0, 1.0);
    c = mix(from, to, smoothstep(0.4, 0.6, p));
  }
  else if (uType == 14) {                                                                                              // blur_dissolve
    float r = sin(3.14159 * p) * 0.03;
    vec4 sa = a;
    vec4 sb = b;
    for (int i = 0; i < 16; i++) {
      float ang = float(i) * 2.39996;
      vec2 o = vec2(cos(ang), sin(ang)) * sqrt((float(i) + 0.5) / 16.0) * r * vec2(1.0, uAspect);
      sa += texture(uFrom, uv + o);
      sb += texture(uTo, uv + o);
    }
    c = mix(sa, sb, e) / 17.0;
  }
  else if (uType == 15) {                                                                                              // glitch
    float burst = sin(3.14159 * p);
    float t = floor(p * 24.0);
    float rows = floor(uv.y * (8.0 + 20.0 * fract(sin(t * 12.9898) * 43758.5453)));
    float h = fract(sin(dot(vec2(rows, t), vec2(12.9898, 78.233))) * 43758.5453);
    vec2 q = vec2(uv.x + (h - 0.5) * 0.3 * burst * step(0.5, h), uv.y);
    float ca = 0.03 * burst;
    vec4 from = vec4(texture(uFrom, q + vec2(ca, 0.0)).r, texture(uFrom, q).g, texture(uFrom, q - vec2(ca, 0.0)).b, 1.0);
    vec4 to = vec4(texture(uTo, q + vec2(ca, 0.0)).r, texture(uTo, q).g, texture(uTo, q - vec2(ca, 0.0)).b, 1.0);
    c = p < 0.5 ? from : to;
  }
  else if (uType == 16) {                                                                                              // whip_pan: fast push with motion blur
    vec4 s = vec4(0.0);
    float blur = sin(3.14159 * p) * 0.12;
    for (int i = -6; i <= 6; i++) {
      vec2 w = uv + vec2(float(i) / 6.0 * blur, 0.0);
      s += w.x < 1.0 - e ? texture(uFrom, w + vec2(e, 0.0)) : texture(uTo, w - vec2(1.0 - e, 0.0));
    }
    c = s / 13.0;
  }
  else if (uType == 17) {                                                                                              // flash: cut under a white flash
    float w = pow(1.0 - abs(2.0 * p - 1.0), 2.0);
    c = mix(p < 0.5 ? a : b, vec4(1.0), w);
  }
  else c = mix(a, b, p);
  outColor = c;
}`;

export const TRANSITION_TYPES: Record<string, number> = {
  dissolve: 0,
  blur_dissolve: 14,
  spin: 13,
  glitch: 15,
  fade_black: 1,
  fade_white: 2,
  flash: 17,
  slide_left: 3,
  slide_right: 4,
  slide_up: 5,
  slide_down: 6,
  push_left: 7,
  whip_pan: 16,
  push_up: 8,
  zoom_in: 9,
  zoom_out: 10,
  wipe_left: 11,
  circle_reveal: 12,
};

/** Transition ids drawn with their own shader (others fall back to a dissolve). */
export const NATIVE_TRANSITIONS = Object.keys(TRANSITION_TYPES);

export const BLEND_MODES: Record<string, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  colorDodge: 6,
  colorBurn: 7,
  softLight: 8,
  hardLight: 9,
  difference: 10,
  add: 11,
};

/** Effect ids drawn by EFFECT_FS (blur and glow also use the separable blur pass). */
export const EFFECT_TYPES: Record<string, number> = {
  vignette: 1,
  sharpen: 2,
  film_grain: 3,
  chromatic_aberration: 4,
  pixelate: 5,
  posterize: 6,
  mirror: 7,
  motion_blur: 8,
  zoom_blur: 9,
  tilt_shift: 10,
  glow: 11,
  light_leak: 13,
  flash: 14,
  vhs: 15,
  glitch: 16,
  halftone: 17,
  kaleidoscope: 18,
  fisheye: 19,
  shake: 20,
  zoom_pulse: 21,
  denoise: 22,
};

/** The second glow pass (adds the blurred highlights back). */
export const GLOW_ADD = 12;

/** Effects the compositor can draw today (blur is separable, the rest single-pass). */
export const SUPPORTED_EFFECTS = ["blur", ...Object.keys(EFFECT_TYPES)];
export const SUPPORTED_SUBJECT_EFFECTS = Object.keys(SUBJECT_TYPES);
