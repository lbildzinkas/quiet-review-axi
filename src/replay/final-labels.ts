import type { Label } from './label.js'
import { fromJsonl, readOptional, replayFiles } from './store.js'

export interface FinalLabel {
  id: string
  label: Label
  reason: string | null
}

// The labels the score and evaluate stages read. Today they are the label stage's
// automatic labels; once the label check (spec 10.6) records the maintainer's reviewed
// labels, this is the one place that combines them into the final labels.
export async function readFinalLabels(
  dir: string,
): Promise<{ text: string; labels: FinalLabel[] } | null> {
  const text = await readOptional(replayFiles(dir).labels)
  if (text === null) return null
  return { text, labels: fromJsonl<FinalLabel>(text) }
}
