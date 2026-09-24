import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const LIBRARY = join(import.meta.dirname, '..', 'src', 'calibration')

// The calibration kit is meant to be published on its own later, so it may import only its
// own modules: nothing from Quiet Review, GitHub, the model providers or npm packages.
describe('calibration library boundary', () => {
  it('imports only its own modules', () => {
    const imports = readdirSync(LIBRARY)
      .filter((name) => name.endsWith('.ts'))
      .flatMap((name) =>
        [...readFileSync(join(LIBRARY, name), 'utf8').matchAll(/from '([^']+)'/g)].map(
          (match) => `${name}: ${match[1]}`,
        ),
      )

    expect(imports.length).toBeGreaterThan(0)
    expect(imports.filter((line) => !/: \.\/[\w-]+\.js$/.test(line))).toEqual([])
  })
})
