// Checkpoint metadata for history chains.
//
// A checkpoint pins the identity of a history chain at one frame: which epoch
// it belongs to, which frame produced it, and the monotonic history version of
// that frame. The GPU textures stay in HistoryStore — this store only keeps
// serializable metadata plus any frame-error evidence attached during review.
//
// The identity fields are what make a rerun explainable: after a cancel and a
// replay, a checkpoint is accepted only when the rebuilt chain reports the same
// epoch/version/frame. A mismatch is reported as a problem, never papered over
// with a default checkpoint.

export class CheckpointError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'CheckpointError';
    this.details = details;
  }
}

function requireInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new CheckpointError(`${label} 必须是非负整数，收到 ${value}`, { value });
  }
}

export class CheckpointStore {
  constructor() {
    this._items = new Map();
  }

  /**
   * Persist a chain identity snapshot, normally taken from
   * HistoryStore.describe() right after commit().
   *
   * @param {{frame:number, epoch:number, version:number, valid?:boolean,
   *          reason?:string, plan?:object}} descriptor
   */
  saveCheckpoint(descriptor = {}) {
    requireInteger(descriptor.frame, 'frame');
    requireInteger(descriptor.epoch, 'epoch');
    requireInteger(descriptor.version, 'version');
    if (descriptor.valid === false) {
      throw new CheckpointError(
        `帧 ${descriptor.frame} 的历史链无效，不能建立检查点`, descriptor);
    }
    const checkpoint = {
      id: `cp-f${descriptor.frame}-e${descriptor.epoch}-v${descriptor.version}`,
      frame: descriptor.frame,
      epoch: descriptor.epoch,
      historyVersion: descriptor.version,
      reason: descriptor.reason ?? 'segment-boundary',
      plan: descriptor.plan ?? null,
      evidence: null,
      createdAt: new Date().toISOString(),
    };
    this._items.set(checkpoint.id, checkpoint);
    return { ...checkpoint };
  }

  getCheckpoint(id) {
    const cp = this._items.get(id);
    return cp ? { ...cp } : null;
  }

  listCheckpoints() {
    return [...this._items.values()].map((cp) => ({ ...cp }));
  }

  /** Attach measured frame-error evidence (RMSE/adoption deltas) to a checkpoint. */
  attachEvidence(id, evidence) {
    const cp = this._items.get(id);
    if (!cp) throw new CheckpointError(`检查点不存在: ${id}`, { id });
    if (!evidence || typeof evidence !== 'object') {
      throw new CheckpointError('帧误差证据必须是对象', { id });
    }
    cp.evidence = { ...evidence, recordedAt: new Date().toISOString() };
    return { ...cp };
  }

  getEvidence(id) {
    const cp = this._items.get(id);
    if (!cp) throw new CheckpointError(`检查点不存在: ${id}`, { id });
    return cp.evidence ? { ...cp.evidence } : null;
  }

  /**
   * Verify that a checkpoint still describes the live history chain.
   * `state` is a HistoryStore.describe() snapshot.
   */
  verify(id, state) {
    const cp = this._items.get(id);
    if (!cp) throw new CheckpointError(`检查点不存在: ${id}`, { id });
    if (!state || typeof state !== 'object') {
      throw new CheckpointError('verify 需要 HistoryStore.describe() 的状态对象', { id });
    }
    const problems = [];
    if (state.epoch !== cp.epoch) {
      problems.push(`epoch 不一致：检查点 ${cp.epoch}，当前 ${state.epoch}（链曾被失效重建）`);
    }
    if (state.version !== cp.historyVersion) {
      problems.push(`历史版本不一致：检查点 v${cp.historyVersion}，当前 v${state.version}`);
    }
    if (state.lastFrame !== cp.frame) {
      problems.push(`帧身份不一致：检查点属于帧 ${cp.frame}，当前链末端为帧 ${state.lastFrame}`);
    }
    if (state.valid === false) problems.push('当前历史链无效');
    return { ok: problems.length === 0, checkpoint: { ...cp }, state: { ...state }, problems };
  }

  get size() {
    return this._items.size;
  }
}
