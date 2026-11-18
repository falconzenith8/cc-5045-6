# 时序降噪生产管线

浏览器端（WebGL2）真实路径追踪 + 重投影时序降噪。每帧渲染颜色、运动矢量、深度与法线，用历史累积压低随机噪声，并通过深度/法线/运动有效性校验拒绝不属于同一表面的历史，避免闪烁与移动物体拖影。

## 图形入口（主要交付方式）

```bash
npm install
npm run dev
```

打开 <http://localhost:5173>。这是本项目的主要入口：**时序降噪出图任务面板**。

面板能力：

| 区域 | 功能 |
| --- | --- |
| 顶栏 | 选择三支测试短片、开始渲染、取消、**清除历史** |
| 左栏 | 执行计划（分段/预热帧数/每段依赖）、历史依赖清单、校验与降噪参数 |
| 主画布 | 降噪帧 / 原始噪声帧 / 逐帧独立降噪 / 历史采用热图 切换 |
| 时间轴 | **拖动序列逐帧查看**，播放/暂停 |
| 缩略序列 | 每帧缩略图，标注所属任务段 |
| 对照区 | 逐帧独立降噪与时序降噪的**左右分屏**对比 |
| 本帧历史采用 | 采纳比例、平均历史权重、各类回退原因占比 |
| 像素检查 | 点击画面任意像素，读取该帧实际采纳值/拒绝原因（独立重放同一时序路径） |
| 结果摘要 | 时间稳定性、采纳率、钳制比例、分段接缝表 |
| 导出 | 降噪 WebM（可播放序列）、原始噪声 WebM、复核包 ZIP |

异常会在顶栏横幅、日志与结果表中以中文提示，例如“历史已清除”“渲染器错误：…”“视频导出失败：…”。WebGL2 或浮点渲染目标不可用时，面板直接报错而不是静默降级。

## 约定（实现标准的定义）

代码注释与文档使用同一套约定：

- **世界坐标**：右手系，+Y 向上。
- **相机**：`eye / target / up`；前向 = `normalize(target - eye)`。
- **时间**：`t = frame / fps`，上一帧为 `t - 1/fps`。物体运动按解析式在 `t` 与 `t-dt` 采样。
- **屏幕像素**：左下角为原点，+x 向右、+y 向上（WebGL 帧缓冲），像素中心 `(i+0.5, j+0.5)`。
- **运动矢量**：以帧缓冲**像素**为单位，值为 `prevPixel - curPixel`，指向“同一世界表面点”在上一帧的像素位置。相机运动由上一帧完整的视图投影矩阵产生；移动物体使用自身中心的位移修正 `P_prev = P + (center_prev - center_cur)`，因此**不是**只对相邻帧做平均，移动物体不会拖影。天空像素按视线方向在无穷远处重投影。
- **深度**：沿相机前向轴的线性距离（视空间 z），不是 NDC 深度。
- **法线**：世界空间单位法线。

## 时序降噪算法

1. **路径追踪**（`src/render/shaders.js` → `PATHTRACE_FS`）：每像素 1 次主光线 + 面光源采样 + 一次漫反射弹射；Halton 抖动子像素。输岀 4 个附件：颜色、法线+深度、运动矢量、物体 id。
2. **重投影与校验**（`TEMPORAL_FS`）：用运动矢量取历史颜色与上一帧深度/法线，依次校验
   - 历史是否存在（权重 > 0）
   - 运动矢量是否有效
   - 重投影点是否在上一帧内
   - 深度是否一致（`|d_cur - d_prev| <= tol * max(1, d_cur)`）
   - 法线是否一致（点积 ≥ 阈值）
3. **邻域钳制**：把历史颜色限制在当前帧 3×3 邻域的均值±标准差范围内，抑制残留辉光，并统计“钳制像素”。
4. **权重累积**：`w' = min(w + 1, maxHistory)`，混合系数 `α = mix(1, 1/w', historyBlend)`，历史越久越信任。
5. **边缘感知空间滤波**（`SPATIAL_FS`）：法线/深度/颜色三边权重，仅作用于已累积结果，不清零历史权重。
6. **回退策略**：任何校验失败都直接使用当前帧像素（`α=1`），并把原因码写入采纳图与统计。**历史缺失或无效时不用任何历史，原因在面板与结果区明确显示**。

原因码：`1` 无历史、`2` 重投影出屏、`3` 深度不匹配（遮挡解除/露背景）、`4` 法线不匹配、`5` 运动矢量无效、`6` 采纳。

## 调度与预热

`src/temporal/frameGraph.js` 产出执行计划（经 `src/temporal/scheduler.js` 门面导出，旧入口不变）：

- 每帧显式依赖：`historyColor@frame-1`、`historyDepth@frame-1`；本帧产出 `historyColor@frame`、`historyDepth@frame`。
- 计划中的每个任务段声明其 `dependsOn`、`warmup`、`warmupStart/warmupEnd` 与产物。
- 切成多段时，非首段必须**预热重放**其前面的 `maxHistory-1` 帧（沿真实时间线回退，可早于任务起点），预热帧不交付但重建历史权重。

面板显示每段预热范围与依赖；重新计算计划时会跑 `validatePlan`，缺少预热会被标记为错误。

未预热会把每段首帧当作无关静态图，历史权重从 0 重新爬升，接缝处出现数帧噪声回升（约 11 帧），随后回落——这正是周期性画质跳变。测试 `tests/e2e/temporal.spec.js` 用数值固定了这一点：无预热首帧采纳率 < 2%、权重 < 0.02；预热后首帧采纳率 > 90%、权重 > 0.7。

## 历史所有权与取得/释放接口

历史相关职责已从渲染器拆出，调度、历史存储与检查点各司其职，降噪算法与参数（`shaders.js` 与 `DEFAULT_SETTINGS`）保持不变：

| 模块 | 职责 |
| --- | --- |
| `temporal/frameGraph.js` | 纯调度：执行计划、逐帧依赖、计划校验（无 GL、无状态） |
| `temporal/historyStore.js` | GPU 历史产物（双缓冲颜色/权重 + 上一帧法线深度）的唯一所有者 |
| `temporal/checkpointStore.js` | 检查点元数据：epoch/历史版本/帧身份，以及帧误差证据 |
| `temporal/equivalence.js` | 帧 RMSE、亮度差与采纳率/权重差分，限定不同执行顺序的等价性 |
| `temporal/scheduler.js` | 兼容门面，统一再导出上述符号，旧调用方无需改路径 |

`HistoryStore` 的显式协议：

- `acquire(frame)`：按**帧身份**借用历史。仅当 `frame === lastFrame + 1` 且链有效时才返回有效租约；链无效时返回 `valid:false` 的租约，渲染器走着色器原因码 1 的无历史回退（不用默认值遮错）。帧号不连续直接抛 `FrameIdentityError`。
- `commit(lease)`：交还并交换双缓冲，写入帧身份、历史版本 `version` 单调递增。
- `release(lease)`：中途取消只归还租约，**不销毁**共享历史；取消任务因此可以安全重跑。
- `invalidate(reason)` / 渲染器 `clearHistory()` / `beginReplay(reason)`：失效并开启新的 `epoch`，存储本身保留。预热重放与取消后重跑通过 `beginReplay` 显式开重放窗口，再按对应帧身份重建。
- `describe()`：返回 `{ valid, lastFrame, version, epoch, width, height }`，供检查点核对。

`CheckpointStore.saveCheckpoint` 只接受有效链的 `{frame, epoch, version}`，不为缺失历史合成默认检查点；`verify(id, state)` 在 epoch/版本/帧身份漂移时返回明确问题。`JobRunner` 在每个段边界用真实历史版本建立检查点，并在取消时只 `releaseFrame` 不清历史。

### 取消重排与历史缺失的等价性证据

`npm run verify` 第 4 节固定了历史所有权重构的行为（本机实测）：

- 取消后保留链末端（如帧 12、epoch 3、v13），重放开显式重放窗口（帧 9–19）；重跑交付帧与连续运行逐帧对比，最大像素 RMSE 约 0.0018（容差 0.02）、采纳率差 0.00pp、权重差 0.0000，在容差内等价。
- 清除历史后 epoch 递增、链标记无效，下一帧采纳率 0%、原因码 1 像素数等于全帧像素，且 GPU 存储仍然保留（未被提前销毁）。
- 重构前后同一 CLI 计划（moving-camera，84 帧、两段、预热 11）逐帧 `acceptedPct` 与 `meanHistoryWeight` 差分均为 0。

对应回归在 `tests/e2e/historyOwnership.spec.js`（帧身份抛错、取消保留、历史缺失、检查点漂移）与 `tests/historyStore.test.js`、`tests/checkpointStore.test.js`。

## 三支测试短片

| 场景 | 检验点 |
| --- | --- |
| 移动相机 | 相机横移推进 + 球体周期浮动；检验重投影与边缘稳定性 |
| 突然显露背景 | 遮罩快速上移露出高亮面板；检验离屏/深度不匹配的拒绝与回退 |
| 物体快速遮挡 | 大球贴镜头高速掠过并离开；检验快速运动矢量、遮挡解除后的历史重建 |

## 对照与复核

- **逐帧独立降噪**：每帧只做空间滤波、不带历史，作为对照列。
- **连续参考**：`ghostProbe` 以高采样（24 spp）、关闭时序渲染同帧参考，用于客观检验拖影。
- **不做“提高采样数掩盖问题”**：面板与 CLI 的对照均使用同一 `samplesPerFrame`（默认 1）。预览截图只是对同一浮点缓冲重新色调映射，不额外采样。
- **原始噪声保留**：每帧 `rawNoisyFloat` / `rawHistoryFloat` 保留在内存，复核包导出 `noisy/frame_XXXX.png` 与 `manifest.json`（含每帧采纳率、回退原因、接缝）。

### 已做的定量检验（本机实测）

- 静止区域时间稳定性（相邻帧亮度平均绝对变化，越低越稳）：时序降噪约为逐帧独立降噪的 2.1–3.1 倍改善。
- 运动像素上时序结果相对高采样参考的误差 **从不高于**独立降噪（最差 1.00×，遮挡覆盖中心 0.53×），即没有历史拖影。
- 接缝：无预热 f20 采纳 0%、平均权重 0，之后逐帧爬升（0.00→0.05→0.12→0.20→0.28→0.37）；预热后 f20 与连续运行一致（99%、0.87）。

## 命令行（辅助）

CLI 只是辅助，驱动同一套 WebGL2 管线（无头 Chromium），不另行实现降噪。

```bash
# 打印执行计划与校验
npm run cli -- plan --scene fast-occlusion --segments 2

# 实际运行并打印每帧采纳率/回退原因/接缝
npm run cli -- run --scene moving-camera --segments 2 --out ./out

# 运行并写出末帧 PNG + metrics.json（完整序列请用图形面板导出）
npm run cli -- export --scene background-reveal --out ./out
```

接缝未恢复历史时 CLI 以退出码 3 标记。

无头运行若缺系统库，可把 Debian 库解包目录加入 `LD_LIBRARY_PATH`（CLI 默认尝试 `/tmp/sysroot/...`），或使用有完整依赖的桌面环境。

## 测试

```bash
npm test          # 调度、场景、相机/投影约定、历史存储与检查点（29 项）
npx playwright test  # 端到端：面板、预热接缝、历史所有权、导出、拖影与稳定性（10 项）
```

端到端测试在无头 Chromium（SwiftShader）下跑真实 WebGL2 管线，包含 WebM/复核包下载与解包校验。

## 目录

```
src/
  math/mat4.js            矩阵与屏幕/NDC 约定
  scene/scene.js          三支短片、运动解析式、相机、打包 uniform
  render/shaders.js       GLSL：路径追踪、时序、空间、显示、采纳可视化
  render/renderer.js      渲染器与降噪 passes；经 HistoryStore 借用历史
  render/jobRunner.js     按计划执行分段与预热、段边界检查点、采集每帧结果
  temporal/frameGraph.js  帧依赖、分段、预热、校验（纯调度）
  temporal/historyStore.js  GPU 历史所有权：acquire/commit/release、帧身份、epoch/版本
  temporal/checkpointStore.js 检查点元数据与帧误差证据
  temporal/equivalence.js 帧 RMSE/亮度/采纳差分与执行顺序等价判定
  temporal/scheduler.js   兼容门面：再导出调度与历史接口
  export/exporters.js     WebM 编码、复核包 ZIP、PNG
  ui/App.jsx              任务面板（图形入口）
cli/temporal-cli.mjs      辅助 CLI
tests/                    单测、harness、Playwright 端到端
```

## 已知限制

- 路径追踪为单次漫反射弹射 + 面光源直接采样，未做 MIS，亮面噪声较多属于预期。
- 历史仅保存单层颜色与权重，几何边缘依赖邻域钳制与空间滤波，未实现全率的 σ-clamping。
- WebM 通过 `MediaRecorder` 生成，需真实时间的帧节拍；长序列导出较慢。
- CLI 的 `export` 只写末帧 PNG，完整序列请用面板导出（面板会编码全部帧）。
