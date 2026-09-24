// A calibration holds only for the model snapshot it was measured on. Returns the observed
// snapshots that differ from it: when any do, the calibration is stale.
export function driftedSnapshots(calibratedOn: string, observed: readonly string[]): string[] {
  return [...new Set(observed.filter((snapshot) => snapshot !== calibratedOn))]
}
