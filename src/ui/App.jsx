import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SCENE_LIST } from '../scene/scene.js';
import { DenoiseRenderer, DEFAULT_SETTINGS } from '../render/renderer.js';
import { JobRunner, summarizeRun } from '../render/jobRunner.js';
import { planExecution, validatePlan, dependsOnFrame } from '../temporal/scheduler.js';
import { encodeWebM, buildReviewZip, rgbaToPng, downloadBlob } from '../export/exporters.js';

const REASON_LABELS = {
  1: '无历史（首帧/已清除）',
  2: '重投影出屏',
  3: '深度不匹配（遮挡解除/露背景）',
  4: '法线不匹配',
  5: '运动矢量无效',
};
const REASON_COLORS = {
  1: '#8b8b93',
  2: '#c0392b',
  3: '#e67e22',
  4: '#b0479e',
  5: '#5566cc',
};

function fmtPct(v) { return `${v.toFixed(1)}%`; }

// Per-pixel adoption inspection. A dedicated offscreen renderer replays the
// same frames through the same temporal path, so the returned adoption values
// are the actual computed ones rather than an approximation from the preview
// palette. History is memoryless beyond maxHistory frames, so replaying the
// last maxHistory+2 frames reproduces the run's state exactly.
let inspector = null;
function inspectAdoption(scene, settings, frame, x, y) {
  if (!inspector || inspector.scene !== scene) {
    const canvas = document.createElement('canvas');
    inspector?.renderer.dispose();
    inspector = { scene, renderer: new DenoiseRenderer(canvas, scene) };
  }
  const r = inspector.renderer;
  r.setSettings(settings);
  r.clearHistory();
  const start = Math.max(0, frame - (settings.maxHistory + 2));
  for (let f = start; f < frame; f++) r.renderFrame(f);
  r.renderFrame(frame);
  const res = r.sampleAdoption(x, y);
  if (!res) return null;
  return {
    ...res,
    weightBefore: res.weightBefore,
    alpha: res.alpha,
  };
}

// Convert an RGBA8 buffer into an ObjectURL-backed PNG for canvas display.
function useFrameCanvas(canvasRef, record, key) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !record) return;
    canvas.width = record.width;
    canvas.height = record.height;
    const ctx = canvas.getContext('2d');
    const img = new ImageData(new Uint8ClampedArray(record[key]), record.width, record.height);
    ctx.putImageData(img, 0, 0);
  }, [canvasRef, record, key]);
}

function MetricBar({ label, value, total, color }) {
  const pct = total ? (value / total) * 100 : 0;
  return (
    <div className="metricRow">
      <span className="metricLabel">{label}</span>
      <span className="metricTrack"><span className="metricFill" style={{ width: `${pct}%`, background: color }} /></span>
      <span className="metricValue">{fmtPct(pct)}</span>
    </div>
  );
}

function App() {
  const canvasRef = useRef(null);
  const cpuCanvasRef = useRef(null);
  const rendererRef = useRef(null);
  const runnerRef = useRef(null);
  const [sceneId, setSceneId] = useState(SCENE_LIST[0].id);
  const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS });
  const [segmentMode, setSegmentMode] = useState('single'); // 'single' | 'split'
  const [warmup, setWarmup] = useState(null); // null = auto (maxHistory-1)
  const [plan, setPlan] = useState(null);
  const [frames, setFrames] = useState([]);
  const [current, setCurrent] = useState(0);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ delivered: 0, total: 0 });
  const [segmentsDone, setSegmentsDone] = useState([]);
  const [logLines, setLogLines] = useState([]);
  const [error, setError] = useState(null);
  const [view, setView] = useState('denoised');
  const [playing, setPlaying] = useState(false);
  const [compareMode, setCompareMode] = useState('split');
  const [seamReport, setSeamReport] = useState(null);
  const [historyCleared, setHistoryCleared] = useState(0);
  const [adoptionInspector, setAdoptionInspector] = useState(null);
  const [exporting, setExporting] = useState('');
  const [summary, setSummary] = useState(null);
  const [rendererError, setRendererError] = useState(null);
  const [historyAnomaly, setHistoryAnomaly] = useState(null);

  const scene = useMemo(() => SCENE_LIST.find((s) => s.id === sceneId), [sceneId]);
  const currentRecord = frames[current] || null;

  const log = useCallback((msg, kind = 'info') => {
    setLogLines((l) => [...l.slice(-199), { t: new Date().toLocaleTimeString('zh-CN', { hour12: false }), msg, kind }]);
  }, []);

  // Initialise renderer when the scene changes. Any failure is surfaced in the
  // panel rather than thrown into the console only.
  useEffect(() => {
    if (!canvasRef.current) return;
    let r = null;
    try {
      r = new DenoiseRenderer(canvasRef.current, scene);
      r.setSettings(settings);
      rendererRef.current = r;
      setRendererError(null);
      setFrames([]);
      setCurrent(0);
      setProgress({ delivered: 0, total: 0 });
      setSegmentsDone([]);
      setSummary(null);
      setSeamReport(null);
      setPlan(planExecution(scene, { maxHistory: settings.maxHistory }));
      log(`场景已载入：${scene.name}（${scene.width}×${scene.height}, ${scene.frames} 帧 @ ${scene.fps}fps）`);
    } catch (e) {
      setRendererError(e.message);
      log(`渲染器初始化失败：${e.message}`, 'error');
    }
    return () => {
      r?.dispose();
      if (rendererRef.current === r) rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.setSettings(settings);
  }, [settings]);

  // Recompute the plan when segmentation options change.
  const rebuildPlan = useCallback((overrides = {}) => {
    if (!scene) return null;
    const opts = {
      maxHistory: settings.maxHistory,
      segmentSize: (overrides.segmentMode ?? segmentMode) === 'split'
        ? Math.ceil(scene.frames / 2)
        : scene.frames,
      warmup: (overrides.warmup ?? warmup) ?? undefined,
    };
    const p = planExecution(scene, opts);
    const check = validatePlan(p, scene);
    setPlan(p);
    if (!check.ok) log(`执行计划校验失败：${check.problems.join('；')}`, 'error');
    return p;
  }, [scene, settings.maxHistory, segmentMode, warmup, log]);

  useEffect(() => { rebuildPlan(); }, [rebuildPlan]);

  const startRun = useCallback(async () => {
    const renderer = rendererRef.current;
    if (!renderer || running) return;
    const p = rebuildPlan();
    if (!p) return;
    setError(null);
    setSummary(null);
    setSeamReport(null);
    setHistoryAnomaly(null);
    setRunning(true);
    setFrames([]);
    setCurrent(0);
    setSegmentsDone([]);
    setProgress({ delivered: 0, total: p.totalFrames });
    const collected = [];
    const runner = new JobRunner(renderer, p, {
      onFrame: (rec) => {
        collected.push(rec);
        setFrames((prev) => [...prev, rec]);
        if (rec.metrics.anomaly) {
          setHistoryAnomaly({ frame: rec.frame, type: rec.metrics.anomaly, epoch: rec.historyEpoch });
          log(`帧 ${rec.frame} 历史异常：${rec.metrics.anomaly}（epoch ${rec.historyEpoch}）`, 'warn');
        }
        // Live preview goes to the CPU overlay canvas; the WebGL canvas owns
        // the renderer's context and cannot host a 2D context.
        const c = cpuCanvasRef.current;
        if (c) {
          c.width = rec.width;
          c.height = rec.height;
          c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rec.denoised), rec.width, rec.height), 0, 0);
        }
      },
      onProgress: (pr) => setProgress(pr),
      onSegment: (ev) => {
        if (ev.type === 'start') log(`段 ${ev.segment.index} 开始：帧 ${ev.segment.start}–${ev.segment.end}` +
          (ev.segment.index > 0 ? `，预热重放 ${ev.segment.warmup} 帧（${ev.segment.warmupStart}–${ev.segment.warmupEnd}）` : '（首段，无历史）'));
        if (ev.type === 'warmup') log(`  预热帧 ${ev.frame}（输出丢弃，仅重建历史）`, 'muted');
        if (ev.type === 'done') {
          setSegmentsDone((s) => [...s, ev.segment.index]);
          log(`段 ${ev.segment.index} 完成：${ev.segment.emitted} 帧，首帧历史采纳 ${fmtPct(ev.frames[0]?.metrics.acceptedPct ?? 0)}`);
        }
      },
    });
    runnerRef.current = runner;
    try {
      const result = await runner.run();
      if (result.cancelled) {
        log('任务已取消，已保留已产出帧与历史状态', 'warn');
      } else {
        const s = summarizeRun(result, renderer.width, renderer.height);
        setSummary(s);
        // Report seam deltas: the first delivered frame of each non-first
        // segment should match a continuous run closely.
        setSeamReport(result.seams.map((seam) => {
          const first = result.frames.find((f) => f.frame === seam.frame);
          return { ...seam, acceptedPct: first?.metrics.acceptedPct ?? 0, meanWeight: first?.metrics.meanHistoryWeight ?? 0 };
        }));
        log(`完成 ${result.frames.length} 帧。时序稳定性 ${s.stability.denoised.toFixed(5)}，独立降噪 ${s.stability.independent.toFixed(5)}`, 'ok');
      }
    } catch (e) {
      setError(e.message);
      log(`渲染异常：${e.message}`, 'error');
    } finally {
      runnerRef.current = null;
      setRunning(false);
    }
  }, [rebuildPlan, running, log]);

  const cancelRun = useCallback(() => {
    runnerRef.current?.cancel();
  }, []);

  const clearHistory = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.clearHistory();
    const state = renderer.historyState();
    setHistoryAnomaly(null);
    setHistoryCleared((n) => n + 1);
    log(`历史已清除：epoch ${state.epoch}，下一帧将以无历史回退（原因码 1）开始累积`, 'warn');
  }, [log]);

  // Playback
  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const id = setInterval(() => {
      setCurrent((c) => (c + 1) % frames.length);
    }, 1000 / (scene?.fps ?? 24));
    return () => clearInterval(id);
  }, [playing, frames.length, scene]);

  const onScrub = useCallback((e) => {
    setCurrent(Number(e.target.value));
  }, []);

  // Draw the selected frame to the main canvas. CPU-captured views are exact
  // copies of what the job produced, so scrubbing never re-renders. The motion
  // view is a live GPU inspection pass that replays a short history window.
  useEffect(() => {
    const renderer = rendererRef.current;
    const cpuCanvas = cpuCanvasRef.current;
    if (!cpuCanvas) return;
    const cpuViews = { denoised: 'denoised', noisy: 'noisy', independent: 'independent', adoption: 'adoption' };
    if (view === 'motion') {
      cpuCanvas.style.visibility = 'hidden';
      if (!renderer || !currentRecord || running) return;
      try {
        renderer.clearHistory();
        for (let f = Math.max(0, currentRecord.frame - 14); f < currentRecord.frame; f++) renderer.renderFrame(f);
        renderer.renderFrame(currentRecord.frame);
        renderer.present({ mode: 'motion' });
      } catch (e) {
        setRendererError(e.message);
      }
      return;
    }
    cpuCanvas.style.visibility = 'visible';
    if (!currentRecord) return;
    const key = cpuViews[view];
    cpuCanvas.width = currentRecord.width;
    cpuCanvas.height = currentRecord.height;
    cpuCanvas.getContext('2d').putImageData(
      new ImageData(new Uint8ClampedArray(currentRecord[key]), currentRecord.width, currentRecord.height), 0, 0);
  }, [view, currentRecord, running]);

  // Inspect the adoption buffer of the currently displayed frame without
  // touching renderer state (scrubbing must be side-effect free).
  const inspectPixel = useCallback((e) => {
    if (!currentRecord || running) return;
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * currentRecord.width);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * currentRecord.height);
    try {
      const a = inspectAdoption(scene, settings, currentRecord.frame, x, y);
      if (!a) return;
      setAdoptionInspector({ x, y, ...a, frame: currentRecord.frame });
    } catch (err) {
      setError(`像素检查失败：${err.message}`);
    }
  }, [currentRecord, running, scene, settings]);

  const exportVideo = useCallback(async (key, filename) => {
    if (!frames.length) return;
    setExporting(`${key === 'noisy' ? '原始噪声' : '降噪'}序列编码中…`);
    try {
      const blob = await encodeWebM(frames, key, scene.fps, frames[0].width, frames[0].height, (p) => {
        setExporting(`编码 ${p.encoded}/${p.total}`);
      });
      downloadBlob(blob, filename);
      log(`已导出 ${filename}（${(blob.size / 1024 / 1024).toFixed(1)} MB）`, 'ok');
    } catch (e) {
      setError(`视频导出失败：${e.message}`);
      log(`视频导出失败：${e.message}`, 'error');
    } finally {
      setExporting('');
    }
  }, [frames, scene, log]);

  const exportReview = useCallback(async () => {
    if (!frames.length) return;
    setExporting('打包复核数据…');
    try {
      const blob = await buildReviewZip(frames, {
        scene: scene.id,
        sceneName: scene.name,
        fps: scene.fps,
        settings,
        plan: plan && {
          segments: plan.segments.map((s) => ({ start: s.start, end: s.end, warmup: s.warmup, warmupStart: s.warmupStart })),
        },
        summary,
        seams: seamReport,
      }, frames[0].width, frames[0].height);
      downloadBlob(blob, `${scene.id}-review.zip`);
      log('已导出复核包：noisy/ 原始噪声帧 + manifest.json（实际降噪指标）', 'ok');
    } catch (e) {
      setError(`复核包导出失败：${e.message}`);
    } finally {
      setExporting('');
    }
  }, [frames, scene, settings, plan, summary, seamReport, log]);

  const exportFramePng = useCallback(async (key) => {
    if (!currentRecord) return;
    const png = await rgbaToPng(currentRecord[key], currentRecord.width, currentRecord.height);
    downloadBlob(new Blob([png], { type: 'image/png' }), `${scene.id}_f${String(currentRecord.frame).padStart(4, '0')}_${key}.png`);
  }, [currentRecord, scene]);

  const dependency = currentRecord ? dependsOnFrame(currentRecord.frame) : null;

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>时序降噪出图面板</h1>
          <p className="subtle">真实路径追踪噪声 → 重投影历史累积 → 运动矢量/深度/法线校验 → 可播放序列</p>
        </div>
        <div className="topActions">
          <select value={sceneId} onChange={(e) => setSceneId(e.target.value)} disabled={running}>
            {SCENE_LIST.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button className="primary" onClick={startRun} disabled={running || !!rendererError}>开始渲染</button>
          <button onClick={cancelRun} disabled={!running}>取消</button>
          <button onClick={clearHistory} disabled={running}>清除历史</button>
        </div>
      </header>

      {rendererError && <div className="banner error">渲染器错误：{rendererError}</div>}
      {error && <div className="banner error">{error}</div>}
      {historyAnomaly && (
        <div className="banner warn">
          历史状态异常：{historyAnomaly.type}{historyAnomaly.frame !== null ? `（帧 ${historyAnomaly.frame}）` : ''}
          ；当前链 epoch {historyAnomaly.epoch}，重跑须按对应帧身份重建历史。
        </div>
      )}
      {!rendererError && historyCleared > 0 && (
        <div className="banner warn">历史已清除 {historyCleared} 次；清除后首帧历史采纳率为 0%，回退原因为“无历史”。</div>
      )}

      <div className="layout">
        <aside className="panel left">
          <section>
            <h2>场景</h2>
            <p className="sceneName">{scene.name}</p>
            <p className="subtle small">{scene.blurb}</p>
            <ul className="events">
              {scene.events.map((ev) => (
                <li key={ev.frame}>
                  <span className="mono">f{ev.frame}</span> {ev.label}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2>执行计划</h2>
            <label className="field">
              <span>任务分段</span>
              <select value={segmentMode} onChange={(e) => setSegmentMode(e.target.value)} disabled={running}>
                <option value="single">单段（连续时序）</option>
                <option value="split">两段（检验预热）</option>
              </select>
            </label>
            <label className="field">
              <span>预热帧数（自动 = 历史上限−1）</span>
              <input type="number" min="0" max="32" value={warmup ?? ''} placeholder={String(Math.max(0, settings.maxHistory - 1))}
                onChange={(e) => setWarmup(e.target.value === '' ? null : Number(e.target.value))} disabled={running} />
            </label>
            {plan && (
              <div className="plan">
                <div className="planRow"><span>总帧数</span><b>{plan.totalFrames}</b></div>
                <div className="planRow"><span>段数</span><b>{plan.segments.length}</b></div>
                {plan.segments.map((seg) => (
                  <div key={seg.index} className={`seg ${segmentsDone.includes(seg.index) ? 'done' : ''}`}>
                    <div className="segTitle">段 {seg.index} · 帧 {seg.start}–{seg.end}（{seg.emitted} 帧）</div>
                    <div className="segMeta">
                      预热：{seg.index === 0 ? '无（首段）' : `${seg.warmup} 帧 @ ${seg.warmupStart}–${seg.warmupEnd}`}
                    </div>
                    <div className="segMeta">依赖：{seg.dependsOn.length ? seg.dependsOn.map((d) => d.reason).join('；') : '无跨段依赖'}</div>
                  </div>
                ))}
              </div>
            )}
            {dependency && (
              <div className="depBox">
                <div className="depTitle">帧 {dependency.frame} 依赖</div>
                {dependency.needs.length === 0 ? <div className="subtle small">首帧，无历史依赖</div> : (
                  <ul className="small">
                    {dependency.needs.map((n) => <li key={n} className="mono">{n}</li>)}
                  </ul>
                )}
                <div className="subtle small">本帧产出：{dependency.produces.join('、')}</div>
              </div>
            )}
          </section>

          <section>
            <h2>历史校验参数</h2>
            <label className="field">
              <span>每帧采样数（仅影响原始噪声，不用于掩盖历史缺陷）</span>
              <input type="number" min="1" max="8" value={settings.samplesPerFrame}
                onChange={(e) => setSettings({ ...settings, samplesPerFrame: Math.max(1, Number(e.target.value)) })} disabled={running} />
            </label>
            <label className="field">
              <span>历史上限（权重）</span>
              <input type="number" min="2" max="32" value={settings.maxHistory}
                onChange={(e) => setSettings({ ...settings, maxHistory: Number(e.target.value) })} disabled={running} />
            </label>
            <label className="field">
              <span>深度容差</span>
              <input type="range" min="0.005" max="0.15" step="0.005" value={settings.depthTolerance}
                onChange={(e) => setSettings({ ...settings, depthTolerance: Number(e.target.value) })} />
              <span className="mono small">{settings.depthTolerance.toFixed(3)}</span>
            </label>
            <label className="field">
              <span>法线容差</span>
              <input type="range" min="0.5" max="0.99" step="0.01" value={settings.normalTolerance}
                onChange={(e) => setSettings({ ...settings, normalTolerance: Number(e.target.value) })} />
              <span className="mono small">{settings.normalTolerance.toFixed(2)}</span>
            </label>
            <label className="field">
              <span>邻域钳制强度</span>
              <input type="range" min="0.5" max="8" step="0.1" value={settings.clampGamma}
                onChange={(e) => setSettings({ ...settings, clampGamma: Number(e.target.value) })} />
              <span className="mono small">{settings.clampGamma.toFixed(1)}</span>
            </label>
            <label className="field">
              <span>历史混合（1=完整时序，0=仅当前帧）</span>
              <input type="range" min="0" max="1" step="0.01" value={settings.historyBlend}
                onChange={(e) => setSettings({ ...settings, historyBlend: Number(e.target.value) })} />
              <span className="mono small">{settings.historyBlend.toFixed(2)}</span>
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={settings.temporalEnabled}
                onChange={(e) => setSettings({ ...settings, temporalEnabled: e.target.checked })} />
              启用时序历史（关闭后仅逐帧空间降噪，用于对照）
            </label>
            <label className="field">
              <span>曝光（仅显示）</span>
              <input type="range" min="0.3" max="3" step="0.05" value={settings.exposure}
                onChange={(e) => setSettings({ ...settings, exposure: Number(e.target.value) })} />
              <span className="mono small">{settings.exposure.toFixed(2)}</span>
            </label>
          </section>

          <section>
            <h2>历史依赖清单</h2>
            <ul className="artifactList">
              {plan?.artifacts.map((a) => (
                <li key={a.id}>
                  <b>{a.id}</b> <span className="mono small">{a.format}</span>
                  <div className="subtle small">{a.description}</div>
                </li>
              ))}
            </ul>
          </section>
        </aside>

        <main className="content">
          <div className="viewer">
            <canvas ref={canvasRef} className="mainCanvas" />
            <canvas ref={cpuCanvasRef} className="cpuCanvas" onClick={inspectPixel} />
          </div>

          <div className="transport">
            <button onClick={() => setPlaying((p) => !p)} disabled={!frames.length}>{playing ? '暂停' : '播放'}</button>
            <input type="range" min="0" max={Math.max(0, frames.length - 1)} value={Math.min(current, frames.length - 1)}
              onChange={onScrub} disabled={!frames.length} className="scrub" />
            <span className="mono">{frames.length ? `f${frames[current]?.frame ?? 0} · ${current + 1}/${frames.length}` : '—'}</span>
          </div>

          <div className="viewTabs">
            {[
              ['denoised', '降噪帧'],
              ['noisy', '原始噪声帧'],
              ['independent', '逐帧独立降噪'],
              ['adoption', '历史采用'],
              ['motion', '运动矢量（实时）'],
            ].map(([m, label]) => (
              <button key={m} className={view === m ? 'active' : ''} onClick={() => setView(m)}
                disabled={(m === 'motion') && running}>{label}</button>
            ))}
          </div>

          <FrameCompare record={currentRecord} mode={compareMode} setMode={setCompareMode} />

          {currentRecord && (
            <div className="metricsRow">
              <div className="card">
                <h3>本帧历史采用</h3>
                <MetricBar label="采纳" value={currentRecord.metrics.accepted} total={currentRecord.metrics.pixels} color="#2f9e63" />
                {Object.entries(currentRecord.metrics.reasons).map(([code, n]) => (
                  n > 0 ? <MetricBar key={code} label={REASON_LABELS[code]} value={n} total={currentRecord.metrics.pixels} color={REASON_COLORS[code]} /> : null
                ))}
                <div className="metricRow">
                  <span className="metricLabel">平均历史权重</span>
                  <b className="mono">{currentRecord.metrics.meanHistoryWeight.toFixed(3)}</b>
                </div>
                <div className="metricRow">
                  <span className="metricLabel">邻域钳制</span>
                  <b className="mono">{fmtPct(currentRecord.metrics.clampedPct)}</b>
                </div>
              </div>
              <div className="card">
                <h3>回退原因（当前帧）</h3>
                {currentRecord.metrics.rejected === 0 ? (
                  <p className="okText">本帧全部像素使用了历史。</p>
                ) : (
                  <ul className="reasonList">
                    {Object.entries(currentRecord.metrics.reasons).filter(([, n]) => n > 0).map(([code, n]) => (
                      <li key={code}>
                        <span className="dot" style={{ background: REASON_COLORS[code] }} />
                        {REASON_LABELS[code]} <span className="mono">{fmtPct((n / currentRecord.metrics.pixels) * 100)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <button className="smallBtn" onClick={() => exportFramePng('noisy')}>导出本帧原始噪声 PNG</button>
              </div>
            </div>
          )}

          {adoptionInspector && (
            <div className="card">
              <h3>像素检查（f{adoptionInspector.frame} @ {adoptionInspector.x},{adoptionInspector.y}）</h3>
              <p>
                {adoptionInspector.code === 6
                  ? `历史被采纳，混合系数 α=${adoptionInspector.alpha.toFixed(3)}，接入前权重 ${adoptionInspector.weightBefore.toFixed(1)}${adoptionInspector.clamped ? '（发生邻域钳制）' : ''}`
                  : `历史被拒绝：${REASON_LABELS[adoptionInspector.code] ?? '原因 ' + adoptionInspector.code}，回退为当前帧像素`}
              </p>
            </div>
          )}

          {summary && (
            <div className="card wide">
              <h3>结果摘要（全部为实际运算）</h3>
              <table className="table">
                <thead><tr><th>指标</th><th>时序降噪</th><th>逐帧独立降噪</th><th>原始噪声</th></tr></thead>
                <tbody>
                  <tr>
                    <td>时间稳定性（相邻帧亮度平均绝对变化，越低越稳）</td>
                    <td className="mono good">{summary.stability.denoised.toFixed(5)}</td>
                    <td className="mono">{summary.stability.independent.toFixed(5)}</td>
                    <td className="mono">{summary.stability.noisy.toFixed(5)}</td>
                  </tr>
                  <tr>
                    <td>历史采纳率</td><td className="mono">{fmtPct(summary.acceptedPct)}</td><td>—</td><td>—</td>
                  </tr>
                  <tr>
                    <td>邻域钳制像素</td><td className="mono">{fmtPct(summary.clampedPct)}</td><td>—</td><td>—</td>
                  </tr>
                </tbody>
              </table>
              {summary.seams.length > 0 && (
                <>
                  <h4>分段接缝</h4>
                  <p className="subtle small">每段首帧在预热后应与连续运行一致；若预热缺失，平均历史权重会跌至 0。</p>
                  <table className="table">
                    <thead><tr><th>接缝帧</th><th>预热重放</th><th>首帧历史采纳</th><th>平均历史权重</th></tr></thead>
                    <tbody>
                      {summary.seams.map((s) => (
                        <tr key={s.frame}>
                          <td className="mono">f{s.frame}</td>
                          <td>{s.warmupFrames > 0 ? `${s.warmupFrames} 帧 (${s.warmupRange[0]}–${s.warmupRange[1]})` : '无'}</td>
                          <td className="mono">{fmtPct(seamReport?.find((r) => r.frame === s.frame)?.acceptedPct ?? 0)}</td>
                          <td className="mono">{(seamReport?.find((r) => r.frame === s.frame)?.meanWeight ?? 0).toFixed(3)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              <div className="exportRow">
                <button onClick={() => exportVideo('denoised', `${scene.id}-denoised.webm`)} disabled={!!exporting}>
                  导出降噪 WebM
                </button>
                <button onClick={() => exportVideo('noisy', `${scene.id}-noisy.webm`)} disabled={!!exporting}>
                  导出原始噪声 WebM
                </button>
                <button onClick={exportReview} disabled={!!exporting}>导出复核包（噪声帧 + 指标）</button>
                {exporting && <span className="subtle small">{exporting}</span>}
              </div>
            </div>
          )}

          <div className="card wide">
            <h3>运行日志</h3>
            <div className="log">
              {logLines.length === 0 && <div className="subtle">尚无日志。</div>}
              {logLines.map((l, i) => (
                <div key={i} className={`logLine ${l.kind}`}>
                  <span className="mono subtle">{l.t}</span> {l.msg}
                </div>
              ))}
            </div>
          </div>
        </main>

        <aside className="panel right">
          <section>
            <h2>序列进度</h2>
            <div className="subtle small">
              运行状态：
              <b className={running ? 'okText' : ''}>{running ? '运行中（取消会保留已产出帧与历史，不销毁共享状态）' : frames.length ? '已完成 / 可重放' : '空闲'}</b>
            </div>
            <div className="progressTrack"><div className="progressFill" style={{ width: `${progress.total ? (progress.delivered / progress.total) * 100 : 0}%` }} /></div>
            <div className="subtle small">{progress.delivered} / {progress.total} 帧已产出{seamReport ? ` · ${seamReport.length} 处接缝（已预热）` : ''}</div>
            <div className="filmstrip">
              {frames.map((rec, i) => (
                <button key={rec.frame} className={`thumb ${i === current ? 'current' : ''}`} onClick={() => setCurrent(i)} title={`帧 ${rec.frame}`}>
                  <ThumbCanvas record={rec} />
                  <span className="thumbLabel">f{rec.frame}</span>
                  <span className="thumbSeg">段{rec.segment}</span>
                </button>
              ))}
              {frames.length === 0 && <div className="subtle small">渲染后在此显示可拖动缩略序列。</div>}
            </div>
          </section>
          <section>
            <h2>当前帧数据</h2>
            {currentRecord ? (
              <ul className="kv">
                <li><span>帧号</span><b className="mono">{currentRecord.frame}</b></li>
                <li><span>段</span><b className="mono">{currentRecord.segment}</b></li>
                <li><span>历史版本</span><b className="mono">v{currentRecord.historyVersion} · epoch {currentRecord.historyEpoch}</b></li>
                <li><span>历史采纳</span><b className="mono">{fmtPct(currentRecord.metrics.acceptedPct)}</b></li>
                <li><span>平均权重</span><b className="mono">{currentRecord.metrics.meanHistoryWeight.toFixed(3)}</b></li>
                <li><span>钳制像素</span><b className="mono">{fmtPct(currentRecord.metrics.clampedPct)}</b></li>
                <li><span>无历史回退</span><b className="mono">{currentRecord.metrics.noHistoryFallback ? '是（原因码 1）' : '否'}</b></li>
                <li><span>原始噪声浮点保留</span><b>{currentRecord.rawNoisyFloat ? '是' : '否'}</b></li>
              </ul>
            ) : <p className="subtle small">尚未渲染。</p>}
            {currentRecord?.metrics.anomaly && (
              <div className="banner warn small">历史异常：{currentRecord.metrics.anomaly}（帧 {currentRecord.frame}）</div>
            )}
          </section>
          <section>
            <h2>回退策略</h2>
            <ul className="small subtle">
              <li>历史缺失：原因码 1，直接使用当前帧。</li>
              <li>重投影出屏：原因码 2，重投影点不在上一帧内。</li>
              <li>深度不匹配：原因码 3，遮挡解除或背景显露。</li>
              <li>法线不匹配：原因码 4，表面朝向变化。</li>
              <li>运动矢量无效：原因码 5，无法建立对应关系。</li>
              <li>所有回退都会在“历史采用”视图与原因统计中标注。</li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

function ThumbCanvas({ record }) {
  const ref = useRef(null);
  useFrameCanvas(ref, record, 'denoised');
  return <canvas ref={ref} className="thumbCanvas" />;
}

function FrameCompare({ record, mode, setMode }) {
  const denRef = useRef(null);
  const indRef = useRef(null);
  useFrameCanvas(denRef, record, 'denoised');
  useFrameCanvas(indRef, record, 'independent');
  if (!record) return null;
  return (
    <div className="card wide">
      <div className="compareHead">
        <h3>对照</h3>
        <div className="tabs">
          {[['split', '左右分屏'], ['denoised', '仅时序降噪'], ['independent', '仅逐帧独立降噪']].map(([m, label]) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>{label}</button>
          ))}
        </div>
      </div>
      {mode === 'split' && (
        <div className="splitCompare">
          <div className="splitSide">
            <canvas ref={indRef} />
            <span className="splitTag">逐帧独立降噪</span>
          </div>
          <div className="splitSide">
            <canvas ref={denRef} />
            <span className="splitTag right">时序降噪</span>
          </div>
        </div>
      )}
      {mode === 'denoised' && <canvas ref={denRef} className="wideCanvas" />}
      {mode === 'independent' && <canvas ref={indRef} className="wideCanvas" />}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
