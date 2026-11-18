// Three short shots that exercise different temporal-denoising failure modes.
//
// Shared conventions:
//   * World is right-handed, +Y up.
//   * Time t = frame / fps. Previous frame is t - 1/fps.
//   * Object motion is authored in world space and sampled analytically at t
//     and t - dt, so motion vectors are exact for moving objects.
//   * Camera motion is authored as eye/target/up per frame; reprojection uses
//     the previous frame's full view-projection matrix.
//   * Motion kind: 0 static, 1 linear (base + vel*max(0,t-t0)),
//     2 sinusoid (base + amp*sin(w*t+phase)).
//
// Screen-space motion vectors are pixel offsets (prevPixel - curPixel) in the
// framebuffer (bottom-left origin, +y up).

export const DEFAULT_WIDTH = 480;
export const DEFAULT_HEIGHT = 270;
export const DEFAULT_FPS = 24;

function sphere(id, base, r, motion, albedo, emission = [0, 0, 0]) {
  return { id, base, r, motion, albedo, emission };
}

function box(id, base, h, motion, albedo, emission = [0, 0, 0], checker = false) {
  return { id, base, h, motion, albedo, emission, checker };
}

const SCENE_MOVING_CAMERA = {
  id: 'moving-camera',
  name: '移动相机',
  blurb: '相机横移并推进；球体周期浮动。检验相机运动下的重投影与边缘稳定性。',
  width: DEFAULT_WIDTH,
  height: DEFAULT_HEIGHT,
  fps: DEFAULT_FPS,
  frames: 84,
  fovY: (46 * Math.PI) / 180,
  near: 0.1,
  far: 120,
  lightSphere: 6,
  events: [
    { frame: 0, label: '相机开始横移' },
    { frame: 42, label: '相机推进至最近点' },
    { frame: 70, label: '相机回摆' },
  ],
  camera(frame, s) {
    const t = frame / s.fps;
    const u = frame / (s.frames - 1);
    const ang = -0.42 + 0.95 * u;
    const radius = 8.4 - 2.6 * u;
    return {
      eye: [Math.sin(ang) * radius, 2.5 + 0.45 * Math.sin(1.7 * t), Math.cos(ang) * radius],
      target: [0.4 * Math.sin(1.1 * t), 1.15, -2.1],
      up: [0, 1, 0],
    };
  },
  spheres: [
    sphere(1, [1.7, 1.0, 0.6], 1.0, { kind: 2, amp: [0, 0.12, 0], w: 1.6, phase: 0.2 }, [0.82, 0.28, 0.2]),
    sphere(2, [-1.8, 0.9, 1.3], 0.8, { kind: 2, amp: [0, 0.3, 0], w: 2.1, phase: 0.3 }, [0.22, 0.62, 0.85]),
    sphere(3, [-2.4, 0.7, -1.0], 0.7, { kind: 1, vel: [0.45, 0, 0.06], t0: 0 }, [0.9, 0.72, 0.2]),
    sphere(4, [3.4, 1.2, -1.5], 1.2, { kind: 0 }, [0.55, 0.55, 0.6]),
    sphere(5, [-3.3, 0.85, -0.4], 0.9, { kind: 0 }, [0.55, 0.32, 0.78]),
    sphere(6, [6.5, 4.5, -6.0], 1.0, { kind: 0 }, [0.8, 0.16, 0.12], [9.0, 1.5, 0.6]),
    sphere(7, [4.5, 6.0, -1.5], 1.1, { kind: 0 }, [0, 0, 0], [95, 88, 78]),
  ],
  boxes: [
    box(101, [0, 2.8, -8.5], [12, 4.5, 0.4], { kind: 0 }, [0.5, 0.52, 0.58]),
    box(102, [0, -0.15, 0], [24, 0.15, 24], { kind: 0 }, [0.5, 0.5, 0.5], [0, 0, 0], true),
    box(103, [2.9, 0.8, -2.6], [0.6, 0.8, 0.6], { kind: 0 }, [0.2, 0.62, 0.36]),
    box(104, [-3.6, 0.55, 2.0], [0.5, 0.5, 0.5], { kind: 2, amp: [0, 0.25, 0], w: 1.7, phase: 2.0 }, [0.78, 0.6, 0.32]),
  ],
};

const SCENE_BACKGROUND_REVEAL = {
  id: 'background-reveal',
  name: '突然显露背景',
  blurb: '遮罩板快速上移，露出高亮面板与后方几何体。检验离屏/深度不匹配时的历史拒绝与回退。',
  width: DEFAULT_WIDTH,
  height: DEFAULT_HEIGHT,
  fps: DEFAULT_FPS,
  frames: 72,
  fovY: (44 * Math.PI) / 180,
  near: 0.1,
  far: 120,
  lightSphere: 6,
  events: [
    { frame: 0, label: '遮罩完全覆盖面板' },
    { frame: 20, label: '遮罩开始上移（显露）' },
    { frame: 36, label: '显露大面积背景' },
    { frame: 52, label: '显露结束' },
  ],
  camera(frame, s) {
    const t = frame / s.fps;
    return {
      eye: [0.25 * Math.sin(0.5 * t), 1.9 + 0.12 * Math.sin(1.1 * t), 4.6],
      target: [-1.6, 1.7, -2.2],
      up: [0, 1, 0],
    };
  },
  spheres: [
    sphere(1, [-1.5, 0.8, -1.0], 0.8, { kind: 2, amp: [0, 0.18, 0], w: 1.9, phase: 0.4 }, [0.85, 0.35, 0.22]),
    sphere(2, [1.5, 0.9, -0.4], 0.9, { kind: 0 }, [0.25, 0.6, 0.8]),
    sphere(3, [0.6, 0.5, 0.8], 0.5, { kind: 1, vel: [0.3, 0, -0.2], t0: 0 }, [0.9, 0.75, 0.25]),
    sphere(4, [2.9, 1.1, -3.2], 0.75, { kind: 2, amp: [0.2, 0, 0], w: 1.2, phase: 1.2 }, [0.5, 0.5, 0.55]),
    sphere(5, [-3.1, 1.0, -3.4], 1.0, { kind: 0 }, [0.5, 0.35, 0.72]),
    sphere(6, [-3.9, 3.4, -0.8], 0.55, { kind: 0 }, [0.8, 0.2, 0.1], [2.0, 0.2, 0.1]),
    sphere(7, [3.6, 4.9, -1.6], 0.95, { kind: 0 }, [0, 0, 0], [105, 98, 88]),
  ],
  boxes: [
    box(101, [-1.0, 2.5, -7.5], [9, 4.0, 0.4], { kind: 0 }, [0.52, 0.5, 0.56]),
    box(102, [0, -0.15, 0], [22, 0.15, 22], { kind: 0 }, [0.5, 0.5, 0.5], [0, 0, 0], true),
    // Cover panel: slides up starting frame 20 (t = 0.833s), fully clear by frame 38.
    box(103, [-1.5, 2.2, -2.0], [1.9, 1.9, 0.25], { kind: 1, vel: [0, 12.5, 0], t0: 0.833 }, [0.36, 0.42, 0.5]),
    // Bright emissive panel behind the cover: huge temporal signal change.
    box(104, [-1.5, 2.2, -2.55], [1.9, 1.9, 0.08], { kind: 0 }, [0.08, 0.5, 0.4], [3.4, 2.0, 2.4]),
    // Static geometry revealed at increasing depths.
    box(105, [0.8, 0.7, -4.4], [0.7, 0.7, 0.7], { kind: 0 }, [0.32, 0.6, 0.4]),
    box(106, [-3.0, 0.5, -5.2], [0.5, 0.5, 0.5], { kind: 0 }, [0.75, 0.55, 0.3]),
  ],
};

const SCENE_FAST_OCCLUSION = {
  id: 'fast-occlusion',
  name: '物体快速遮挡',
  blurb: '一个大球贴着相机高速掠过，完全遮挡画面后离开。检验快速运动矢量的有效性、遮挡解除后的历史重建。',
  width: DEFAULT_WIDTH,
  height: DEFAULT_HEIGHT,
  fps: DEFAULT_FPS,
  frames: 72,
  fovY: (52 * Math.PI) / 180,
  near: 0.1,
  far: 120,
  lightSphere: 6,
  events: [
    { frame: 0, label: '遮挡体尚未进入' },
    { frame: 26, label: '遮挡体进入画面' },
    { frame: 36, label: '遮挡体覆盖中心' },
    { frame: 46, label: '遮挡体离开' },
    { frame: 58, label: '背景重新累积' },
  ],
  camera(frame, s) {
    const t = frame / s.fps;
    return {
      eye: [0.6 * Math.sin(0.7 * t), 2.2, 5.2 - 0.35 * t],
      target: [0, 1.2, -2.0],
      up: [0, 1, 0],
    };
  },
  spheres: [
    sphere(1, [1.6, 0.9, 0.2], 0.9, { kind: 2, amp: [0, 0.2, 0], w: 2.0, phase: 0.2 }, [0.8, 0.3, 0.2]),
    sphere(2, [-1.5, 0.8, 0.7], 0.8, { kind: 2, amp: [0, 0.16, 0], w: 1.5, phase: 1.0 }, [0.2, 0.6, 0.85]),
    sphere(3, [0.2, 0.6, -2.2], 0.6, { kind: 1, vel: [0.2, 0, 0], t0: 0 }, [0.9, 0.72, 0.2]),
    sphere(4, [2.8, 1.2, -3.0], 1.0, { kind: 0 }, [0.55, 0.55, 0.6]),
    sphere(5, [-2.9, 1.0, -2.6], 0.9, { kind: 0 }, [0.55, 0.32, 0.78]),
    // Fast close occluder: enters frame ~26, covers center ~36, exits ~46.
    sphere(6, [-8.2, 1.6, 3.1], 1.6, { kind: 1, vel: [8.5, 0, 0], t0: 0.75 }, [0.32, 0.34, 0.38]),
    sphere(7, [3.9, 5.4, -1.2], 1.0, { kind: 0 }, [0, 0, 0], [105, 98, 88]),
  ],
  boxes: [
    box(101, [0, 2.7, -8.0], [10, 4.2, 0.4], { kind: 0 }, [0.5, 0.52, 0.58]),
    box(102, [0, -0.15, 0], [22, 0.15, 22], { kind: 0 }, [0.5, 0.5, 0.5], [0, 0, 0], true),
    box(103, [1.4, 0.7, -3.6], [0.6, 0.7, 0.6], { kind: 0 }, [0.25, 0.62, 0.38]),
    box(104, [-2.4, 0.5, -4.2], [0.45, 0.5, 0.45], { kind: 0 }, [0.78, 0.6, 0.32]),
  ],
};

export const SCENES = {
  'moving-camera': SCENE_MOVING_CAMERA,
  'background-reveal': SCENE_BACKGROUND_REVEAL,
  'fast-occlusion': SCENE_FAST_OCCLUSION,
};

export const SCENE_LIST = [SCENE_MOVING_CAMERA, SCENE_BACKGROUND_REVEAL, SCENE_FAST_OCCLUSION];

export function sphereCenter(s, t) {
  const m = s.motion;
  if (m.kind === 0) return s.base.slice();
  if (m.kind === 1) {
    const dt = Math.max(0, t - (m.t0 ?? 0));
    return [s.base[0] + m.vel[0] * dt, s.base[1] + m.vel[1] * dt, s.base[2] + m.vel[2] * dt];
  }
  const s0 = Math.sin(m.w * t + m.phase);
  return [s.base[0] + m.amp[0] * s0, s.base[1] + m.amp[1] * s0, s.base[2] + m.amp[2] * s0];
}

export function boxCenter(b, t) {
  return sphereCenter(b, t);
}

export function packScene(scene) {
  const maxS = 8;
  const maxB = 8;
  const sphBase = new Float32Array(maxS * 4);
  const sphMotionA = new Float32Array(maxS * 4);
  const sphMotionB = new Float32Array(maxS * 4);
  const sphAlbedo = new Float32Array(maxS * 4);
  const sphEmission = new Float32Array(maxS * 4);
  scene.spheres.forEach((s, i) => {
    sphBase.set([s.base[0], s.base[1], s.base[2], s.r], i * 4);
    const m = s.motion;
    sphMotionA.set([m.kind, m.t0 ?? 0, m.w ?? 0, m.phase ?? 0], i * 4);
    sphMotionB.set([...(m.vel ?? m.amp ?? [0, 0, 0])], i * 4);
    sphAlbedo.set([...s.albedo, 0], i * 4);
    sphEmission.set([...s.emission, 0], i * 4);
  });
  const boxBase = new Float32Array(maxB * 4);
  const boxHalf = new Float32Array(maxB * 4);
  const boxMotionA = new Float32Array(maxB * 4);
  const boxMotionB = new Float32Array(maxB * 4);
  const boxAlbedo = new Float32Array(maxB * 4);
  const boxEmission = new Float32Array(maxB * 4);
  scene.boxes.forEach((b, i) => {
    boxBase.set([b.base[0], b.base[1], b.base[2], b.checker ? 1 : 0], i * 4);
    boxHalf.set([...b.h, 0], i * 4);
    const m = b.motion;
    boxMotionA.set([m.kind, m.t0 ?? 0, m.w ?? 0, m.phase ?? 0], i * 4);
    boxMotionB.set([...(m.vel ?? m.amp ?? [0, 0, 0])], i * 4);
    boxAlbedo.set([...b.albedo, 0], i * 4);
    boxEmission.set([...b.emission, 0], i * 4);
  });
  return {
    sphBase, sphMotionA, sphMotionB, sphAlbedo, sphEmission,
    boxBase, boxHalf, boxMotionA, boxMotionB, boxAlbedo, boxEmission,
    sphereCount: scene.spheres.length,
    boxCount: scene.boxes.length,
    lightIndex: scene.lightSphere,
  };
}

// Halton(2,3) jitter in pixel units, range [-0.5, 0.5).
export function halton(index, base) {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

export function jitterForFrame(frame) {
  const i = frame + 1;
  return [halton(i, 2) - 0.5, halton(i, 3) - 0.5];
}

export function cameraForFrame(scene, frame) {
  const cam = scene.camera(frame, scene);
  const t = frame / scene.fps;
  return { ...cam, t, frame };
}
