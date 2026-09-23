export interface ResolvedCutoffs {
  collapseBelow: number
  keepAt: number
}

// Built-in band from the vendor cookbooks (spec 6.2); always uncalibrated.
export const BUILT_IN_CUTOFFS = { collapseBelow: 0.3, keepAt: 0.7 }

export function resolveCutoffs(): ResolvedCutoffs {
  return { ...BUILT_IN_CUTOFFS }
}

export function describeCutoffs(cutoffs: ResolvedCutoffs): string {
  return `collapse<${cutoffs.collapseBelow.toFixed(2)} keep>=${cutoffs.keepAt.toFixed(2)} (built-in, uncalibrated)`
}
