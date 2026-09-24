// Repository and bot qualification (spec 10.3). Pure: build gathers the facts from GitHub.

export const MIN_MERGED_PRS = 30
export const MIN_BOT_PRS = 10
const MIN_LATIN_SHARE = 0.9

// GitHub owners of each bot's vendor. A vendor's own repositories are left out, so a vendor
// that tunes its bot on its own code cannot skew the replay. Unlisted bots have no vendor.
export const BOT_VENDORS: Record<string, string[]> = {
  'coderabbitai[bot]': ['coderabbitai'],
  'copilot-pull-request-reviewer[bot]': ['github'],
  'greptile-apps[bot]': ['greptileai'],
  'cursor[bot]': ['cursor', 'getcursor'],
}

export interface RepositoryMeta {
  owner: string
  isPrivate: boolean
  isArchived: boolean
  isFork: boolean
}

export interface Rejection {
  kind: 'repository' | 'bot'
  candidate: string
  reason: string
}

// Criteria 1 and 5: public, not archived, not a fork, not owned by a listed bot's vendor.
export function metadataRejection(meta: RepositoryMeta | null, bots: string[]): string | null {
  if (meta === null) return 'not found or not visible to the token'
  if (meta.isPrivate) return 'private'
  if (meta.isArchived) return 'archived'
  if (meta.isFork) return 'fork'
  const owner = meta.owner.toLowerCase()
  const vendorOf = bots.find((bot) => (BOT_VENDORS[bot] ?? []).includes(owner))
  return vendorOf === undefined ? null : `owned by the vendor of ${vendorOf}`
}

// Criterion 2: at least 30 merged PRs in the window.
export function busyRejection(mergedInWindow: number): string | null {
  if (mergedInWindow >= MIN_MERGED_PRS) return null
  return `${mergedInWindow} merged PRs in the window, needs ${MIN_MERGED_PRS}`
}

// Criterion 3: one listed bot left inline review comments on at least 10 of those PRs.
export function botActivityRejection(prsPerBot: Record<string, number>): string | null {
  const [bot, count] = Object.entries(prsPerBot).sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
  if (count >= MIN_BOT_PRS) return null
  const most = count === 0 ? 'none found' : `most: ${bot} on ${count}`
  return `no listed bot left inline comments on ${MIN_BOT_PRS} merged PRs (${most})`
}

// Criterion 4, as a script check: at least 90% of the letters in the PR titles are basic
// Latin. It rejects repositories that work in another script; it cannot tell English from
// other Latin-script languages.
export function languageRejection(titles: string[]): string | null {
  const letters = titles.join(' ').match(/\p{L}/gu) ?? []
  if (letters.length === 0) return null
  const latin = letters.filter((letter) => /[A-Za-z]/.test(letter)).length
  return latin / letters.length >= MIN_LATIN_SHARE ? null : 'not mainly English'
}
