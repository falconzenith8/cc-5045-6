# 时序降噪生产管线

浏览器端 WebGL2 路径追踪 + 重投影时序降噪，含任务面板、调度预热、对照预览与序列导出。

**图形入口（主要交付）：**

```bash
npm install
npm run dev
# 打开 http://localhost:5173
```

完整说明（约定、算法、调度/预热、对照与复核、CLI、测试、限制）见 [`docs/README.md`](docs/README.md)。

## 快速开始

**图形入口（主要交付）：**

```bash
npm install
npm run dev          # 启动时序降噪出图面板，打开 http://localhost:5173
```

面板内可开始/取消渲染、拖动序列、清除历史、查看降噪帧与历史采用、读取每帧历史版本与异常。命令行仅作自动化辅助：

```bash
npm test             # 单元测试（调度、历史存储、检查点等）
npx playwright test  # 端到端测试（需 npx playwright install chromium）
npm run verify       # 定量复核：稳定性/拖影/接缝 + 取消重排等价性
npm run cli -- plan --scene fast-occlusion --segments 2   # 辅助 CLI
```

## 核心约定速览

- 运动矢量为**像素**单位，`prevPixel - curPixel`，指向同一世界表面点的上一帧位置；移动物体含自身位移，天空按视线方向重投影。
- 深度为沿相机前向轴的线性距离；法线为世界空间法线。
- 每帧显式依赖上一帧的 `historyColor` 与 `historyDepth`；多段执行时非首段预热重放 `maxHistory-1` 帧，避免接缝跳变。
- 历史 GPU 产物由 `src/temporal/historyStore.js` 唯一持有，经 `acquire(frame)/commit/release` 借用：帧身份不连续会抛 `FrameIdentityError`，取消只 `release` 不销毁共享状态，重跑用 `beginReplay` 按对应帧身份重建；检查点以 epoch/历史版本钉住链身份（`checkpointStore.js`）。
- 历史缺失/无效时明确回退到当前帧，并在面板与结果区显示原因码。
- 所有对照都基于同一每帧采样数；不靠提高采样数掩盖历史缺陷。
