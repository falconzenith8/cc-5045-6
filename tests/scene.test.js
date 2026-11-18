import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENES, SCENE_LIST, sphereCenter, boxCenter, cameraForFrame, jitterForFrame, packScene,
} from '../src/scene/scene.js';
import {
  perspective, lookAt, multiply, invert, projectToNdc, ndcToPixel, transformPoint,
} from '../src/math/mat4.js';

test('three shots exist and match the brief', () => {
  assert.deepEqual(SCENE_LIST.map((s) => s.id), ['moving-camera', 'background-reveal', 'fast-occlusion']);
  for (const s of SCENE_LIST) {
    assert.ok(s.frames > 30);
    assert.ok(s.events.length >= 2);
    assert.ok(s.spheres.length <= 8, 'GLSL uniform arrays hold 8 spheres');
    assert.ok(s.boxes.length <= 8, 'GLSL uniform arrays hold 8 boxes');
    assert.ok(s.lightSphere < s.spheres.length);
  }
});

test('motion is sampled analytically and is continuous in time', () => {
  const s = SCENES['moving-camera'].spheres.find((x) => x.motion.kind === 1);
  const a = sphereCenter(s, 1.0);
  const b = sphereCenter(s, 1.0 + 1 / 24);
  const c = sphereCenter(s, 1.0 + 2 / 24);
  const d1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const d2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
  assert.ok(Math.abs(d1[0] - d2[0]) < 1e-9);
  assert.ok(Math.abs(d1[2] - d2[2]) < 1e-9);
});

test('linear motion is clamped before t0', () => {
  const b = SCENES['background-reveal'].boxes.find((x) => x.id === 103);
  const before = boxCenter(b, 0.5);
  const atT0 = boxCenter(b, 0.833);
  assert.deepEqual(before, b.base);
  assert.deepEqual(atT0, b.base);
  const after = boxCenter(b, 0.833 + 0.5);
  assert.ok(after[1] > b.base[1] + 5);
});

test('camera basis is orthonormal and view-projection round-trips', () => {
  const scene = SCENES['moving-camera'];
  const cam = cameraForFrame(scene, 10);
  const proj = perspective(scene.fovY, 480 / 270, scene.near, scene.far);
  const view = lookAt(cam.eye, cam.target, cam.up);
  const vp = multiply(proj, view);
  const p = [0.3, 1.2, -1.5];
  const ndc = projectToNdc(vp, p);
  // projectToNdc already divides by w; the inverse expects NDC directly.
  const inv = invert(vp);
  const back = transformPoint(inv, [ndc[0], ndc[1], ndc[2]]);
  // Matrices are Float32Array, so round-off is on the order of 1e-5.
  assert.ok(Math.abs(back[0] - p[0]) < 1e-3);
  assert.ok(Math.abs(back[1] - p[1]) < 1e-3);
  assert.ok(Math.abs(back[2] - p[2]) < 1e-3);
});

test('screen convention maps NDC centre to the framebuffer centre', () => {
  const px = ndcToPixel([0, 0], 480, 270);
  assert.deepEqual(px, [240, 135]);
  // +y NDC is up, so it must map to a smaller pixel row.
  const up = ndcToPixel([0, 0.5], 480, 270);
  assert.ok(up[1] < 135);
});

test('halton jitter is bounded to half a pixel and never repeats early', () => {
  const seen = new Set();
  for (let f = 0; f < 32; f++) {
    const j = jitterForFrame(f);
    assert.ok(j[0] >= -0.5 && j[0] < 0.5);
    assert.ok(j[1] >= -0.5 && j[1] < 0.5);
    seen.add(j.join(','));
  }
  assert.equal(seen.size, 32);
});

test('packed scene uniforms match the declared counts', () => {
  const s = SCENES['fast-occlusion'];
  const p = packScene(s);
  assert.equal(p.sphereCount, s.spheres.length);
  assert.equal(p.boxCount, s.boxes.length);
  assert.equal(p.sphBase.length, 32);
  assert.equal(p.boxHalf.length, 32);
  assert.equal(p.lightIndex, s.lightSphere);
  // Object ids must be unique so adoption/debug views can distinguish them.
  const ids = [...s.spheres, ...s.boxes].map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
});
