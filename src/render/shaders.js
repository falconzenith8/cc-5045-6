// GLSL sources for the temporal denoising pipeline.
//
// Conventions documented here are normative for the whole project:
//   * Camera: eye/target/up, forward = normalize(target - eye), right-handed.
//   * Screen pixels: bottom-left origin, +x right, +y up (WebGL framebuffer).
//     Pixel centers are (i + 0.5, j + 0.5).
//   * Motion vectors: stored in framebuffer pixels; value = prevPixel - curPixel
//     for the SAME world-space surface point, projected with the previous
//     frame's camera. Moving objects therefore have their own vectors; they are
//     not approximated by the camera transform alone.
//   * Depth: linear distance along the camera forward axis (view-space z).

export const COMMON_GLSL = /* glsl */ `
precision highp float;
precision highp int;

#define PI 3.14159265359
#define MAX_SPHERES 8
#define MAX_BOXES 8
#define EPS 1e-4

uniform int uSphereCount;
uniform int uBoxCount;
uniform vec4 uSphBase[MAX_SPHERES];      // xyz center, w radius
uniform vec4 uSphMotionA[MAX_SPHERES];   // kind, t0, w, phase
uniform vec4 uSphMotionB[MAX_SPHERES];   // vel or amp
uniform vec4 uSphAlbedo[MAX_SPHERES];
uniform vec4 uSphEmission[MAX_SPHERES];
uniform float uLightEmissionScale;

uniform vec4 uBoxBase[MAX_BOXES];        // xyz center, w checker flag
uniform vec4 uBoxHalf[MAX_BOXES];
uniform vec4 uBoxMotionA[MAX_BOXES];
uniform vec4 uBoxMotionB[MAX_BOXES];
uniform vec4 uBoxAlbedo[MAX_BOXES];
uniform vec4 uBoxEmission[MAX_BOXES];

uniform int uLightIndex;
uniform float uTime;
uniform float uPrevTime;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

uint hashU(uint x) {
  x ^= x >> 16;
  x *= 0x7feb352dU;
  x ^= x >> 15;
  x *= 0x846ca68bU;
  x ^= x >> 16;
  return x;
}

float rand(inout uint state) {
  state = hashU(state);
  return float(state) * (1.0 / 4294967295.0);
}

uint seedFrom(vec2 frag, int frame, int sampleIndex) {
  uint x = uint(frag.x) * 1973u + uint(frag.y) * 9277u + uint(frame) * 26699u + uint(sampleIndex) * 7027u;
  return hashU(x + 1u);
}

vec3 cosineSample(vec3 n, inout uint state) {
  float u1 = rand(state);
  float u2 = rand(state);
  float r = sqrt(u1);
  float phi = 2.0 * PI * u2;
  vec3 t = normalize(abs(n.y) < 0.999 ? cross(n, vec3(0.0, 1.0, 0.0)) : vec3(1.0, 0.0, 0.0));
  vec3 b = cross(n, t);
  return normalize(t * (r * cos(phi)) + b * (r * sin(phi)) + n * sqrt(max(0.0, 1.0 - u1)));
}

vec3 motionCenter(vec4 base, vec4 mA, vec4 mB, float time) {
  int kind = int(mA.x + 0.5);
  if (kind == 1) {
    float dt = max(0.0, time - mA.y);
    return base.xyz + mB.xyz * dt;
  }
  if (kind == 2) {
    float s = sin(mA.z * time + mA.w);
    return base.xyz + mB.xyz * s;
  }
  return base.xyz;
}

float skyRadiance(vec3 dir) {
  float t = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  return mix(0.018, 0.075, t);
}

struct Hit {
  bool hit;
  float t;
  vec3 p;
  vec3 n;
  vec3 albedo;
  vec3 emission;
  int id;
  int sphereIndex;
  int boxIndex;
};

void testSphere(vec4 base, vec4 mA, vec4 mB, vec4 albedo, vec4 emission, float time,
                int idx, vec3 ro, vec3 rd, inout Hit h) {
  vec3 c = motionCenter(base, mA, mB, time);
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float cc = dot(oc, oc) - base.w * base.w;
  float disc = b * b - cc;
  if (disc < 0.0) return;
  float sd = sqrt(disc);
  float t = -b - sd;
  if (t < 1e-3) t = -b + sd;
  if (t < 1e-3 || t >= h.t) return;
  vec3 p = ro + rd * t;
  h.hit = true;
  h.t = t;
  h.p = p;
  h.n = normalize(p - c);
  h.albedo = albedo.xyz;
  h.emission = emission.xyz;
  h.id = idx + 1;
  h.sphereIndex = idx;
  h.boxIndex = -1;
}

void testBox(vec4 base, vec4 ext, vec4 mA, vec4 mB, vec4 albedo, vec4 emission, int idx,
             vec3 ro, vec3 rd, inout Hit h) {
  vec3 c = motionCenter(base, mA, mB, uTime);
  vec3 lo = c - ext.xyz;
  vec3 hi = c + ext.xyz;
  vec3 inv = 1.0 / rd;
  vec3 t0 = (lo - ro) * inv;
  vec3 t1 = (hi - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tn = max(max(tmin.x, tmin.y), tmin.z);
  float tf = min(min(tmax.x, tmax.y), tmax.z);
  if (tn > tf || tf < 1e-3 || tn >= h.t) return;
  float t = tn > 1e-3 ? tn : tf;
  if (t < 1e-3 || t >= h.t) return;
  vec3 p = ro + rd * t;
  vec3 n;
  if (tn > 1e-3) {
    // Which slab produced tn.
    if (tn == tmin.x) n = vec3(-sign(rd.x), 0.0, 0.0);
    else if (tn == tmin.y) n = vec3(0.0, -sign(rd.y), 0.0);
    else n = vec3(0.0, 0.0, -sign(rd.z));
  } else {
    if (tf == tmax.x) n = vec3(sign(rd.x), 0.0, 0.0);
    else if (tf == tmax.y) n = vec3(0.0, sign(rd.y), 0.0);
    else n = vec3(0.0, 0.0, sign(rd.z));
  }
  vec3 a = albedo.xyz;
  if (base.w > 0.5) {
    float scale = 1.15;
    vec2 q = floor(p.xz / scale);
    float chk = mod(q.x + q.y, 2.0);
    a *= mix(0.72, 1.0, chk);
  }
  h.hit = true;
  h.t = t;
  h.p = p;
  h.n = n;
  h.albedo = a;
  h.emission = emission.xyz;
  h.id = 101 + idx;
  h.sphereIndex = -1;
  h.boxIndex = idx;
}

Hit trace(vec3 ro, vec3 rd, float tmax, float time) {
  Hit h;
  h.hit = false;
  h.t = tmax;
  h.sphereIndex = -1;
  h.boxIndex = -1;
  for (int i = 0; i < MAX_SPHERES; i++) {
    if (i >= uSphereCount) break;
    testSphere(uSphBase[i], uSphMotionA[i], uSphMotionB[i], uSphAlbedo[i], uSphEmission[i], time, i, ro, rd, h);
  }
  for (int i = 0; i < MAX_BOXES; i++) {
    if (i >= uBoxCount) break;
    testBox(uBoxBase[i], uBoxHalf[i], uBoxMotionA[i], uBoxMotionB[i], uBoxAlbedo[i], uBoxEmission[i], i, ro, rd, h);
  }
  return h;
}

bool occluded(vec3 ro, vec3 target) {
  vec3 d = target - ro;
  float dist = length(d);
  vec3 rd = d / dist;
  Hit h = trace(ro + rd * 2e-3, rd, dist - 2e-3, uTime);
  return h.hit;
}

vec3 sampleLight(vec3 p, vec3 n, inout uint state, float radius, vec3 lightCenter, vec3 lightEmission) {
  // Uniform area sampling on the emissive sphere.
  float u1 = rand(state);
  float u2 = rand(state);
  float z = 1.0 - 2.0 * u1;
  float r = sqrt(max(0.0, 1.0 - z * z));
  float phi = 2.0 * PI * u2;
  vec3 dir = vec3(r * cos(phi), r * sin(phi), z);
  vec3 lp = lightCenter + dir * radius;
  vec3 ln = dir;
  vec3 toL = lp - p;
  float d2 = dot(toL, toL);
  float dist = sqrt(d2);
  vec3 wi = toL / dist;
  float cosS = max(dot(n, wi), 0.0);
  float cosL = max(dot(ln, wi), 0.0);
  if (cosS <= 0.0 || cosL <= 0.0) return vec3(0.0);
  if (occluded(p, lp)) return vec3(0.0);
  float pdfArea = 1.0 / (4.0 * PI * radius * radius);
  return lightEmission * (cosS * cosL / (d2 * pdfArea));
}

vec3 directLight(vec3 p, vec3 n, inout uint state, vec3 lightCenter, float radius, vec3 lightEmission) {
  return sampleLight(p, n, state, radius, lightCenter, lightEmission) / PI;
}

vec3 shadePoint(Hit h, inout uint state, vec3 lightCenter, float radius, vec3 lightEmission) {
  if (!h.hit) return vec3(0.0);
  vec3 L = h.emission;
  if (h.emission.x + h.emission.y + h.emission.z > 0.0) {
    return L;
  }
  L += h.albedo * directLight(h.p + h.n * 1e-3, h.n, state, lightCenter, radius, lightEmission);
  // One diffuse bounce with NEE (single-bounce GI).
  vec3 wi = cosineSample(h.n, state);
  Hit h2 = trace(h.p + h.n * 2e-3, wi, 1e9, uTime);
  if (h2.hit) {
    if (h2.emission.x + h2.emission.y + h2.emission.z > 0.0) {
      // Avoid double counting the directly sampled light; BSDF hits on the
      // emissive sphere are skipped (NEE already accounts for it).
    } else {
      L += h.albedo * h2.albedo * directLight(h2.p + h2.n * 1e-3, h2.n, state, lightCenter, radius, lightEmission);
    }
  } else {
    L += h.albedo * skyRadiance(wi);
  }
  return L;
}
`;

const HEADER = `#version 300 es\n` + COMMON_GLSL;

export const PATHTRACE_FS = HEADER + /* glsl */ `
uniform vec2 uResolution;
uniform int uFrame;
uniform int uSampleIndex;
uniform vec2 uJitter;            // subpixel offset in pixels
uniform vec3 uCamPos;
uniform vec3 uCamForward;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform float uTanHalfFov;
uniform float uAspect;

uniform vec3 uPrevCamPos;
uniform vec3 uPrevCamForward;
uniform vec3 uPrevCamRight;
uniform vec3 uPrevCamUp;
uniform float uPrevTanHalfFov;
uniform mat4 uPrevViewProj;

uniform float uMotionScale;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outNormalDepth;
layout(location = 2) out vec4 outMotion;
layout(location = 3) out vec4 outAux;

vec3 prevCenterOfSphere(int i) {
  return motionCenter(uSphBase[i], uSphMotionA[i], uSphMotionB[i], uPrevTime);
}

vec3 prevCenterOfBox(int i) {
  return motionCenter(uBoxBase[i], uBoxMotionA[i], uBoxMotionB[i], uPrevTime);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 samplePixel = frag + uJitter;
  vec2 ndc = (samplePixel / uResolution) * 2.0 - 1.0;
  vec3 rd = normalize(
    uCamForward +
    uCamRight * (ndc.x * uTanHalfFov * uAspect) +
    uCamUp * (ndc.y * uTanHalfFov)
  );

  uint state = seedFrom(frag, uFrame, uSampleIndex);
  float t = uTime;
  vec3 lightCenter = motionCenter(uSphBase[uLightIndex], uSphMotionA[uLightIndex], uSphMotionB[uLightIndex], t);
  float radius = uSphBase[uLightIndex].w;
  vec3 lightEmission = uSphEmission[uLightIndex].xyz * uLightEmissionScale;

  Hit h = trace(uCamPos, rd, 1e9, t);
  vec3 color = shadePoint(h, state, lightCenter, radius, lightEmission);

  vec3 normal = vec3(0.0, 1.0, 0.0);
  float depth = 1e9;
  vec2 motion = vec2(0.0);
  float expectedPrevDepth = 1e9;
  float motionValid = 0.0;
  float objId = 0.0;

  if (h.hit) {
    normal = h.n;
    depth = dot(h.p - uCamPos, uCamForward);
    objId = float(h.id);

    vec3 prevCenter;
    vec3 curCenter;
    if (h.sphereIndex >= 0) {
      prevCenter = prevCenterOfSphere(h.sphereIndex);
      curCenter = motionCenter(uSphBase[h.sphereIndex], uSphMotionA[h.sphereIndex], uSphMotionB[h.sphereIndex], t);
    } else {
      prevCenter = prevCenterOfBox(h.boxIndex);
      curCenter = motionCenter(uBoxBase[h.boxIndex], uBoxMotionA[h.boxIndex], uBoxMotionB[h.boxIndex], t);
    }
    vec3 prevP = h.p + (prevCenter - curCenter);

    vec4 clip = uPrevViewProj * vec4(prevP, 1.0);
    if (clip.w > 1e-4) {
      vec2 prevNdc = clip.xy / clip.w;
      vec2 prevPixel = (prevNdc * 0.5 + 0.5) * uResolution;
      motion = (prevPixel - frag) * uMotionScale;
      motionValid = (prevPixel.x >= 0.0 && prevPixel.y >= 0.0 &&
                     prevPixel.x <= uResolution.x && prevPixel.y <= uResolution.y) ? 1.0 : 0.0;
      expectedPrevDepth = dot(prevP - uPrevCamPos, uPrevCamForward);
    }
  } else {
    // Sky has no surface point, but its radiance is a pure function of view
    // direction, so reproject the direction at infinity. Without this, sky
    // would fall back to "motion invalid" every frame and never accumulate.
    vec4 clip = uPrevViewProj * vec4(rd, 0.0);
    if (abs(clip.w) > 1e-6) {
      vec2 prevNdc = clip.xy / clip.w;
      vec2 prevPixel = (prevNdc * 0.5 + 0.5) * uResolution;
      motion = (prevPixel - frag) * uMotionScale;
      motionValid = 1.0;
      expectedPrevDepth = 1e9;
      depth = 1e9;
    }
  }

  outColor = vec4(color, 1.0);
  outNormalDepth = vec4(normal, depth);
  outMotion = vec4(motion, expectedPrevDepth, motionValid);
  outAux = vec4(objId, h.hit ? 1.0 : 0.0, 0.0, 0.0);
}
`;

export const TEMPORAL_FS = HEADER + /* glsl */ `
uniform vec2 uResolution;
uniform sampler2D uCurrent;
uniform sampler2D uNormalDepth;
uniform sampler2D uMotion;
uniform sampler2D uAux;
uniform sampler2D uPrevNormalDepth;
uniform sampler2D uHistory;
uniform float uMaxHistory;
uniform float uDepthTolerance;
uniform float uNormalTolerance;
uniform float uClampGamma;
uniform int uTemporalEnabled;
uniform float uHistoryBlend;

layout(location = 0) out vec4 outColor;     // rgb denoised, a history weight
layout(location = 1) out vec4 outAdoption;  // r alpha, g reason, b clamped, a weight before

// Reason codes: 1 = no history, 2 = offscreen, 3 = depth mismatch (disocclusion),
// 4 = normal mismatch, 5 = motion invalid, 6 = accepted.
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 cur = texture(uCurrent, uv);
  vec4 nd = texture(uNormalDepth, uv);
  vec4 mv = texture(uMotion, uv);
  vec4 aux = texture(uAux, uv);
  vec3 current = cur.rgb;

  vec2 prevPixel = gl_FragCoord.xy + mv.xy;
  vec2 prevUv = prevPixel / uResolution;
  vec4 hist = texture(uHistory, prevUv);
  vec4 prevNd = texture(uPrevNormalDepth, prevUv);

  float alpha = 1.0;
  float reasonCode = 6.0;
  float clamped = 0.0;
  float weightBefore = hist.a;

  bool hasHistory = hist.a > 0.001;
  bool inside = prevPixel.x >= 0.0 && prevPixel.y >= 0.0 &&
                prevPixel.x <= uResolution.x && prevPixel.y <= uResolution.y;
  bool depthOk = abs(mv.z - prevNd.w) <= uDepthTolerance * max(1.0, abs(mv.z));
  bool normalOk = dot(nd.xyz, prevNd.xyz) >= uNormalTolerance;

  if (uTemporalEnabled == 0) {
    outColor = vec4(current, 1.0);
    outAdoption = vec4(1.0, 0.0, 0.0, 0.0);
    return;
  }

  if (!hasHistory) {
    reasonCode = 1.0;
  } else if (mv.w < 0.5) {
    reasonCode = 5.0;
  } else if (!inside) {
    reasonCode = 2.0;
  } else if (!depthOk) {
    reasonCode = 3.0;
  } else if (!normalOk) {
    reasonCode = 4.0;
  }

  if (reasonCode == 6.0) {
    // Neighborhood clamp: reject history that disagrees with the current
    // frame's local luminance range. This is the standard TAA color clamp and
    // is what stops stale history from smearing moving/shaded content.
    vec3 mn = current;
    vec3 mx = current;
    vec3 sum = current;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        if (x == 0 && y == 0) continue;
        vec2 o = vec2(float(x), float(y)) / uResolution;
        vec3 c = texture(uCurrent, uv + o).rgb;
        mn = min(mn, c);
        mx = max(mx, c);
        sum += c;
      }
    }
    vec3 mean = sum / 9.0;
    vec3 var = vec3(0.0);
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 o = vec2(float(x), float(y)) / uResolution;
        vec3 c = texture(uCurrent, uv + o).rgb;
        var += (c - mean) * (c - mean);
      }
    }
    vec3 stddev = sqrt(var / 9.0);
    vec3 lo = mn - stddev * uClampGamma;
    vec3 hi = mx + stddev * uClampGamma;
    vec3 histRgb = clamp(hist.rgb, lo, hi);

    float diff = length(histRgb - hist.rgb);
    float scale = length(hist.rgb) + 1e-3;
    // Heavy clamping is reported as an adoption caveat, not a rejection: the
    // pixel still uses (clamped) history, so its past is only partially used.
    clamped = diff > 0.25 * scale ? 1.0 : 0.0;

    float maxW = max(uMaxHistory, 1.0);
    float newW = min(hist.a + 1.0, maxW);
    // historyBlend = 1 uses the full temporal weight; 0 degrades to the
    // current frame only, which makes the slider a diagnostic.
    float target = 1.0 / newW;
    alpha = mix(1.0, target, clamp(uHistoryBlend, 0.0, 1.0));
    outColor = vec4(mix(histRgb, current, alpha), newW);
    outAdoption = vec4((1.0 - alpha) * clamp((newW - 1.0) / max(maxW - 1.0, 1.0), 0.0, 1.0),
                       6.0 / 255.0, clamped, weightBefore / 32.0);
    return;
  }

  outColor = vec4(current, 1.0);
  outAdoption = vec4(0.0, reasonCode / 255.0, 0.0, weightBefore / 32.0);
}
`;

export const SPATIAL_FS = HEADER + /* glsl */ `
uniform vec2 uResolution;
uniform sampler2D uInput;
uniform sampler2D uNormalDepth;
uniform float uDepthSigma;
uniform float uNormalPower;
uniform float uStep;
uniform int uPassIndex;

layout(location = 0) out vec4 outColor;

const float KERNEL[5] = float[5](0.0625, 0.25, 0.375, 0.25, 0.0625);

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 centerNd = texture(uNormalDepth, uv);
  vec3 centerN = centerNd.xyz;
  float centerZ = centerNd.w;
  vec3 centerC = texture(uInput, uv).rgb;

  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 off = vec2(float(i), float(j)) * uStep / uResolution;
      vec4 nd = texture(uNormalDepth, uv + off);
      vec3 c = texture(uInput, uv + off).rgb;
      float wn = pow(max(dot(centerN, nd.xyz), 0.0), uNormalPower);
      float wz = exp(-abs(nd.w - centerZ) / (uDepthSigma * max(1.0, centerZ)));
      float wc = exp(-dot(abs(c - centerC), vec3(0.3333)) * 4.0);
      float w = KERNEL[i + 2] * KERNEL[j + 2] * wn * wz * (0.25 + 0.75 * wc);
      acc += c * w;
      wsum += w;
    }
  }
  // Preserve the temporal weight in alpha; the spatial pass must not reset it.
  outColor = vec4(acc / max(wsum, 1e-5), texture(uInput, uv).a);
}
`;

export const ACCUMULATE_FS = HEADER + /* glsl */ `
uniform vec2 uResolution;
uniform sampler2D uSample;
uniform sampler2D uAccum;
uniform float uSampleCount;   // samples already in accumulation before this one
uniform float uReset;

layout(location = 0) out vec4 outColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec3 s = texture(uSample, uv).rgb;
  if (uReset > 0.5) {
    outColor = vec4(s, 1.0);
    return;
  }
  vec3 prev = texture(uAccum, uv).rgb;
  float n = uSampleCount;
  outColor = vec4((prev * n + s) / (n + 1.0), 1.0);
}
`;

export const DISPLAY_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uInput;
uniform vec2 uResolution;
uniform float uExposure;
uniform int uMode;       // 0 = tonemap color, 1 = raw (no exposure), 2 = luminance heat
uniform float uGain;
in vec2 vUv;
out vec4 outColor;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 c = texture(uInput, vUv).rgb;
  if (uMode == 2) {
    float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float v = pow(clamp(y * uGain, 0.0, 1.0), 1.0 / 2.2);
    outColor = vec4(v, v, v, 1.0);
    return;
  }
  c *= uExposure;
  c = aces(c);
  outColor = vec4(toSrgb(c), 1.0);
}
`;

export const ADOPTION_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uAdoption;
uniform vec2 uResolution;
in vec2 vUv;
out vec4 outColor;

// Reason -> color. Green: history accepted; yellow: heavy neighborhood clamp;
// red-family: rejected, hue encodes why.
vec3 reasonColor(float code) {
  if (code < 0.5) return vec3(0.08, 0.08, 0.1);        // temporal disabled / n/a
  int r = int(code * 255.0 + 0.5);
  if (r == 1) return vec3(0.25, 0.25, 0.28);            // no history
  if (r == 2) return vec3(0.75, 0.12, 0.12);            // offscreen
  if (r == 3) return vec3(0.95, 0.35, 0.05);            // depth mismatch
  if (r == 4) return vec3(0.75, 0.2, 0.62);             // normal mismatch
  if (r == 5) return vec3(0.3, 0.35, 0.8);              // motion invalid
  return vec3(0.05, 0.05, 0.06);                        // accepted (green overlay)
}

void main() {
  vec4 a = texture(uAdoption, vUv);
  float alpha = a.r;
  float clamped = a.b;
  vec3 reject = reasonColor(a.g);
  bool accepted = a.g > 0.0 && int(a.g * 255.0 + 0.5) == 6;
  vec3 col;
  if (accepted) {
    col = mix(vec3(0.85, 0.85, 0.2), vec3(0.05, 0.9, 0.35), clamp(alpha * 1.6, 0.0, 1.0));
    if (clamped > 0.5) col = mix(col, vec3(0.55, 0.55, 0.05), 0.55);
  } else {
    col = mix(reject, vec3(0.0), 0.15);
  }
  outColor = vec4(col, 1.0);
}
`;

export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uA;
uniform sampler2D uB;
uniform vec2 uResolution;
uniform int uMode;       // 0 = split, 1 = A (alpha preserved), 2 = B, 3 = abs diff x8
uniform float uSplit;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 a = texture(uA, vUv);
  vec3 b = texture(uB, vUv).rgb;
  if (uMode == 1) { outColor = a; return; }
  if (uMode == 2) { outColor = vec4(b, 1.0); return; }
  if (uMode == 3) {
    vec3 d = abs(a.rgb - b) * 8.0;
    outColor = vec4(d, 1.0);
    return;
  }
  float side = vUv.x < uSplit ? 0.0 : 1.0;
  outColor = vec4(mix(a.rgb, b, side), 1.0);
}
`;
