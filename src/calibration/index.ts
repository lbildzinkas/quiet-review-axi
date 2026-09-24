// Calibration kit: evaluates any judge that returns a probability per item against known
// labels. It has no Quiet Review, GitHub or model-provider dependencies.
export {
  auroc,
  calibrationTable,
  chooseThreshold,
  precisionAtOrAbove,
  shareBelow,
  thresholdSweep,
  type CalibrationBin,
  type ScoredExample,
  type SweepOptions,
  type SweepRow,
} from './metrics.js'
export {
  bootstrapRanges,
  DEFAULT_LEVEL,
  DEFAULT_RESAMPLES,
  type BootstrapOptions,
  type Range,
} from './bootstrap.js'
export { seededRandom } from './random.js'
export {
  evaluateJudgments,
  type Evaluation,
  type EvaluationOptions,
  type GroupRow,
  type LabelledJudgment,
  type PassRule,
  type Verdict,
} from './evaluate.js'
export { calibratedBand, type Band } from './band.js'
export { driftedSnapshots } from './drift.js'
export { regressionGate, type GateBaseline, type GateLimits, type GateResult } from './gate.js'
export { judgeLabelled, type Judge, type Judgment, type LabelledItem } from './judge.js'
