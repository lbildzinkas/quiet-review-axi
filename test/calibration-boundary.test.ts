import { readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const LIBRARY = join(import.meta.dirname, '..', 'src', 'calibration')

// The calibration kit is meant to be published on its own later, so it may import only its
// own modules: nothing from Quiet Review, GitHub, the model providers or npm packages.
describe('calibration library boundary', () => {
  it('imports only its own modules', () => {
    const files = readdirSync(LIBRARY)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(LIBRARY, name))
    expect(files.length).toBeGreaterThan(0)

    const outside = files.flatMap((file) =>
      moduleSpecifiers(file)
        .filter((specifier) => !resolvesInside(file, specifier))
        .map((specifier) => `${relative(LIBRARY, file)}: ${specifier}`),
    )

    expect(outside).toEqual([])
  })
})

// Every module specifier a file names in an import or export declaration, static or dynamic.
function moduleSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []
  source.forEachChild(function walk(node) {
    const specifier = declarationSpecifier(node) ?? dynamicImportSpecifier(node)
    if (specifier !== undefined) specifiers.push(specifier)
    node.forEachChild(walk)
  })
  return specifiers
}

function declarationSpecifier(node: ts.Node): string | undefined {
  if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) return undefined
  const specifier = node.moduleSpecifier
  return specifier !== undefined && ts.isStringLiteral(specifier) ? specifier.text : undefined
}

function dynamicImportSpecifier(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword)
    return undefined
  const [argument] = node.arguments
  return argument !== undefined && ts.isStringLiteral(argument) ? argument.text : undefined
}

function resolvesInside(file: string, specifier: string): boolean {
  if (!specifier.startsWith('./')) return false
  const location = relative(LIBRARY, resolve(dirname(file), specifier))
  return !location.startsWith('..') && !isAbsolute(location)
}
