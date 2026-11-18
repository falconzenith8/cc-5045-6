// Temporal scheduling facade (compatibility entry point).
//
// The frame dependency graph and segment planning now live in frameGraph.js;
// history ownership and checkpoints live in historyStore.js /
// checkpointStore.js. Existing callers import the same names from this file,
// so the temporal denoiser's public entry point is unchanged while the
// responsibilities are split:
//
//   frameGraph.js      pure scheduling: plans, per-frame dependencies, validation
//   historyStore.js    GPU history artifacts: acquire / commit / release, frame identity
//   checkpointStore.js checkpoint metadata: epoch/version pinning, frame-error evidence
//   equivalence.js     frame RMSE / adoption deltas for execution-order equivalence

export {
  HISTORY_ARTIFACTS,
  planExecution,
  dependsOnFrame,
  validatePlan,
} from './frameGraph.js';

export { HistoryStore, FrameIdentityError, HistoryLeaseError } from './historyStore.js';
export { CheckpointStore, CheckpointError } from './checkpointStore.js';
export { frameRmse, frameLumaMad, compareExecutions } from './equivalence.js';
