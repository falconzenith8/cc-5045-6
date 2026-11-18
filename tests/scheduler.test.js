import test from 'node:test';
import assert from 'node:assert/strict';
import { planExecution, validatePlan, dependsOnFrame } from '../src/temporal/scheduler.js';

const scene = { frames: 72, fps: 24 };

test('single-segment plan has no warmup and no cross-segment dependency', () => {
  const plan = planExecution(scene, { segmentSize: 72, maxHistory: 12 });
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.segments[0].warmup, 0);
  assert.deepEqual(plan.segments[0].dependsOn, []);
  assert.equal(plan.segments[0].start, 0);
  assert.equal(plan.segments[0].end, 71);
  assert.ok(validatePlan(plan, scene).ok);
});

test('split plan preheats every non-first segment from the preceding timeline', () => {
  const plan = planExecution(scene, { segmentSize: 36, maxHistory: 12 });
  assert.equal(plan.segments.length, 2);
  const second = plan.segments[1];
  assert.equal(second.start, 36);
  assert.equal(second.warmup, 11, 'warmup defaults to maxHistory - 1');
  assert.equal(second.warmupStart, 25);
  assert.equal(second.warmupEnd, 35);
  assert.equal(second.dependsOn.length, 1);
  assert.deepEqual(dependsOnFrame(36).needs, ['historyColor@35', 'historyDepth@35']);
  assert.ok(validatePlan(plan, scene).ok);
});

test('warmup replays the real preceding timeline, even before the job start', () => {
  const plan = planExecution(scene, { start: 30, end: 60, segmentSize: 10, warmup: 11 });
  assert.equal(plan.segments.length, 4);
  const second = plan.segments[1];
  // Segment 1 starts at 40, so warm-up covers 29..39: shortening it to the
  // job start (30) would replay only 10 frames and reintroduce a seam.
  assert.equal(second.warmupStart, 29);
  assert.equal(second.warmupEnd, 39);
  assert.equal(second.warmup, 11);
});

test('validatePlan flags a zero-warmup non-first segment', () => {
  const plan = planExecution(scene, { segmentSize: 36, warmup: 0 });
  const check = validatePlan(plan, scene);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => p.includes('缺少预热')));
});

test('empty frame ranges are rejected', () => {
  assert.throws(() => planExecution(scene, { start: 10, end: 5 }), /帧范围无效/);
});

test('frame dependency manifest is explicit for the first frame', () => {
  assert.deepEqual(dependsOnFrame(0).needs, []);
  assert.deepEqual(dependsOnFrame(0).produces, ['historyColor@0', 'historyDepth@0']);
});

test('every segment declares the artifacts it consumes and the history chain', () => {
  const plan = planExecution(scene, { segmentSize: 24 });
  for (const seg of plan.segments) {
    assert.ok(Array.isArray(seg.outputs));
    assert.ok(seg.outputs.includes('historyColor'));
    assert.ok(seg.outputs.includes('historyDepth'));
  }
  assert.deepEqual(
    plan.artifacts.map((a) => a.id),
    ['historyColor', 'historyDepth', 'gbuffer', 'pixelMotion'],
  );
});
