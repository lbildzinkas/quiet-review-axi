import { driftedSnapshots } from '../calibration/index.js'
import { validationError } from '../errors.js'

export type CutoffSource = 'flag' | 'repo config' | 'user config' | 'built-in'

export interface UserConfigCutoffs {
  collapse_below?: number
  keep_at?: number
  replay?: string
  snapshot?: string
  tested_collapse_below?: number
  written_at?: string
}

export interface CutoffInputs {
  flags?: { collapseBelow?: number; keepAt?: number }
  repoConfig?: { collapse_below?: number; keep_at?: number }
  userConfig?: UserConfigCutoffs
}

export interface Calibration {
  replay: string
  snapshot: string
}

export interface ResolvedCutoffs {
  collapseBelow: number
  keepAt: number
  collapseSource: CutoffSource
  keepSource: CutoffSource
  // Present when the user config's cut-offs were written by a passing replay.
  calibration: Calibration | null
  testedCollapseBelow: number | null
}

export interface CutoffDescription {
  line: string
  // The same, in words, for --human output.
  sentence: string
  isStale: boolean
  warnings: string[]
  help: string[]
}

// Built-in band from the vendor cookbooks (spec 6.2); always uncalibrated.
export const BUILT_IN_CUTOFFS = { collapseBelow: 0.3, keepAt: 0.7 }

// Resolves each cut-off from the first source that sets it (spec 6.2).
export function resolveCutoffs(inputs: CutoffInputs): ResolvedCutoffs {
  const collapse = firstSet([
    ['flag', inputs.flags?.collapseBelow],
    ['repo config', inputs.repoConfig?.collapse_below],
    ['user config', inputs.userConfig?.collapse_below],
    ['built-in', BUILT_IN_CUTOFFS.collapseBelow],
  ])
  const keep = firstSet([
    ['flag', inputs.flags?.keepAt],
    ['repo config', inputs.repoConfig?.keep_at],
    ['user config', inputs.userConfig?.keep_at],
    ['built-in', BUILT_IN_CUTOFFS.keepAt],
  ])
  if (!(collapse.value >= 0 && collapse.value <= keep.value && keep.value <= 1))
    throw validationError(
      `Cut-offs must satisfy 0 <= collapse_below <= keep_at <= 1; got collapse_below ${collapse.value} (${collapse.source}) and keep_at ${keep.value} (${keep.source})`,
      [
        'Run `quiet-review-axi score <pr-url> --collapse-below 0.3 --keep-at 0.7` with valid cut-offs',
      ],
    )
  const user = inputs.userConfig
  return {
    collapseBelow: collapse.value,
    keepAt: keep.value,
    collapseSource: collapse.source,
    keepSource: keep.source,
    calibration:
      user?.replay && user.snapshot ? { replay: user.replay, snapshot: user.snapshot } : null,
    testedCollapseBelow: user?.tested_collapse_below ?? null,
  }
}

function firstSet(candidates: [CutoffSource, number | undefined][]) {
  const [source, value] = candidates.find(([, candidate]) => candidate !== undefined) ?? [
    'built-in',
    0,
  ]
  return { source, value: value ?? 0 }
}

// Every output prints the cut-offs with their source and calibration state (spec 6.2).
export function describeCutoffs(cutoffs: ResolvedCutoffs, snapshots: string[]): CutoffDescription {
  const usesCalibration =
    cutoffs.calibration !== null &&
    (cutoffs.collapseSource === 'user config' || cutoffs.keepSource === 'user config')
  const newSnapshots =
    cutoffs.calibration === null ? [] : driftedSnapshots(cutoffs.calibration.snapshot, snapshots)
  const isStale = usesCalibration && newSnapshots.length > 0
  const state = (source: CutoffSource) => {
    if (source === 'built-in') return 'uncalibrated'
    if (source !== 'user config' || cutoffs.calibration === null) return 'hand-set'
    const calibrated = `calibrated on ${cutoffs.calibration.snapshot} by replay ${cutoffs.calibration.replay}`
    return isStale ? `${calibrated}, stale` : calibrated
  }
  const collapse = `${cutoffs.collapseSource}, ${state(cutoffs.collapseSource)}`
  const keep = `${cutoffs.keepSource}, ${state(cutoffs.keepSource)}`
  const provenance = collapse === keep ? collapse : `collapse: ${collapse}; keep: ${keep}`
  const warnings: string[] = []
  const help: string[] = []
  if (isStale && cutoffs.calibration) {
    warnings.push(
      `calibrated cut-offs were measured on ${cutoffs.calibration.snapshot}, this run used ${newSnapshots.join(', ')}`,
    )
    help.push(
      `Run \`quiet-review-axi replay ${cutoffs.calibration.replay}\` again to re-measure the cut-offs on the new model snapshot`,
    )
  }
  if (cutoffs.testedCollapseBelow !== null && cutoffs.collapseBelow > cutoffs.testedCollapseBelow)
    warnings.push(
      `collapse cut-off ${formatCutoff(cutoffs.collapseBelow)} is above the ${formatCutoff(cutoffs.testedCollapseBelow)} the last replay tested, so more real issues than the replay measured may be collapsed`,
    )
  const isBuiltIn = cutoffs.collapseSource === 'built-in' && cutoffs.keepSource === 'built-in'
  return {
    line: `collapse<${formatCutoff(cutoffs.collapseBelow)} keep>=${formatCutoff(cutoffs.keepAt)} (${provenance})`,
    sentence: isBuiltIn
      ? 'built-in, not yet calibrated'
      : `collapse below ${formatCutoff(cutoffs.collapseBelow)}, keep at ${formatCutoff(cutoffs.keepAt)} (${provenance})`,
    isStale,
    warnings,
    help,
  }
}

// At least two decimals, more when the value has them (0.3 -> 0.30, 0.275 -> 0.275).
export function formatCutoff(value: number): string {
  const decimals = String(value).split('.')[1]?.length ?? 0
  return value.toFixed(Math.min(Math.max(2, decimals), 6))
}
