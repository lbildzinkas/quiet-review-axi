import { JEV_PRICE_PER_INPUT_TOKEN } from '../jev/provider.js'

// Estimates are padded so a paid call cannot overshoot the limit by much (spec 9.4).
export const ESTIMATE_SAFETY_FACTOR = 1.5

export function estimateCostUsd(estimatedTokens: number): number {
  return estimatedTokens * JEV_PRICE_PER_INPUT_TOKEN
}

// Per-run budget (spec 9.4): a paid call is made only if the spend so far plus its padded
// estimate stays within --max-cost. Spend uses observed cost, never the estimate.
export function createBudget(maxCostUsd: number) {
  let spentUsd = 0
  return {
    canAfford: (estimatedTokens: number) =>
      spentUsd + estimateCostUsd(estimatedTokens) * ESTIMATE_SAFETY_FACTOR <= maxCostUsd,
    spend: (costUsd: number) => void (spentUsd += costUsd),
    spent: () => spentUsd,
  }
}
