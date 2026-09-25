import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runReplay, setupReplay } from './helpers/replay.js'

function replayPath(sandbox: { cwd: string }, file: string) {
  return join(sandbox.cwd, '.quiet-review', 'replays', 'public-v1', file)
}

// A 40-character hex sha, unique per number, for commit references in replies.
const sha = (n: number) => n.toString(16).padStart(4, '0') + 'e4ce41' + '0'.repeat(30)

// End-to-end slices of label-rules-v2: the new evidence is read from GitHub during `build`,
// and the label rules act on it (spec 10.5). All offline, against the fake GitHub world.
describe('label-rules-v2 evidence read from GitHub (spec 10.5)', () => {
  it('labels real when a reviewing bot whose self-resolve means fixed resolved the thread', async () => {
    const { sandbox, gitHub } = setupReplay({
      config: { target_items: 100, bots: ['cursor[bot]'] },
      specs: [
        {
          name: 'acme/widgets',
          bots: { 'cursor[bot]': 10 },
          changed: () => false,
          resolved: ({ pr }) => pr <= 3,
          resolvedBy: ({ pr }) => (pr <= 3 ? 'cursor[bot]' : undefined),
        },
      ],
    })

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('label,done,"real 3, noise 7, excluded 0"')
  })

  it('does not trust a self-resolve by a bot with unverified resolve behaviour', async () => {
    const { sandbox, gitHub } = setupReplay({
      config: { target_items: 100 },
      specs: [
        {
          name: 'acme/widgets',
          bots: { 'coderabbitai[bot]': 10 },
          changed: () => false,
          resolved: ({ pr }) => pr <= 3,
          resolvedBy: ({ pr }) => (pr <= 3 ? 'coderabbitai[bot]' : undefined),
        },
      ],
    })

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('label,done,"real 0, noise 10, excluded 0"')
  })

  it('labels real when a reply from a coding agent names a commit that came after the comment', async () => {
    const { sandbox, gitHub } = setupReplay({
      config: { target_items: 100 },
      specs: [
        {
          name: 'acme/widgets',
          bots: { 'coderabbitai[bot]': 10 },
          changed: () => false,
          resolved: ({ pr }) => pr <= 2,
          commits: (pr) => [
            { sha: `f-acme-widgets-${pr}`, subject: 'Start the change' },
            { sha: sha(pr), subject: 'Guard the null dereference' },
          ],
          replies: ({ pr }) =>
            pr <= 2
              ? [
                  {
                    login: 'claude[bot]',
                    type: 'Bot',
                    body: `Fixed in ${sha(pr)}: the dereference is guarded now.`,
                  },
                ]
              : [],
        },
      ],
    })

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('label,done,"real 2, noise 8, excluded 0"')
  })

  it('labels real when a follow-up commit on the base branch changed the commented line', async () => {
    const { sandbox, gitHub } = setupReplay({
      config: { target_items: 100 },
      specs: [
        {
          name: 'acme/widgets',
          bots: { 'coderabbitai[bot]': 10 },
          changed: () => false,
          followUps: ({ pr }) =>
            pr <= 2 ? [{ sha: sha(pr), subject: 'Fix the null dereference upstream' }] : [],
        },
      ],
    })

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('label,done,"real 2, noise 8, excluded 0"')
  })

  it('ignores a follow-up commit that does not touch the commented lines', async () => {
    const { sandbox, gitHub } = setupReplay({
      config: { target_items: 100 },
      specs: [
        {
          name: 'acme/widgets',
          bots: { 'coderabbitai[bot]': 10 },
          changed: () => false,
          followUps: ({ pr }) =>
            pr <= 2
              ? [
                  {
                    sha: sha(pr),
                    subject: 'Unrelated cleanup elsewhere',
                    // A patch changing a line far from the anchor (line 10).
                    patch: '@@ -80,3 +80,3 @@\n line 80\n-line 81\n+line 81 cleaned\n line 82',
                  },
                ]
              : [],
        },
      ],
    })

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('label,done,"real 0, noise 10, excluded 0"')
  })

  it('excludes a comment on the final head commit when no other fix evidence exists', async () => {
    const { sandbox, gitHub } = setupReplay({
      config: { target_items: 100 },
      specs: [
        {
          name: 'acme/widgets',
          bots: { 'coderabbitai[bot]': 10 },
          comment: ({ pr }) => (pr <= 3 ? { original_commit_id: `h-acme-widgets-${pr}` } : {}),
        },
      ],
    })

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('label,done,"real 3, noise 4, excluded 3"')
    expect(result.stdout).toContain('no commits after comment,3')
  })
})

describe('labelling-rules version (spec 10.5)', () => {
  it('records the labelling-rules version in the manifest label stage', async () => {
    const { sandbox, gitHub } = setupReplay()

    await runReplay(['public-v1', '--stage', 'build'], sandbox, gitHub)
    await runReplay(['public-v1', '--stage', 'label'], sandbox, gitHub)

    const manifest = JSON.parse(readFileSync(replayPath(sandbox, 'manifest.json'), 'utf8')) as {
      stages: { label?: { label_rules?: string } }
    }
    expect(manifest.stages.label?.label_rules).toBe('label-rules-v2')
  })

  it('refuses to relabel or re-check a replay labelled under different rules', async () => {
    const { sandbox, gitHub } = setupReplay()
    await runReplay(['public-v1', '--stage', 'build'], sandbox, gitHub)
    await runReplay(['public-v1', '--stage', 'label'], sandbox, gitHub)
    // Rewrite the manifest as v1 code left it: no label_rules field.
    const manifestPath = replayPath(sandbox, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      stages: { label?: { label_rules?: string } }
    }
    delete manifest.stages.label?.label_rules
    const { writeFileSync } = await import('node:fs')
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const relabel = await runReplay(['public-v1', '--stage', 'label'], sandbox, gitHub)
    expect(relabel.exitCode).toBe(2)
    expect(relabel.stdout).toContain('label-rules-v1')
    expect(relabel.stdout).toContain('new replay name')

    const recheck = await runReplay(['public-v1', '--stage', 'check'], sandbox, gitHub)
    expect(recheck.exitCode).toBe(2)
    expect(recheck.stdout).toContain('label-rules-v1')
  })
})

describe('comment eligibility under label-rules-v2 (spec 10.4)', () => {
  it('skips pure revert pull requests', async () => {
    const { sandbox, gitHub } = setupReplay({
      config: { target_items: 100 },
      specs: [
        {
          name: 'acme/widgets',
          bots: { 'coderabbitai[bot]': 10 },
          title: (pr) =>
            pr === 1
              ? 'Revert "Improve widget handling part 1"'
              : `Improve widget handling part ${pr}`,
        },
      ],
    })

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('build,done,"1 repos, 1 bots, 9 comments from 9 PRs"')
  })

  it('skips comments about the pull request title and summary', async () => {
    const { sandbox, gitHub } = setupReplay({
      config: { target_items: 100 },
      specs: [
        {
          name: 'acme/widgets',
          bots: { 'coderabbitai[bot]': 10 },
          body: ({ pr }) =>
            pr === 1
              ? 'The Pull Request Title and Summary do not fully adhere to the repository style guide.\n\n**Suggested PR Title:**\n\n```markdown\n[Widget] Improve handling\n```'
              : 'Possible null dereference.',
        },
      ],
    })

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('build,done,"1 repos, 1 bots, 9 comments from 9 PRs"')
  })
})

// A replay spans several repositories (R9) whose pull request numbers overlap, so the
// per-PR evidence read during `build` must not be shared across repositories.
describe('per-PR evidence across repositories', () => {
  it('reads each repository own thread resolution when PR numbers overlap', async () => {
    const { sandbox, gitHub } = setupReplay({
      config: {
        target_items: 100,
        bots: ['cursor[bot]'],
        repositories: ['acme/widgets', 'beta/gadgets'],
      },
      specs: [
        { name: 'acme/widgets', bots: { 'cursor[bot]': 10 }, changed: () => false },
        {
          name: 'beta/gadgets',
          bots: { 'cursor[bot]': 10 },
          changed: () => false,
          resolved: ({ pr }) => pr <= 3,
          resolvedBy: ({ pr }) => (pr <= 3 ? 'cursor[bot]' : undefined),
        },
      ],
    })

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('label,done,"real 3, noise 17, excluded 0"')
  })

  it('reads each repository own commits when PR numbers overlap', async () => {
    const { sandbox, gitHub } = setupReplay({
      config: {
        target_items: 100,
        repositories: ['acme/widgets', 'beta/gadgets'],
      },
      specs: [
        { name: 'acme/widgets', bots: { 'coderabbitai[bot]': 10 }, changed: () => false },
        {
          name: 'beta/gadgets',
          bots: { 'coderabbitai[bot]': 10 },
          changed: () => false,
          resolved: () => true,
          commits: (pr) => [
            { sha: `f-beta-gadgets-${pr}`, subject: 'Start the change' },
            { sha: sha(pr), subject: 'Guard the null dereference' },
          ],
          replies: ({ pr }) => [
            {
              login: 'claude[bot]',
              type: 'Bot',
              body: `Fixed in ${sha(pr)}: the dereference is guarded now.`,
            },
          ],
        },
      ],
    })

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('label,done,"real 10, noise 10, excluded 0"')
  })

  it('reads each repository own base-branch follow-ups when PR numbers overlap', async () => {
    const { sandbox, gitHub } = setupReplay({
      config: {
        target_items: 100,
        repositories: ['acme/widgets', 'beta/gadgets'],
      },
      specs: [
        { name: 'acme/widgets', bots: { 'coderabbitai[bot]': 10 }, changed: () => false },
        {
          name: 'beta/gadgets',
          bots: { 'coderabbitai[bot]': 10 },
          changed: () => false,
          followUps: ({ pr }) =>
            pr <= 3 ? [{ sha: sha(pr), subject: 'Fix the null dereference upstream' }] : [],
        },
      ],
    })

    const result = await runReplay(['public-v1'], sandbox, gitHub)

    expect(result.stdout).toContain('label,done,"real 3, noise 17, excluded 0"')
  })
})
