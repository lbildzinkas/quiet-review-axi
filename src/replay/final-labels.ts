import type { Label } from './label.js'
import { fromJsonl, readOptional, replayFiles } from './store.js'

export interface FinalLabel {
  id: string
  label: Label
  reason: string | null
}

// The labels the score and evaluate stages read (spec 10.6 step 5): the label stage's
// automatic labels, with the label check's final labels in their place once the maintainer's
// review is complete. The check stage removes final-labels.jsonl whenever its review waits, so
// the file's presence means the review is done. `text` covers both files, so a changed review
// changes the score and evaluate stages' input hashes.
export async function readFinalLabels(
  dir: string,
): Promise<{ text: string; labels: FinalLabel[] } | null> {
  const files = replayFiles(dir)
  const automaticText = await readOptional(files.labels)
  if (automaticText === null) return null
  const automatic = fromJsonl<FinalLabel>(automaticText)
  const checkedText = await readOptional(files.finalLabels)
  if (checkedText === null) return { text: automaticText, labels: automatic }
  const checked = new Map(
    fromJsonl<{ id: string; label: Label; source: string }>(checkedText).map((entry) => [
      entry.id,
      entry,
    ]),
  )
  const labels = automatic.map((entry): FinalLabel => {
    const final = checked.get(entry.id)
    if (!final || final.label === entry.label) return entry
    return {
      id: entry.id,
      label: final.label,
      reason: final.label === 'excluded' ? `${final.source} review` : null,
    }
  })
  return { text: `${automaticText}${checkedText}`, labels }
}
